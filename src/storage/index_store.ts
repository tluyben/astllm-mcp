import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { CodeSymbol } from '../parser/symbols.js';

const INDEX_VERSION = 2;

export interface CodeIndex {
  version: number;
  repo: string;
  owner: string;
  indexed_at: string;
  symbols: CodeSymbol[];
  file_hashes: Record<string, string>;
  git_head?: string;
}

interface RepoEntry {
  repo: string;       // "owner/name"
  indexed_at: string;
  symbol_count: number;
  file_count: number;
}

export class IndexStore {
  private basePath: string;

  constructor(basePath?: string | null) {
    this.basePath = basePath ??
      process.env['CODE_INDEX_PATH'] ??
      path.join(os.homedir(), '.code-index');
  }

  private repoDir(owner: string, name: string): string {
    return path.join(this.basePath, owner, name);
  }

  private indexFile(owner: string, name: string): string {
    return path.join(this.repoDir(owner, name), 'index.json');
  }

  contentDir(owner: string, name: string): string {
    return path.join(this.repoDir(owner, name), 'files');
  }

  // ─── Save / load index ───────────────────────────────────────────────────

  saveIndex(owner: string, name: string, index: CodeIndex): void {
    const dir = this.repoDir(owner, name);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.indexFile(owner, name);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index), 'utf8');
    fs.renameSync(tmp, file);
  }

  loadIndex(owner: string, name: string): CodeIndex | null {
    const file = this.indexFile(owner, name);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw) as CodeIndex;
      if (data.version !== INDEX_VERSION) return null;
      return data;
    } catch {
      return null;
    }
  }

  deleteIndex(owner: string, name: string): void {
    const dir = this.repoDir(owner, name);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ─── Raw file storage ────────────────────────────────────────────────────

  saveFile(owner: string, name: string, filePath: string, content: string): void {
    const dest = path.join(this.contentDir(owner, name), filePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }

  /** O(1) symbol source retrieval via byte-offset seek */
  getSymbolContent(owner: string, name: string, symbolId: string): string | null {
    const index = this.loadIndex(owner, name);
    if (!index) return null;
    const sym = index.symbols.find(s => s.id === symbolId);
    if (!sym) return null;
    const filePath = path.join(this.contentDir(owner, name), sym.file);
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(sym.byte_length);
      fs.readSync(fd, buf, 0, sym.byte_length, sym.byte_offset);
      fs.closeSync(fd);
      return buf.toString('utf8');
    } catch {
      return null;
    }
  }

  // ─── Symbol lookup ───────────────────────────────────────────────────────

  getSymbol(index: CodeIndex, symbolId: string): CodeSymbol | null {
    return index.symbols.find(s => s.id === symbolId) ?? null;
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  searchSymbols(
    index: CodeIndex,
    query: string,
    kind?: string,
    filePattern?: string,
    language?: string,
    limit = 50,
  ): CodeSymbol[] {
    const q = query.toLowerCase();
    let results = index.symbols;

    if (kind) results = results.filter(s => s.kind === kind);
    if (language) results = results.filter(s => s.language === language);
    if (filePattern) {
      const pat = filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      const re = new RegExp(pat);
      results = results.filter(s => re.test(s.file));
    }

    const scored = results.map(sym => ({ sym, score: scoreSymbol(sym, q) }));
    scored.sort((a, b) => b.score - a.score || a.sym.name.localeCompare(b.sym.name));

    return scored
      .filter(x => x.score > 0)
      .slice(0, limit)
      .map(x => x.sym);
  }

  // ─── Change detection ────────────────────────────────────────────────────

  detectChanges(
    index: CodeIndex,
    newHashes: Record<string, string>,
  ): { changed: string[]; added: string[]; deleted: string[] } {
    const changed: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];

    for (const [file, hash] of Object.entries(newHashes)) {
      if (file in index.file_hashes) {
        if (index.file_hashes[file] !== hash) changed.push(file);
      } else {
        added.push(file);
      }
    }

    for (const file of Object.keys(index.file_hashes)) {
      if (!(file in newHashes)) deleted.push(file);
    }

    return { changed, added, deleted };
  }

  /** Patch index in-place with new symbols for changed files */
  incrementalSave(
    owner: string,
    name: string,
    changedFiles: string[],
    deletedFiles: string[],
    newSymbols: CodeSymbol[],
    newHashes: Record<string, string>,
  ): CodeIndex | null {
    const index = this.loadIndex(owner, name);
    if (!index) return null;

    const removeFiles = new Set([...changedFiles, ...deletedFiles]);
    index.symbols = index.symbols.filter(s => !removeFiles.has(s.file));

    for (const sym of newSymbols) {
      if (changedFiles.includes(sym.file)) {
        index.symbols.push(sym);
      }
    }

    for (const [f, h] of Object.entries(newHashes)) {
      index.file_hashes[f] = h;
    }
    for (const f of deletedFiles) {
      delete index.file_hashes[f];
    }
    index.indexed_at = new Date().toISOString();

    this.saveIndex(owner, name, index);
    return index;
  }

  // ─── List repos ──────────────────────────────────────────────────────────

  listRepos(): RepoEntry[] {
    const results: RepoEntry[] = [];
    try {
      const owners = fs.readdirSync(this.basePath, { withFileTypes: true });
      for (const ownerEntry of owners) {
        if (!ownerEntry.isDirectory() || ownerEntry.name.startsWith('_')) continue;
        const ownerPath = path.join(this.basePath, ownerEntry.name);
        const repos = fs.readdirSync(ownerPath, { withFileTypes: true });
        for (const repoEntry of repos) {
          if (!repoEntry.isDirectory()) continue;
          const indexFile = path.join(ownerPath, repoEntry.name, 'index.json');
          if (!fs.existsSync(indexFile)) continue;
          try {
            const raw = fs.readFileSync(indexFile, 'utf8');
            const data = JSON.parse(raw) as CodeIndex;
            results.push({
              repo: `${ownerEntry.name}/${repoEntry.name}`,
              indexed_at: data.indexed_at,
              symbol_count: data.symbols.length,
              file_count: Object.keys(data.file_hashes).length,
            });
          } catch {
            // Skip corrupt indexes
          }
        }
      }
    } catch {
      // basePath doesn't exist yet
    }
    return results;
  }
}

function scoreSymbol(sym: CodeSymbol, q: string): number {
  const name = sym.name.toLowerCase();
  const qname = sym.qualified_name.toLowerCase();
  const sig = sym.signature.toLowerCase();

  if (name === q) return 20;
  if (name.startsWith(q)) return 15;
  if (name.includes(q)) return 10;
  if (qname.includes(q)) return 8;
  if (sig.includes(q)) return 6;
  if (sym.summary.toLowerCase().includes(q)) return 5;
  if (sym.keywords.some(k => k.toLowerCase().includes(q))) return 3;
  if (sym.docstring.toLowerCase().includes(q)) return 1;
  return 0;
}

export function hashFileContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}
