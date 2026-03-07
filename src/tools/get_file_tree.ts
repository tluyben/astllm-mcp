import path from 'path';
import fs from 'fs';
import { IndexStore, CodeIndex } from '../storage/index_store.js';
import { resolveRepo, makeMeta } from './_utils.js';
import { estimateSavings, recordSavings, costAvoided } from '../storage/token_tracker.js';

interface TreeNode {
  name: string;
  type: 'file' | 'dir';
  language?: string;
  symbol_count?: number;
  summary?: string;
  children?: TreeNode[];
}

function buildTree(
  files: string[],
  languages: Record<string, string>,
  symbolCounts: Record<string, number>,
  pathPrefix: string,
): TreeNode[] {
  const dirs: Record<string, string[]> = {};
  const rootFiles: string[] = [];

  for (const file of files) {
    if (!file.startsWith(pathPrefix)) continue;
    const rel = pathPrefix ? file.slice(pathPrefix.length).replace(/^\//, '') : file;
    const parts = rel.split('/');
    if (parts.length === 1) {
      rootFiles.push(file);
    } else {
      const dir = parts[0];
      if (!dirs[dir]) dirs[dir] = [];
      dirs[dir].push(file);
    }
  }

  const nodes: TreeNode[] = [];

  for (const [dir, children] of Object.entries(dirs).sort(([a], [b]) => a.localeCompare(b))) {
    const childPrefix = pathPrefix ? `${pathPrefix}/${dir}` : dir;
    nodes.push({
      name: dir,
      type: 'dir',
      children: buildTree(children, languages, symbolCounts, childPrefix),
    });
  }

  for (const file of rootFiles.sort()) {
    const name = path.basename(file);
    nodes.push({
      name,
      type: 'file',
      language: languages[file],
      symbol_count: symbolCounts[file] ?? 0,
    });
  }

  return nodes;
}

export function getFileTree(
  repo: string,
  pathPrefix = '',
  includeSummaries = false,
  storagePath?: string | null,
): Record<string, unknown> {
  const start = performance.now();
  const store = new IndexStore(storagePath);

  try {
    const [owner, name] = resolveRepo(repo, store);
    const index = store.loadIndex(owner, name);
    if (!index) {
      return { error: `Repository not indexed: ${owner}/${name}` };
    }

    // Build per-file metadata
    const languages: Record<string, string> = {};
    const symbolCounts: Record<string, number> = {};
    for (const sym of index.symbols) {
      languages[sym.file] = sym.language;
      symbolCounts[sym.file] = (symbolCounts[sym.file] ?? 0) + 1;
    }

    const allFiles = Object.keys(index.file_hashes);
    const normalizedPrefix = pathPrefix.replace(/^\/|\/$/g, '');
    const tree = buildTree(allFiles, languages, symbolCounts, normalizedPrefix);

    // Token savings vs loading all raw files
    let rawBytes = 0;
    const contentDir = store.contentDir(owner, name);
    for (const file of allFiles) {
      try {
        rawBytes += fs.statSync(path.join(contentDir, file)).size;
      } catch { /* */ }
    }
    const responseBytes = Buffer.byteLength(JSON.stringify(tree), 'utf8');
    const tokensSaved = estimateSavings(rawBytes, responseBytes);
    const totalSaved = recordSavings(tokensSaved);
    const elapsed = performance.now() - start;

    return {
      repo: `${owner}/${name}`,
      path_prefix: normalizedPrefix || '/',
      file_count: allFiles.length,
      tree,
      _meta: makeMeta(elapsed, { tokens_saved: tokensSaved, total_tokens_saved: totalSaved, ...costAvoided(tokensSaved, totalSaved) }),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
