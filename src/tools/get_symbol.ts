import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { IndexStore } from '../storage/index_store.js';
import { resolveRepo, makeMeta } from './_utils.js';
import { estimateSavings, recordSavings, costAvoided } from '../storage/token_tracker.js';

export function getSymbol(
  repo: string,
  symbolId: string,
  verify = false,
  contextLines = 0,
  storagePath?: string | null,
): Record<string, unknown> {
  const start = performance.now();
  const store = new IndexStore(storagePath);
  contextLines = Math.max(0, Math.min(contextLines, 50));

  try {
    const [owner, name] = resolveRepo(repo, store);
    const index = store.loadIndex(owner, name);
    if (!index) return { error: `Repository not indexed: ${owner}/${name}` };

    const sym = store.getSymbol(index, symbolId);
    if (!sym) return { error: `Symbol not found: ${symbolId}` };

    const source = store.getSymbolContent(owner, name, symbolId) ?? '';

    let contextBefore = '';
    let contextAfter = '';
    if (contextLines > 0 && source) {
      try {
        const filePath = path.join(store.contentDir(owner, name), sym.file);
        const allLines = fs.readFileSync(filePath, 'utf8').split('\n');
        const startLine = sym.line - 1; // 0-indexed
        const endLine = sym.end_line;   // 0-indexed exclusive
        const beforeStart = Math.max(0, startLine - contextLines);
        const afterEnd = Math.min(allLines.length, endLine + contextLines);
        if (beforeStart < startLine) {
          contextBefore = allLines.slice(beforeStart, startLine).join('\n');
        }
        if (endLine < afterEnd) {
          contextAfter = allLines.slice(endLine, afterEnd).join('\n');
        }
      } catch { /* */ }
    }

    const meta: Record<string, unknown> = {};
    if (verify && source) {
      const actualHash = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
      meta['content_verified'] = sym.content_hash ? actualHash === sym.content_hash : null;
    }

    let rawBytes = 0;
    try {
      rawBytes = fs.statSync(path.join(store.contentDir(owner, name), sym.file)).size;
    } catch { /* */ }

    const tokensSaved = estimateSavings(rawBytes, sym.byte_length);
    const totalSaved = recordSavings(tokensSaved);
    const elapsed = performance.now() - start;

    const result: Record<string, unknown> = {
      id: sym.id,
      kind: sym.kind,
      name: sym.name,
      qualified_name: sym.qualified_name,
      file: sym.file,
      line: sym.line,
      end_line: sym.end_line,
      signature: sym.signature,
      decorators: sym.decorators,
      docstring: sym.docstring,
      summary: sym.summary,
      content_hash: sym.content_hash,
      source,
      _meta: makeMeta(elapsed, { tokens_saved: tokensSaved, total_tokens_saved: totalSaved, ...costAvoided(tokensSaved, totalSaved), ...meta }),
    };

    if (contextBefore) result['context_before'] = contextBefore;
    if (contextAfter) result['context_after'] = contextAfter;

    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function getSymbols(
  repo: string,
  symbolIds: string[],
  storagePath?: string | null,
): Record<string, unknown> {
  const start = performance.now();
  const store = new IndexStore(storagePath);

  try {
    const [owner, name] = resolveRepo(repo, store);
    const index = store.loadIndex(owner, name);
    if (!index) return { error: `Repository not indexed: ${owner}/${name}` };

    const symbols: Record<string, unknown>[] = [];
    const errors: Record<string, unknown>[] = [];

    for (const symbolId of symbolIds) {
      const sym = store.getSymbol(index, symbolId);
      if (!sym) {
        errors.push({ id: symbolId, error: `Symbol not found: ${symbolId}` });
        continue;
      }
      const source = store.getSymbolContent(owner, name, symbolId) ?? '';
      symbols.push({
        id: sym.id, kind: sym.kind, name: sym.name, qualified_name: sym.qualified_name,
        file: sym.file, line: sym.line, end_line: sym.end_line,
        signature: sym.signature, decorators: sym.decorators, docstring: sym.docstring,
        summary: sym.summary, content_hash: sym.content_hash, source,
      });
    }

    // Savings: unique file sizes vs sum of byte_lengths
    let rawBytes = 0;
    const seenFiles = new Set<string>();
    let responseBytes = 0;
    for (const symbolId of symbolIds) {
      const sym = store.getSymbol(index, symbolId);
      if (!sym) continue;
      if (!seenFiles.has(sym.file)) {
        seenFiles.add(sym.file);
        try { rawBytes += fs.statSync(path.join(store.contentDir(owner, name), sym.file)).size; } catch { /* */ }
      }
      responseBytes += sym.byte_length;
    }

    const tokensSaved = estimateSavings(rawBytes, responseBytes);
    const totalSaved = recordSavings(tokensSaved);
    const elapsed = performance.now() - start;

    return {
      symbols,
      errors,
      _meta: makeMeta(elapsed, { symbol_count: symbols.length, tokens_saved: tokensSaved, total_tokens_saved: totalSaved, ...costAvoided(tokensSaved, totalSaved) }),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
