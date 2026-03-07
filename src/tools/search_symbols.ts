import { IndexStore } from '../storage/index_store.js';
import { resolveRepo, makeMeta } from './_utils.js';
import { estimateSavings, recordSavings, costAvoided } from '../storage/token_tracker.js';
import fs from 'fs';
import path from 'path';

export function searchSymbols(
  repo: string,
  query: string,
  kind?: string,
  filePattern?: string,
  language?: string,
  limit = 50,
  storagePath?: string | null,
): Record<string, unknown> {
  const start = performance.now();
  const store = new IndexStore(storagePath);
  limit = Math.min(limit, 100);

  try {
    const [owner, name] = resolveRepo(repo, store);
    const index = store.loadIndex(owner, name);
    if (!index) return { error: `Repository not indexed: ${owner}/${name}` };

    const results = store.searchSymbols(index, query, kind, filePattern, language, limit);

    // Token savings: raw index size vs response
    let rawBytes = 0;
    const contentDir = store.contentDir(owner, name);
    for (const file of Object.keys(index.file_hashes)) {
      try { rawBytes += fs.statSync(path.join(contentDir, file)).size; } catch { /* */ }
    }
    const responseBytes = Buffer.byteLength(JSON.stringify(results), 'utf8');
    const tokensSaved = estimateSavings(rawBytes, responseBytes);
    const totalSaved = recordSavings(tokensSaved);
    const elapsed = performance.now() - start;

    return {
      results: results.map(sym => ({
        id: sym.id,
        kind: sym.kind,
        name: sym.name,
        qualified_name: sym.qualified_name,
        file: sym.file,
        line: sym.line,
        end_line: sym.end_line,
        signature: sym.signature,
        language: sym.language,
        docstring: sym.docstring,
        summary: sym.summary,
        decorators: sym.decorators,
      })),
      count: results.length,
      truncated: results.length >= limit,
      total_indexed: index.symbols.length,
      _meta: makeMeta(elapsed, { tokens_saved: tokensSaved, total_tokens_saved: totalSaved, ...costAvoided(tokensSaved, totalSaved) }),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
