import fs from 'fs';
import path from 'path';
import { IndexStore } from '../storage/index_store.js';
import { resolveRepo, makeMeta } from './_utils.js';
import { buildSymbolTree, SymbolNode } from '../parser/hierarchy.js';
import { CodeSymbol } from '../parser/symbols.js';
import { estimateSavings, recordSavings, costAvoided } from '../storage/token_tracker.js';

function nodeToDict(node: SymbolNode): Record<string, unknown> {
  const sym = node.symbol;
  return {
    id: sym.id,
    name: sym.name,
    qualified_name: sym.qualified_name,
    kind: sym.kind,
    signature: sym.signature,
    line: sym.line,
    end_line: sym.end_line,
    docstring: sym.docstring,
    summary: sym.summary,
    decorators: sym.decorators,
    children: node.children.map(nodeToDict),
  };
}

export function getFileOutline(
  repo: string,
  filePath: string,
  storagePath?: string | null,
): Record<string, unknown> {
  const start = performance.now();
  const store = new IndexStore(storagePath);

  try {
    const [owner, name] = resolveRepo(repo, store);
    const index = store.loadIndex(owner, name);
    if (!index) return { error: `Repository not indexed: ${owner}/${name}` };

    const fileSymbols = index.symbols.filter(s => s.file === filePath);
    if (fileSymbols.length === 0) {
      if (!(filePath in index.file_hashes)) {
        return { error: `File not in index: ${filePath}` };
      }
      return { file: filePath, repo: `${owner}/${name}`, symbols: [], _meta: makeMeta(performance.now() - start) };
    }

    const tree = buildSymbolTree(fileSymbols);
    const outline = tree.map(nodeToDict);

    let rawBytes = 0;
    try {
      rawBytes = fs.statSync(path.join(store.contentDir(owner, name), filePath)).size;
    } catch { /* */ }
    const responseBytes = Buffer.byteLength(JSON.stringify(outline), 'utf8');
    const tokensSaved = estimateSavings(rawBytes, responseBytes);
    const totalSaved = recordSavings(tokensSaved);
    const elapsed = performance.now() - start;

    return {
      file: filePath,
      repo: `${owner}/${name}`,
      language: fileSymbols[0].language,
      symbol_count: fileSymbols.length,
      symbols: outline,
      _meta: makeMeta(elapsed, { tokens_saved: tokensSaved, total_tokens_saved: totalSaved, ...costAvoided(tokensSaved, totalSaved) }),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
