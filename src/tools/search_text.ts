import fs from 'fs';
import path from 'path';
import { IndexStore } from '../storage/index_store.js';
import { resolveRepo, makeMeta } from './_utils.js';
import { estimateSavings, recordSavings, costAvoided } from '../storage/token_tracker.js';

interface TextMatch {
  file: string;
  line: number;
  text: string;
}

export function searchText(
  repo: string,
  query: string,
  filePattern?: string,
  limit = 100,
  storagePath?: string | null,
): Record<string, unknown> {
  const start = performance.now();
  const store = new IndexStore(storagePath);
  limit = Math.min(limit, 200);

  try {
    const [owner, name] = resolveRepo(repo, store);
    const index = store.loadIndex(owner, name);
    if (!index) return { error: `Repository not indexed: ${owner}/${name}` };

    const contentDir = store.contentDir(owner, name);
    const queryLower = query.toLowerCase();
    const matches: TextMatch[] = [];
    let filesSearched = 0;
    let rawBytes = 0;

    // Compile optional file pattern
    let fileRe: RegExp | null = null;
    if (filePattern) {
      const pat = filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      fileRe = new RegExp(pat);
    }

    for (const file of Object.keys(index.file_hashes)) {
      if (fileRe && !fileRe.test(file)) continue;
      const filePath = path.join(contentDir, file);

      let content: string;
      try {
        const stat = fs.statSync(filePath);
        rawBytes += stat.size;
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      filesSearched++;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(queryLower)) {
          matches.push({
            file,
            line: i + 1,
            text: lines[i].slice(0, 200),
          });
          if (matches.length >= limit) break;
        }
      }
      if (matches.length >= limit) break;
    }

    const responseBytes = Buffer.byteLength(JSON.stringify(matches), 'utf8');
    const tokensSaved = estimateSavings(rawBytes, responseBytes);
    const totalSaved = recordSavings(tokensSaved);
    const elapsed = performance.now() - start;

    // Group by file for readability
    const byFile: Record<string, Array<{ line: number; text: string }>> = {};
    for (const m of matches) {
      if (!byFile[m.file]) byFile[m.file] = [];
      byFile[m.file].push({ line: m.line, text: m.text });
    }

    return {
      matches: byFile,
      total_matches: matches.length,
      truncated: matches.length >= limit,
      files_searched: filesSearched,
      _meta: makeMeta(elapsed, { tokens_saved: tokensSaved, total_tokens_saved: totalSaved, ...costAvoided(tokensSaved, totalSaved) }),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
