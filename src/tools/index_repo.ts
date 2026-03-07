import https from 'https';
import { IndexStore, CodeIndex, hashFileContent } from '../storage/index_store.js';
import { parseFile, getLanguageForFile } from '../parser/extractor.js';
import { CodeSymbol } from '../parser/symbols.js';
import { summarizeSymbols } from '../summarizer/batch_summarize.js';
import { isSecretFile, isBinaryExtension, getMaxIndexFiles, getMaxFileSizeBytes } from '../security.js';
import { makeMeta } from './_utils.js';

const SKIP_PATTERNS = [
  'node_modules/', 'vendor/', '.git/', 'dist/', 'build/', '__pycache__/',
  '.cache/', 'target/', 'coverage/', '.nyc_output/', '.next/', '.nuxt/',
];

const SKIP_FILE_PATTERNS = [
  /\.min\.js$/, /\.min\.css$/, /package-lock\.json$/, /yarn\.lock$/,
  /pnpm-lock\.yaml$/, /Cargo\.lock$/, /poetry\.lock$/, /Pipfile\.lock$/,
  /\.snap$/, /\.lock$/,
];

const PRIORITY_PATH_PREFIXES = ['src/', 'lib/', 'pkg/', 'cmd/', 'app/', 'core/', 'api/', 'internal/'];

// ─── GitHub API helpers ───────────────────────────────────────────────────────

