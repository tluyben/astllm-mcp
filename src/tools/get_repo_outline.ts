import fs from 'fs';
import path from 'path';
import { IndexStore } from '../storage/index_store.js';
import { resolveRepo, makeMeta } from './_utils.js';
import { estimateSavings, recordSavings, costAvoided } from '../storage/token_tracker.js';

export function getRepoOutline(
  repo: string,
  storagePath?: string | null,
): Record<string, unknown> {
  const start = performance.now();
  const store = new IndexStore(storagePath);

  try {
    const [owner, name] = resolveRepo(repo, store);
    const index = store.loadIndex(owner, name);
    if (!index) return { error: `Repository not indexed: ${owner}/${name}` };

    // Language breakdown
    const langs: Record<string, number> = {};
    const kindCounts: Record<string, number> = {};
    const dirCounts: Record<string, number> = {};

    for (const sym of index.symbols) {
      langs[sym.language] = (langs[sym.language] ?? 0) + 1;
      kindCounts[sym.kind] = (kindCounts[sym.kind] ?? 0) + 1;
    }

    for (const file of Object.keys(index.file_hashes)) {
      const dir = file.includes('/') ? file.split('/')[0] : '.';
      dirCounts[dir] = (dirCounts[dir] ?? 0) + 1;
    }

    const topDirs = Object.entries(dirCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([dir, count]) => ({ dir, file_count: count }));

    // Token savings
    let rawBytes = 0;
    const contentDir = store.contentDir(owner, name);
    for (const file of Object.keys(index.file_hashes)) {
      try { rawBytes += fs.statSync(path.join(contentDir, file)).size; } catch { /* */ }
    }
    const response = { repo: `${owner}/${name}`, languages: langs, kinds: kindCounts };
    const responseBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
    const tokensSaved = estimateSavings(rawBytes, responseBytes);
    const totalSaved = recordSavings(tokensSaved);
    const elapsed = performance.now() - start;

    return {
      repo: `${owner}/${name}`,
      indexed_at: index.indexed_at,
      file_count: Object.keys(index.file_hashes).length,
      symbol_count: index.symbols.length,
      languages: langs,
      symbol_kinds: kindCounts,
      top_directories: topDirs,
      git_head: index.git_head ?? null,
      _meta: makeMeta(elapsed, { tokens_saved: tokensSaved, total_tokens_saved: totalSaved, ...costAvoided(tokensSaved, totalSaved) }),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
