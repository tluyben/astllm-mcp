import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { IndexStore, CodeIndex, hashFileContent } from '../storage/index_store.js';
import { parseFile, getLanguageForFile } from '../parser/extractor.js';
import { CodeSymbol } from '../parser/symbols.js';
import { summarizeSymbols } from '../summarizer/batch_summarize.js';
import { shouldExcludeFile, getMaxIndexFiles, getMaxFileSizeBytes } from '../security.js';
import { makeMeta } from './_utils.js';

// Dynamic require for CJS 'ignore' package
import { createRequire } from 'module';
const _requireFolder = createRequire(import.meta.url);
let ignoreLib: typeof import('ignore').default | null = null;
try {
  ignoreLib = _requireFolder('ignore');
} catch { /* ignore not installed — gitignore support disabled */ }

const SKIP_PATTERNS = [
  'node_modules', 'vendor', '.git', 'dist', 'build', '__pycache__',
  '.cache', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  'target', 'out', '.gradle', '.idea', '.vscode', '.DS_Store',
  'coverage', '.nyc_output', '.next', '.nuxt', 'venv', '.venv',
  'env', '.env', 'eggs', '*.egg-info',
];

const SKIP_FILE_PATTERNS = [
  '*.min.js', '*.min.css', 'package-lock.json', 'yarn.lock',
  'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock',
  '*.lock', '*.snap',
];

const PRIORITY_DIRS = ['src', 'lib', 'pkg', 'cmd', 'app', 'core', 'api', 'internal'];

function shouldSkipEntry(name: string): boolean {
  if (SKIP_PATTERNS.includes(name)) return true;
  if (name.startsWith('.') && name !== '.github') return true;
  return false;
}

function matchesFileSkip(name: string): boolean {
  for (const pat of SKIP_FILE_PATTERNS) {
    const re = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    if (new RegExp(`^${re}$`).test(name)) return true;
  }
  return false;
}

function loadGitignore(rootDir: string): ((filePath: string) => boolean) | null {
  if (!ignoreLib) return null;
  const gitignorePath = path.join(rootDir, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    const ig = ignoreLib().add(content);
    return (filePath: string) => {
      const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
      return ig.ignores(rel);
    };
  } catch {
    return null;
  }
}

interface DiscoveredFile {
  absPath: string;
  relPath: string;
  language: string;
}

interface DiscoverResult {
  files: DiscoveredFile[];
  warnings: string[];
  skip_counts: Record<string, number>;
}

function discoverLocalFiles(rootDir: string, extraIgnore: string[] = [], followSymlinks = false): DiscoverResult {
  const maxFiles = getMaxIndexFiles();
  const maxSize = getMaxFileSizeBytes();
  const gitignoreCheck = loadGitignore(rootDir);
  const warnings: string[] = [];
  const skip_counts: Record<string, number> = {
    no_language: 0, excluded: 0, gitignore: 0, skip_pattern: 0,
  };
  const files: DiscoveredFile[] = [];

  // Extra ignore rules
  const extraIg = ignoreLib && extraIgnore.length > 0 ? ignoreLib().add(extraIgnore) : null;

  function walk(dir: string): void {
    if (files.length >= maxFiles) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs).replace(/\\/g, '/');

      // Skip hidden dirs and known skip patterns
      if (shouldSkipEntry(entry.name)) { skip_counts['skip_pattern']++; continue; }

      if (entry.isSymbolicLink()) {
        if (!followSymlinks) { skip_counts['excluded']++; continue; }
        try { fs.statSync(abs); } catch { skip_counts['excluded']++; continue; }
      }

      if (entry.isDirectory() || (entry.isSymbolicLink() && followSymlinks)) {
        try {
          if (!entry.isSymbolicLink() || followSymlinks) walk(abs);
        } catch { /* */ }
        continue;
      }

      if (!entry.isFile()) continue;

      // Gitignore check
      if (gitignoreCheck?.(abs)) { skip_counts['gitignore']++; continue; }
      if (extraIg?.ignores(rel)) { skip_counts['gitignore']++; continue; }

      // Skip file patterns
      if (matchesFileSkip(entry.name)) { skip_counts['skip_pattern']++; continue; }

      // Language check
      const lang = getLanguageForFile(entry.name);
      if (!lang) { skip_counts['no_language']++; continue; }

      // Security check
      const reason = shouldExcludeFile(abs, rootDir, maxSize);
      if (reason) { skip_counts['excluded']++; continue; }

      files.push({ absPath: abs, relPath: rel, language: lang });
    }
  }

  // Walk priority dirs first to respect file limit better
  const rootEntries = fs.readdirSync(rootDir, { withFileTypes: true });
  const prioritized = rootEntries.filter(e => PRIORITY_DIRS.includes(e.name) && e.isDirectory());
  const rest = rootEntries.filter(e => !PRIORITY_DIRS.includes(e.name));

  for (const entry of [...prioritized, ...rest]) {
    if (files.length >= maxFiles) break;
    const abs = path.join(rootDir, entry.name);
    if (shouldSkipEntry(entry.name)) continue;
    if (entry.isDirectory()) {
      walk(abs);
    } else if (entry.isFile()) {
      const rel = entry.name;
      const lang = getLanguageForFile(entry.name);
      if (!lang) continue;
      const reason = shouldExcludeFile(abs, rootDir, maxSize);
      if (reason) continue;
      if (matchesFileSkip(entry.name)) continue;
      if (gitignoreCheck?.(abs)) continue;
      files.push({ absPath: abs, relPath: rel, language: lang });
    }
  }

  if (files.length >= maxFiles) {
    warnings.push(`Hit file limit of ${maxFiles}. Some files were skipped.`);
  }

  return { files, warnings, skip_counts };
}