function githubApiRequest(urlPath: string, token?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: urlPath,
      method: 'GET',
      headers: {
        'User-Agent': 'astllm-mcp/1.0',
        'Accept': 'application/vnd.github.v3+json',
        ...(token ? { 'Authorization': `token ${token}` } : {}),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`GitHub API ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('GitHub API timeout')); });
    req.end();
  });
}

function parseGithubUrl(urlOrSlug: string): [string, string] {
  // Accept: https://github.com/owner/repo, github.com/owner/repo, owner/repo
  const cleaned = urlOrSlug
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const parts = cleaned.split('/');
  if (parts.length < 2) throw new Error(`Invalid GitHub repo: ${urlOrSlug}`);
  return [parts[0], parts[1]];
}

interface GithubFile {
  path: string;
  sha: string;
  size: number;
  url: string;
  type: string;
}

async function fetchRepoTree(owner: string, repo: string, token?: string): Promise<GithubFile[]> {
  // Get default branch first
  const repoData = JSON.parse(await githubApiRequest(`/repos/${owner}/${repo}`, token)) as { default_branch: string };
  const branch = repoData.default_branch ?? 'main';

  // Get the full tree recursively
  const treeData = JSON.parse(
    await githubApiRequest(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, token)
  ) as { tree: GithubFile[]; truncated?: boolean };

  return treeData.tree;
}

function shouldSkipPath(filePath: string): boolean {
  for (const pat of SKIP_PATTERNS) {
    if (filePath.includes(pat)) return true;
  }
  for (const re of SKIP_FILE_PATTERNS) {
    if (re.test(filePath)) return true;
  }
  return false;
}

function discoverSourceFiles(
  tree: GithubFile[],
  maxFiles: number,
  maxSize: number,
): GithubFile[] {
  const blobs = tree.filter(f => f.type === 'blob');

  const valid = blobs.filter(f => {
    if (shouldSkipPath(f.path)) return false;
    if (isSecretFile(f.path)) return false;
    if (isBinaryExtension(f.path)) return false;
    if (!getLanguageForFile(f.path)) return false;
    if (f.size > maxSize) return false;
    return true;
  });

  // Prioritize certain directories
  const priority = valid.filter(f => PRIORITY_PATH_PREFIXES.some(p => f.path.startsWith(p)));
  const rest = valid.filter(f => !PRIORITY_PATH_PREFIXES.some(p => f.path.startsWith(p)));

  return [...priority, ...rest].slice(0, maxFiles);
}

async function fetchFileContent(owner: string, repo: string, filePath: string, token?: string): Promise<string | null> {
  try {
    const data = JSON.parse(
      await githubApiRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, token)
    ) as { content?: string; encoding?: string };

    if (data.encoding === 'base64' && data.content) {
      return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
    }
    return null;
  } catch {
    return null;
  }
}

// Simple semaphore for concurrency limiting
class Semaphore {
  private count: number;
  private waiters: Array<() => void> = [];

  constructor(n: number) { this.count = n; }

  async acquire(): Promise<void> {
    if (this.count > 0) { this.count--; return; }
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }

  release(): void {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next();
    } else {
      this.count++;
    }
  }
}

async function fetchAllFiles(
  owner: string,
  repo: string,
  files: GithubFile[],
  token?: string,
  concurrency = 10,
): Promise<Array<{ path: string; content: string }>> {
  const sem = new Semaphore(concurrency);
  const results = await Promise.all(
    files.map(async f => {
      await sem.acquire();
      try {
        const content = await fetchFileContent(owner, repo, f.path, token);
        return content ? { path: f.path, content } : null;
      } finally {
        sem.release();
      }
    })
  );
  return results.filter((r): r is { path: string; content: string } => r !== null);
}

// ─── Main tool ────────────────────────────────────────────────────────────────

export async function indexRepo(
  repoUrl: string,
  generateSummaries = false,
  incremental = true,
  storagePath?: string | null,
): Promise<Record<string, unknown>> {
  const start = performance.now();
  const store = new IndexStore(storagePath);
  const token = process.env['GITHUB_TOKEN'];

  let owner: string;
  let repoName: string;

  try {
    [owner, repoName] = parseGithubUrl(repoUrl);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const maxFiles = getMaxIndexFiles();
    const maxSize = getMaxFileSizeBytes();

    // Fetch repo tree
    let tree: GithubFile[];
    try {
      tree = await fetchRepoTree(owner, repoName, token);
    } catch (err) {
      return { error: `Failed to fetch repo tree: ${err instanceof Error ? err.message : String(err)}` };
    }

    const sourceFiles = discoverSourceFiles(tree, maxFiles, maxSize);
    if (sourceFiles.length === 0) {
      return { error: 'No indexable source files found in repository' };
    }

    // Compute hashes from sizes (we'll update after fetching content)
    // For incremental, check what's changed by comparing git SHAs
    const existing = incremental ? store.loadIndex(owner, repoName) : null;

    // Use git SHA as hash for GitHub files (no re-download if SHA unchanged)
    const newHashes: Record<string, string> = {};
    for (const f of sourceFiles) {
      newHashes[f.path] = f.sha;
    }

    let filesToFetch = sourceFiles;
    const isIncremental = !!existing;

    if (existing) {
      const changes = store.detectChanges(existing, newHashes);
      const toReindex = new Set([...changes.changed, ...changes.added]);
      filesToFetch = sourceFiles.filter(f => toReindex.has(f.path));

      if (filesToFetch.length === 0 && changes.deleted.length === 0) {
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

    // Fetch file contents
    const fetched = await fetchAllFiles(owner, repoName, filesToFetch, token);

    // Store raw files and parse
    const newSymbols: CodeSymbol[] = [];
    const langCounts: Record<string, number> = {};
    const warnings: string[] = [];

    for (const { path: filePath, content } of fetched) {
      const lang = getLanguageForFile(filePath);
      if (!lang) continue;

      store.saveFile(owner, repoName, filePath, content);
      // Update hash with actual content hash for accuracy
      newHashes[filePath] = hashFileContent(content);

      const syms = parseFile(content, filePath, lang);
      newSymbols.push(...syms);
      langCounts[lang] = (langCounts[lang] ?? 0) + 1;
    }

    // Generate summaries
    if (generateSummaries && newSymbols.length > 0) {
      try {
        await summarizeSymbols(newSymbols);
      } catch (e) {
        warnings.push(`Summarization failed: ${e}`);
      }
    }

    let finalIndex: CodeIndex;

    if (isIncremental && existing) {
      const deletedFiles = Object.entries(existing.file_hashes)
        .filter(([f]) => !newHashes[f])
        .map(([f]) => f);
      const changedFiles = fetched.map(f => f.path);
      const updated = store.incrementalSave(owner, repoName, changedFiles, deletedFiles, newSymbols, newHashes);
      finalIndex = updated ?? existing;
    } else {
      finalIndex = {
        version: 2,
        repo: repoName,
        owner,
        indexed_at: new Date().toISOString(),
        symbols: newSymbols,
        file_hashes: newHashes,
      };
      store.saveIndex(owner, repoName, finalIndex);
    }

    const elapsed = performance.now() - start;

    return {
      success: true,
      repo: `${owner}/${repoName}`,
      incremental: isIncremental,
      file_count: Object.keys(finalIndex.file_hashes).length,
      symbol_count: finalIndex.symbols.length,
      files_processed: fetched.length,
      languages: langCounts,
      warnings,
      _meta: makeMeta(elapsed),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
