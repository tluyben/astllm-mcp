/**
 * Binary integration test suite
 *
 * Spawns the compiled binary and exercises all tools via JSON-RPC stdio.
 * Run with:
 *   BINARY_PATH=./dist/astllm-mcp-linux-arm node --test test/binary.test.ts
 * Or via the npm scripts:
 *   npm run test:linux-arm   (builds + tests)
 *   npm run test:linux-x86   (builds + tests)
 *   npm run test:macosx-arm  (builds + tests)
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── config ───────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SRC_DIR      = join(PROJECT_ROOT, 'src');
const BINARY_PATH  = process.env['BINARY_PATH'] ?? join(PROJECT_ROOT, 'dist', 'astllm-mcp-linux-arm');

// ── JSON-RPC client ───────────────────────────────────────────────────────────

class McpClient {
  private proc: ChildProcess;
  private pending = new Map<number, (msg: unknown) => void>();
  private idCounter = 0;
  public errors: string[] = [];

  constructor(binaryPath: string, env: Record<string, string>) {
    this.proc = spawn(binaryPath, [], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stderr?.on('data', (d: Buffer) => {
      // Collect stderr for debugging — don't fail on it
      this.errors.push(d.toString());
    });

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id !== undefined) {
          const resolve = this.pending.get(msg.id);
          if (resolve) {
            this.pending.delete(msg.id);
            resolve(msg);
          }
        }
      } catch { /* ignore non-JSON lines */ }
    });
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.idCounter;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, 30_000);

      this.pending.set(id, (msg) => {
        clearTimeout(timeout);
        resolve(msg as Record<string, unknown>);
      });
      this.proc.stdin!.write(line);
    });
  }

  async tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resp = await this.request('tools/call', { name, arguments: args });
    const content = (resp as { result?: { content?: Array<{ text?: string }> } })
      .result?.content?.[0]?.text;
    if (!content) throw new Error(`No text content in response: ${JSON.stringify(resp)}`);
    return JSON.parse(content) as Record<string, unknown>;
  }

  kill() {
    this.proc.kill();
  }
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('binary integration', () => {
  let client: McpClient;
  let tmpStore: string;

  before(async () => {
    tmpStore = mkdtempSync(join(tmpdir(), 'astllm-binary-test-'));
    client = new McpClient(BINARY_PATH, { CODE_INDEX_PATH: tmpStore });

    // Give the server a moment to start, then index src/
    await new Promise(r => setTimeout(r, 300));
    const result = await client.tool('index_folder', { folder_path: SRC_DIR, incremental: false });
    assert.ok((result['symbol_count'] as number) > 0,
      `index_folder returned 0 symbols — binary likely broken. stderr:\n${client.errors.join('')}`);
  });

  after(() => {
    client.kill();
    rmSync(tmpStore, { recursive: true, force: true });
  });

  // ── indexing ─────────────────────────────────────────────────────────────

  test('index_folder returns symbols and correct repo name', async () => {
    const result = await client.tool('index_folder', { folder_path: SRC_DIR });
    assert.equal(result['repo'], 'local/src');
    assert.ok((result['file_count'] as number) > 5, 'too few files indexed');
    assert.ok((result['symbol_count'] as number) > 50, 'too few symbols indexed');
  });

  test('incremental re-index reports no changes', async () => {
    const result = await client.tool('index_folder', { folder_path: SRC_DIR, incremental: true });
    assert.equal(result['incremental'], true);
    assert.match(result['message'] as string ?? '', /no changes/i);
  });

  // ── list_repos ───────────────────────────────────────────────────────────

  test('list_repos returns the indexed repo', async () => {
    const result = await client.tool('list_repos', {});
    const repos = result['repos'] as Array<{ repo: string; symbol_count: number }>;
    assert.ok(Array.isArray(repos), 'repos is not an array');
    const found = repos.find(r => r.repo === 'local/src');
    assert.ok(found, 'local/src not found in list_repos');
    assert.ok(found.symbol_count > 0, 'symbol_count is 0 in list_repos');
  });

  // ── search_symbols ───────────────────────────────────────────────────────

  test('search_symbols finds parseFile', async () => {
    const result = await client.tool('search_symbols', { repo: 'local/src', query: 'parseFile' });
    const results = result['results'] as Array<{ name: string; kind: string }>;
    assert.ok(results.length > 0, 'no results for parseFile');
    assert.ok(results.some(r => r.name === 'parseFile'), 'parseFile not in results');
  });

  test('search_symbols kind filter works', async () => {
    const result = await client.tool('search_symbols', { repo: 'local/src', query: 'index', kind: 'function' });
    const results = result['results'] as Array<{ kind: string }>;
    assert.ok(results.length > 0, 'no function results for "index"');
    assert.ok(results.every(r => r.kind === 'function'), 'non-function result returned');
  });

  test('search_symbols file_pattern filter works', async () => {
    const result = await client.tool('search_symbols', {
      repo: 'local/src',
      query: 'index',
      file_pattern: 'tools/*.ts',
    });
    const results = result['results'] as Array<{ file: string }>;
    assert.ok(results.length > 0, 'no results for tools/*.ts pattern');
    assert.ok(results.every(r => r.file.startsWith('tools/')), 'file outside tools/');
  });

  // ── get_file_outline ─────────────────────────────────────────────────────

  test('get_file_outline lists symbols in extractor.ts', async () => {
    const result = await client.tool('get_file_outline', {
      repo: 'local/src',
      file_path: 'parser/extractor.ts',
    });
    const symbols = result['symbols'] as Array<{ name: string }>;
    assert.ok(Array.isArray(symbols) && symbols.length > 0, 'no symbols in extractor.ts outline');
    assert.ok(symbols.some(s => s.name === 'parseFile'), 'parseFile missing from outline');
    assert.ok(symbols.some(s => s.name === 'loadLanguage'), 'loadLanguage missing from outline');
  });

  // ── get_symbol ───────────────────────────────────────────────────────────

  test('get_symbol retrieves parseFile source', async () => {
    const result = await client.tool('get_symbol', {
      repo: 'local/src',
      symbol_id: 'parser/extractor.ts::parseFile#function',
    });
    const source = result['source'] as string;
    assert.ok(source, 'no source returned');
    assert.ok(source.includes('parseFile'), 'source does not contain "parseFile"');
    assert.ok(source.includes('function parseFile') || source.includes('parseFile('), 'source is not a function def');
  });

  test('get_symbols fetches multiple symbols at once', async () => {
    const result = await client.tool('get_symbols', {
      repo: 'local/src',
      symbol_ids: [
        'parser/extractor.ts::parseFile#function',
        'parser/symbols.ts::makeSymbolId#function',
      ],
    });
    const symbols = result['symbols'] as Array<{ symbol_id: string; source: string }>;
    assert.equal(symbols.length, 2, 'expected 2 symbols');
    assert.ok(symbols.every(s => s.source), 'missing source in get_symbols result');
  });

  // ── get_file_tree ────────────────────────────────────────────────────────

  test('get_file_tree returns tree entries', async () => {
    const result = await client.tool('get_file_tree', { repo: 'local/src' });
    const tree = result['tree'] as Array<{ name: string }>;
    assert.ok(Array.isArray(tree) && tree.length > 0, 'no tree output');
    const names = JSON.stringify(tree);
    assert.ok(names.includes('extractor'), 'extractor not in file tree');
    assert.ok(names.includes('parser'), 'parser dir not in file tree');
  });

  // ── get_repo_outline ────────────────────────────────────────────────────

  test('get_repo_outline returns structured outline', async () => {
    const result = await client.tool('get_repo_outline', { repo: 'local/src' });
    assert.equal(result['repo'], 'local/src');
    assert.ok((result['symbol_count'] as number) > 0, 'no symbols in repo outline');
    assert.ok(result['languages'], 'no languages in repo outline');
  });

  // ── search_text ──────────────────────────────────────────────────────────

  test('search_text finds "tree-sitter" across repo', async () => {
    const result = await client.tool('search_text', { repo: 'local/src', query: 'tree-sitter' });
    const matches = result['matches'] as Record<string, unknown[]>;
    assert.ok(typeof matches === 'object' && Object.keys(matches).length > 0, 'no text matches for "tree-sitter"');
  });

  // ── invalidate_cache ────────────────────────────────────────────────────

  test('invalidate_cache removes the index, next index_folder is full re-parse', async () => {
    await client.tool('invalidate_cache', { repo: 'local/src' });
    // Re-index should be non-incremental since cache was cleared
    const result = await client.tool('index_folder', { folder_path: SRC_DIR, incremental: false });
    assert.ok((result['symbol_count'] as number) > 0, 'no symbols after re-index post-invalidate');
    assert.equal(result['incremental'], false);
  });
});