export async function indexFolder(
  folderPath: string,
  generateSummaries = false,
  extraIgnorePatterns: string[] = [],
  followSymlinks = false,
  incremental = true,
  storagePath?: string | null,
): Promise<Record<string, unknown>> {
  const start = performance.now();
  const store = new IndexStore(storagePath);

  // Normalize and validate path
  const rootDir = path.resolve(folderPath);
  if (!fs.existsSync(rootDir)) {
    return { error: `Folder not found: ${rootDir}` };
  }
  const stat = fs.statSync(rootDir);
  if (!stat.isDirectory()) {
    return { error: `Not a directory: ${rootDir}` };
  }

  // Derive owner/name from path
  const parts = rootDir.replace(/\\/g, '/').split('/').filter(Boolean);
  const repoName = parts[parts.length - 1] ?? 'unknown';
  const owner = 'local';

  // Discover files
  const { files, warnings, skip_counts } = discoverLocalFiles(rootDir, extraIgnorePatterns, followSymlinks);

  if (files.length === 0) {
    return { error: 'No indexable source files found', skip_counts };
  }

  // Compute file hashes
  const newHashes: Record<string, string> = {};
  for (const f of files) {
    try {
      const content = fs.readFileSync(f.absPath, 'utf8');
      newHashes[f.relPath] = hashFileContent(content);
    } catch { /* */ }
  }

  // Check for incremental update
  let existing = incremental ? store.loadIndex(owner, repoName) : null;
  // If a prior index has files but 0 symbols, it was a failed run — force full re-parse
  if (existing && existing.symbols.length === 0 && Object.keys(existing.file_hashes).length > 0) {
    existing = null;
  }
  const isIncremental = !!existing;
  let changedFiles: string[] = [];
  let addedFiles: string[] = [];
  let deletedFiles: string[] = [];
  let filesToProcess: DiscoveredFile[] = files;

  if (existing) {
    const changes = store.detectChanges(existing, newHashes);
    changedFiles = changes.changed;
    addedFiles = changes.added;
    deletedFiles = changes.deleted;
    const toReindex = new Set([...changedFiles, ...addedFiles]);
    filesToProcess = files.filter(f => toReindex.has(f.relPath));

    if (filesToProcess.length === 0 && deletedFiles.length === 0) {
      return {
        success: true,
        repo: `${owner}/${repoName}`,
        incremental: true,
        message: 'No changes detected, index is up to date.',
        symbol_count: existing.symbols.length,
        file_count: Object.keys(existing.file_hashes).length,
        _meta: makeMeta(performance.now() - start),
      };
    }
  }

  // Parse files
  const newSymbols: CodeSymbol[] = [];
  const langCounts: Record<string, number> = {};
  const parseWarnings: string[] = [];

  for (const f of filesToProcess) {
    let content: string;
    try {
      content = fs.readFileSync(f.absPath, 'utf8');
    } catch {
      continue;
    }

    // Store raw file for byte-offset retrieval
    store.saveFile(owner, repoName, f.relPath, content);

    const syms = parseFile(content, f.relPath, f.language);
    newSymbols.push(...syms);
    langCounts[f.language] = (langCounts[f.language] ?? 0) + 1;
  }

  // Generate AI summaries if requested
  if (generateSummaries && newSymbols.length > 0) {
    try {
      await summarizeSymbols(newSymbols);
    } catch (e) {
      parseWarnings.push(`Summarization failed: ${e}`);
    }
  }

  let finalIndex: CodeIndex;

  if (isIncremental && existing) {
    const updated = store.incrementalSave(owner, repoName, changedFiles, deletedFiles, newSymbols, newHashes);
    finalIndex = updated ?? existing;
  } else {
    // Save raw files for files already in store (non-incremental initial)
    for (const f of files) {
      if (filesToProcess.some(fp => fp.relPath === f.relPath)) continue; // already saved
      // For non-incremental, save all files
    }
    finalIndex = {
      version: 2,
      repo: repoName,
      owner,
      indexed_at: new Date().toISOString(),
      symbols: newSymbols,
      file_hashes: newHashes,
    };

    // Also store raw files not yet saved
    for (const f of files) {
      if (!filesToProcess.some(fp => fp.relPath === f.relPath)) {
        try {
          const content = fs.readFileSync(f.absPath, 'utf8');
          store.saveFile(owner, repoName, f.relPath, content);
        } catch { /* */ }
      }
    }

    store.saveIndex(owner, repoName, finalIndex);
  }

  const elapsed = performance.now() - start;

  return {
    success: true,
    repo: `${owner}/${repoName}`,
    incremental: isIncremental,
    file_count: Object.keys(finalIndex.file_hashes).length,
    symbol_count: finalIndex.symbols.length,
    files_processed: filesToProcess.length,
    languages: langCounts,
    skip_counts,
    warnings: [...warnings, ...parseWarnings],
    _meta: makeMeta(elapsed),
  };
}
