/**
 * astllm-mcp test suite
 *
 * Indexes the project's own ./src directory and verifies that all tools
 * produce correct, self-consistent results.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { indexFolder } from '../src/tools/index_folder.js';
import { listRepos } from '../src/tools/list_repos.js';
import { getFileTree } from '../src/tools/get_file_tree.js';
import { getFileOutline } from '../src/tools/get_file_outline.js';
import { getRepoOutline } from '../src/tools/get_repo_outline.js';
import { getSymbol, getSymbols } from '../src/tools/get_symbol.js';
import { searchSymbols } from '../src/tools/search_symbols.js';
import { searchText } from '../src/tools/search_text.js';
import { invalidateCache } from '../src/tools/invalidate_cache.js';

import { parseFile, getLanguageForFile } from '../src/parser/extractor.js';
import { makeSymbolId } from '../src/parser/symbols.js';
import { buildSymbolTree, flattenTree } from '../src/parser/hierarchy.js';
import { IndexStore } from '../src/storage/index_store.js';
import {
  validatePath, isSecretFile, isBinaryExtension, shouldExcludeFile,
  getMaxIndexFiles, getMaxFileSizeBytes,
} from '../src/security.js';
import { estimateSavings, costAvoided } from '../src/storage/token_tracker.js';

// ── config ───────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const TMP_STORE = path.join(os.tmpdir(), `astllm-test-${process.pid}`);
const REPO_NAME = 'astllm';

// ── known symbols in src/ ────────────────────────────────────────────────────

const KNOWN_FUNCTIONS = [
  'parseFile', 'getLanguageForFile', 'buildSymbolTree', 'flattenTree',
  'makeSymbolId', 'disambiguateOverloads', 'computeContentHash',
  'validatePath', 'isSecretFile', 'isBinaryExtension', 'shouldExcludeFile',
  'safeReadFile', 'getMaxIndexFiles', 'getMaxFileSizeBytes',
  'estimateSavings', 'recordSavings', 'getTotalSaved', 'costAvoided',
  'resolveRepo', 'makeMeta',
  'indexFolder', 'indexRepo',
  'listRepos', 'getFileTree', 'getFileOutline', 'getRepoOutline',
  'getSymbol', 'getSymbols', 'searchSymbols', 'searchText', 'invalidateCache',
];

const KNOWN_CLASSES = ['IndexStore'];

const KNOWN_SOURCE_FILES = [
  'src/parser/extractor.ts',
  'src/parser/symbols.ts',
  'src/parser/hierarchy.ts',
  'src/parser/languages.ts',
  'src/storage/index_store.ts',
  'src/storage/token_tracker.ts',
  'src/security.ts',
  'src/tools/index_folder.ts',
  'src/tools/index_repo.ts',
  'src/tools/get_symbol.ts',
  'src/tools/search_symbols.ts',
  'src/tools/search_text.ts',
  'src/tools/list_repos.ts',
  'src/tools/get_file_tree.ts',
  'src/tools/get_file_outline.ts',
  'src/tools/get_repo_outline.ts',
  'src/tools/invalidate_cache.ts',
  'src/tools/_utils.ts',
  'src/index.ts',
];

// ── helpers ──────────────────────────────────────────────────────────────────

/** Flatten the nested tree returned by getFileTree into a list of file entries. */
interface TreeNode { name: string; type: string; language?: string; symbol_count?: number; path?: string; children?: TreeNode[] }
function flattenFileTree(nodes: TreeNode[], prefix = ''): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    const fullPath = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.type === 'file') {
      out.push({ ...n, path: fullPath });
    } else if (n.children) {
      out.push(...flattenFileTree(n.children, fullPath));
    }
  }
  return out;
}

/** Recursively search outline symbols (which have `id`) for a given name. */
interface OutlineSym { id: string; name: string; kind: string; children?: OutlineSym[] }
function findInOutline(nodes: OutlineSym[], name: string): OutlineSym | undefined {
  for (const s of nodes) {
    if (s.name === name) return s;
    if (s.children) {
      const found = findInOutline(s.children, name);
      if (found) return found;
    }
  }
  return undefined;
}

// ── index once ───────────────────────────────────────────────────────────────

let indexResult: Record<string, unknown>;

before(async () => {
  fs.mkdirSync(TMP_STORE, { recursive: true });
  indexResult = await indexFolder(
    PROJECT_ROOT,
    false,
    ['test/', 'dist/', 'node_modules/'],
    false,
    false,   // full, not incremental
    TMP_STORE,
  );
  if (indexResult['error']) {
    throw new Error(`Indexing failed: ${indexResult['error']}`);
  }
});

after(() => {
  fs.rmSync(TMP_STORE, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// 1 — index_folder
// ════════════════════════════════════════════════════════════════════════════

describe('index_folder', () => {
  test('returns success', () => {
    assert.equal(indexResult['success'], true);
  });

  test('indexes all known source files', () => {
    const count = indexResult['file_count'] as number;
    assert.ok(count >= KNOWN_SOURCE_FILES.length, `expected >= ${KNOWN_SOURCE_FILES.length} files, got ${count}`);
  });

  test('extracts a reasonable number of symbols (>= 42)', () => {
    const count = indexResult['symbol_count'] as number;
    assert.ok(count >= 42, `expected >= 42 symbols, got ${count}`);
  });

  test('detects TypeScript as the primary language', () => {
    const langs = indexResult['languages'] as Record<string, number>;
    assert.ok(langs['typescript'] > 0);
  });

  test('includes _meta with timing', () => {
    const meta = indexResult['_meta'] as Record<string, unknown>;
    assert.ok(meta && typeof meta['timing_ms'] === 'number');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2 — incremental re-index
// ════════════════════════════════════════════════════════════════════════════

describe('incremental re-index', () => {
  test('detects no changes on second run', async () => {
    const second = await indexFolder(
      PROJECT_ROOT,
      false,
      ['test/', 'dist/', 'node_modules/'],
      false,
      true,
      TMP_STORE,
    );
    assert.equal(second['success'], true);
    const noChange =
      (second['message'] as string | undefined)?.includes('No changes') ||
      second['files_processed'] === 0;
    assert.ok(noChange, `Expected no changes but got: ${JSON.stringify(second)}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3 — list_repos
// ════════════════════════════════════════════════════════════════════════════

describe('list_repos', () => {
  test('returns at least one repo', () => {
    const result = listRepos(TMP_STORE);
    const repos = result['repos'] as unknown[];
    assert.ok(repos.length >= 1);
  });

  test('listed repo has expected fields', () => {
    const result = listRepos(TMP_STORE);
    const repo = (result['repos'] as Record<string, unknown>[])[0];
    assert.ok('repo' in repo);
    assert.ok('file_count' in repo);
    assert.ok('symbol_count' in repo);
    assert.ok('indexed_at' in repo);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4 — get_file_tree
// ════════════════════════════════════════════════════════════════════════════

describe('get_file_tree', () => {
  let allFiles: TreeNode[];

  before(() => {
    const tree = getFileTree(REPO_NAME, '', false, TMP_STORE);
    allFiles = flattenFileTree(tree['tree'] as TreeNode[]);
  });

  test('succeeds and returns tree', () => {
    assert.ok(allFiles.length > 0);
  });

  test('contains all known source files', () => {
    const paths = allFiles.map(f => f.path!);
    for (const expected of KNOWN_SOURCE_FILES) {
      assert.ok(paths.includes(expected), `missing: ${expected}`);
    }
  });

  test('each .ts file has language=typescript and symbol_count', () => {
    const tsFiles = allFiles.filter(f => f.path!.endsWith('.ts'));
    for (const f of tsFiles) {
      assert.equal(f.language, 'typescript', `wrong lang for ${f.path}`);
      assert.ok(typeof f.symbol_count === 'number', `no symbol_count for ${f.path}`);
    }
  });

  test('path_prefix filter restricts returned files', () => {
    const prefix = 'src/tools';
    const filtered = getFileTree(REPO_NAME, prefix, false, TMP_STORE);
    // When path_prefix is set, the tree is rooted at that dir — paths are relative to it.
    // Flatten and prepend the prefix to reconstruct full paths.
    const files = flattenFileTree(filtered['tree'] as TreeNode[]).map(f => ({
      ...f,
      path: `${prefix}/${f.path}`,
    }));
    assert.ok(files.length > 0);
    for (const f of files) {
      assert.ok(f.path.startsWith(prefix), `unexpected: ${f.path}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5 — get_file_outline
// ════════════════════════════════════════════════════════════════════════════

describe('get_file_outline', () => {
  test('outlines security.ts correctly', () => {
    const result = getFileOutline(REPO_NAME, 'src/security.ts', TMP_STORE);
    assert.ok(!result['error'], `${result['error']}`);
    const syms = result['symbols'] as OutlineSym[];
    const names = syms.map(s => s.name);
    for (const fn of ['validatePath', 'isSecretFile', 'isBinaryExtension', 'shouldExcludeFile', 'safeReadFile']) {
      assert.ok(names.includes(fn), `missing: ${fn}`);
    }
  });

  test('outlines index_store.ts and finds IndexStore with children', () => {
    const result = getFileOutline(REPO_NAME, 'src/storage/index_store.ts', TMP_STORE);
    assert.ok(!result['error'], `${result['error']}`);
    const syms = result['symbols'] as OutlineSym[];
    const cls = syms.find(s => s.name === 'IndexStore');
    assert.ok(cls, 'IndexStore not found');
    assert.ok(cls!.children && cls!.children.length > 0, 'IndexStore has no children');
  });

  test('symbol entries have required fields', () => {
    const result = getFileOutline(REPO_NAME, 'src/security.ts', TMP_STORE);
    const syms = result['symbols'] as OutlineSym[];
    for (const s of syms) {
      assert.ok(s.id, `missing id on ${s.name}`);
      assert.ok(s.kind, `missing kind on ${s.name}`);
    }
  });

  test('returns error for non-existent file', () => {
    const result = getFileOutline(REPO_NAME, 'src/does_not_exist.ts', TMP_STORE);
    assert.ok(result['error']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6 — get_repo_outline
// ════════════════════════════════════════════════════════════════════════════

describe('get_repo_outline', () => {
  let outline: Record<string, unknown>;

  before(() => {
    outline = getRepoOutline(REPO_NAME, TMP_STORE);
  });

  test('succeeds', () => {
    assert.ok(!outline['error'], `${outline['error']}`);
  });

  test('has language breakdown with typescript', () => {
    const langs = outline['languages'] as Record<string, number>;
    assert.ok(langs['typescript'] > 0);
  });

  test('has symbol kind distribution with functions, classes, methods', () => {
    const kinds = outline['symbol_kinds'] as Record<string, number>;
    assert.ok(kinds['function'] > 0, 'no functions');
    assert.ok(kinds['class'] > 0, 'no classes');
    assert.ok(kinds['method'] > 0, 'no methods');
  });

  test('has top_directories', () => {
    assert.ok('top_directories' in outline);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7 — search_symbols
// ════════════════════════════════════════════════════════════════════════════

describe('search_symbols', () => {
  test('finds all known exported functions', () => {
    for (const fn of KNOWN_FUNCTIONS) {
      const result = searchSymbols(REPO_NAME, fn, undefined, undefined, undefined, 10, TMP_STORE);
      const results = result['results'] as Array<Record<string, unknown>>;
      const found = results.some(s => s['name'] === fn);
      assert.ok(found, `not found: ${fn}`);
    }
  });

  test('finds IndexStore class', () => {
    const result = searchSymbols(REPO_NAME, 'IndexStore', 'class', undefined, undefined, 10, TMP_STORE);
    const results = result['results'] as Array<Record<string, unknown>>;
    assert.ok(results.length > 0, 'IndexStore not found');
    assert.equal(results[0]['name'], 'IndexStore');
  });

  test('kind filter limits results to functions only', () => {
    const result = searchSymbols(REPO_NAME, 'get', 'function', undefined, undefined, 100, TMP_STORE);
    const results = result['results'] as Array<Record<string, unknown>>;
    assert.ok(results.length > 0);
    for (const s of results) {
      assert.equal(s['kind'], 'function', `unexpected kind ${s['kind']} for ${s['name']}`);
    }
  });

  test('file_pattern filter restricts to matching file', () => {
    const result = searchSymbols(REPO_NAME, '', undefined, 'src/security.ts', undefined, 50, TMP_STORE);
    const results = result['results'] as Array<Record<string, unknown>>;
    assert.ok(results.length > 0);
    for (const s of results) {
      assert.ok(
        (s['id'] as string).startsWith('src/security.ts'),
        `wrong file: ${s['id']}`,
      );
    }
  });

  test('language filter restricts to typescript', () => {
    const result = searchSymbols(REPO_NAME, 'parse', undefined, undefined, 'typescript', 20, TMP_STORE);
    const results = result['results'] as Array<Record<string, unknown>>;
    assert.ok(results.length > 0);
    for (const s of results) {
      assert.equal(s['language'], 'typescript');
    }
  });

  test('limit is respected', () => {
    const result = searchSymbols(REPO_NAME, '', undefined, undefined, undefined, 3, TMP_STORE);
    const results = result['results'] as Array<Record<string, unknown>>;
    assert.ok(results.length <= 3);
  });

  test('partial name match works ("Symbol")', () => {
    const result = searchSymbols(REPO_NAME, 'Symbol', undefined, undefined, undefined, 20, TMP_STORE);
    const results = result['results'] as Array<Record<string, unknown>>;
    assert.ok(results.length > 0, 'no results for partial "Symbol"');
  });

  test('result entries have id, name, kind, file, signature', () => {
    const result = searchSymbols(REPO_NAME, 'validatePath', undefined, undefined, undefined, 5, TMP_STORE);
    const s = (result['results'] as Array<Record<string, unknown>>)[0];
    assert.ok(s['id'], 'missing id');
    assert.ok(s['name'], 'missing name');
    assert.ok(s['kind'], 'missing kind');
    assert.ok(s['file'], 'missing file');
    assert.ok(s['signature'], 'missing signature');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8 — get_symbol (byte-offset correctness)
// ════════════════════════════════════════════════════════════════════════════

describe('get_symbol — byte-offset correctness', () => {
  async function checkSymbol(name: string, filePath: string) {
    const outline = getFileOutline(REPO_NAME, filePath, TMP_STORE);
    const syms = outline['symbols'] as OutlineSym[];
    const sym = findInOutline(syms, name);
    assert.ok(sym, `"${name}" not in outline of ${filePath}`);

    const result = getSymbol(REPO_NAME, sym!.id, false, 0, TMP_STORE);
    assert.ok(!result['error'], `get_symbol error for ${sym!.id}: ${result['error']}`);

    const source = result['source'] as string;
    assert.ok(source && source.length > 0, `empty source for ${sym!.id}`);

    // Source must appear verbatim in the actual file
    const realContent = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf8');
    assert.ok(
      realContent.includes(source),
      `source for "${name}" not found verbatim in ${filePath}.\nReturned:\n${source.slice(0, 300)}`,
    );

    // Source should start like a real definition
    const trimmed = source.trimStart();
    const looksLikeDefinition =
      /^(export\s+)?(async\s+)?function\s+/.test(trimmed) ||
      /^(export\s+)?class\s+/.test(trimmed) ||
      /^(export\s+)?(interface|type)\s+/.test(trimmed) ||
      /^(export\s+)?const\s+/.test(trimmed) ||
      /^(private|public|protected|static|async|\w+)\s*\(/.test(trimmed) ||
      /^constructor\s*\(/.test(trimmed);
    assert.ok(looksLikeDefinition, `source for "${name}" doesn't look like a definition:\n${trimmed.slice(0, 120)}`);
  }

  test('validatePath', async () => checkSymbol('validatePath', 'src/security.ts'));
  test('isSecretFile', async () => checkSymbol('isSecretFile', 'src/security.ts'));
  test('isBinaryExtension', async () => checkSymbol('isBinaryExtension', 'src/security.ts'));
  test('shouldExcludeFile', async () => checkSymbol('shouldExcludeFile', 'src/security.ts'));
  test('getMaxIndexFiles', async () => checkSymbol('getMaxIndexFiles', 'src/security.ts'));
  test('parseFile', async () => checkSymbol('parseFile', 'src/parser/extractor.ts'));
  test('getLanguageForFile', async () => checkSymbol('getLanguageForFile', 'src/parser/extractor.ts'));
  test('buildSymbolTree', async () => checkSymbol('buildSymbolTree', 'src/parser/hierarchy.ts'));
  test('flattenTree', async () => checkSymbol('flattenTree', 'src/parser/hierarchy.ts'));
  test('estimateSavings', async () => checkSymbol('estimateSavings', 'src/storage/token_tracker.ts'));
  test('costAvoided', async () => checkSymbol('costAvoided', 'src/storage/token_tracker.ts'));
  test('IndexStore class', async () => checkSymbol('IndexStore', 'src/storage/index_store.ts'));
  test('makeMeta', async () => checkSymbol('makeMeta', 'src/tools/_utils.ts'));
  test('resolveRepo', async () => checkSymbol('resolveRepo', 'src/tools/_utils.ts'));
  test('searchSymbols (tool)', async () => checkSymbol('searchSymbols', 'src/tools/search_symbols.ts'));
  test('searchText (tool)', async () => checkSymbol('searchText', 'src/tools/search_text.ts'));
  test('getFileOutline (tool)', async () => checkSymbol('getFileOutline', 'src/tools/get_file_outline.ts'));
  test('getFileTree (tool)', async () => checkSymbol('getFileTree', 'src/tools/get_file_tree.ts'));
  test('getRepoOutline (tool)', async () => checkSymbol('getRepoOutline', 'src/tools/get_repo_outline.ts'));
  test('getSymbol (tool)', async () => checkSymbol('getSymbol', 'src/tools/get_symbol.ts'));
  test('listRepos (tool)', async () => checkSymbol('listRepos', 'src/tools/list_repos.ts'));
  test('invalidateCache (tool)', async () => checkSymbol('invalidateCache', 'src/tools/invalidate_cache.ts'));

  test('context_lines adds surrounding lines', () => {
    const outline = getFileOutline(REPO_NAME, 'src/security.ts', TMP_STORE);
    const syms = outline['symbols'] as OutlineSym[];
    const sym = syms.find(s => s.name === 'validatePath')!;
    const withCtx = getSymbol(REPO_NAME, sym.id, false, 3, TMP_STORE);
    const without  = getSymbol(REPO_NAME, sym.id, false, 0, TMP_STORE);
    const ctxLines   = (withCtx['source'] as string).split('\n').length;
    const plainLines = (without['source']  as string).split('\n').length;
    assert.ok(ctxLines >= plainLines, 'context_lines did not expand source');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9 — get_symbols (batch)
// ════════════════════════════════════════════════════════════════════════════

describe('get_symbols — batch retrieval', () => {
  test('fetches multiple symbols in one call', () => {
    const outline = getFileOutline(REPO_NAME, 'src/security.ts', TMP_STORE);
    const syms = outline['symbols'] as OutlineSym[];
    const ids = syms.slice(0, 4).map(s => s.id);
    assert.ok(ids.length >= 2);

    const result = getSymbols(REPO_NAME, ids, TMP_STORE);
    // get_symbols returns { symbols: [...], errors: [...], _meta }
    const symbols = result['symbols'] as Array<Record<string, unknown>>;
    assert.ok(symbols && symbols.length > 0, `no symbols returned: ${JSON.stringify(result)}`);
    for (const r of symbols) {
      assert.ok(r['source'] && (r['source'] as string).length > 0, `empty source for ${r['id']}`);
    }
  });

  test('returns errors for unknown symbol ids', () => {
    const outline = getFileOutline(REPO_NAME, 'src/security.ts', TMP_STORE);
    const syms = outline['symbols'] as OutlineSym[];
    const goodId = syms[0].id;
    const badId  = 'src/does_not_exist.ts::nope#function';

    const result = getSymbols(REPO_NAME, [goodId, badId], TMP_STORE);
    const symbols = result['symbols'] as Array<Record<string, unknown>> ?? [];
    const errors  = result['errors']  as Array<Record<string, unknown>> ?? [];
    // good ID should appear in symbols, bad ID should appear in errors
    assert.ok(symbols.some(s => s['id'] === goodId), 'good symbol not in symbols');
    assert.ok(errors.some(e => e['id'] === badId), 'bad id not in errors');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10 — search_text
// ════════════════════════════════════════════════════════════════════════════

describe('search_text', () => {
  // matches is an object: { filePath: [{line, text}] }
  function countMatches(result: Record<string, unknown>): number {
    return result['total_matches'] as number ?? 0;
  }
  function matchEntries(result: Record<string, unknown>): Array<{ file: string; line: number; text: string }> {
    const matches = result['matches'] as Record<string, Array<{ line: number; text: string }>>;
    const out: Array<{ file: string; line: number; text: string }> = [];
    for (const [file, lines] of Object.entries(matches ?? {})) {
      for (const m of lines) out.push({ file, ...m });
    }
    return out;
  }

  test('finds "astllm-mcp" string literal', () => {
    const result = searchText(REPO_NAME, 'astllm-mcp', undefined, 20, TMP_STORE);
    assert.ok(!result['error'], `${result['error']}`);
    assert.ok(countMatches(result) > 0, 'no matches for "astllm-mcp"');
  });

  test('finds tree-sitter references', () => {
    const result = searchText(REPO_NAME, 'tree-sitter', undefined, 50, TMP_STORE);
    assert.ok(countMatches(result) > 0);
  });

  test('file_pattern restricts search to one file', () => {
    const result = searchText(REPO_NAME, 'export function', 'src/security.ts', 50, TMP_STORE);
    const entries = matchEntries(result);
    assert.ok(entries.length > 0);
    for (const m of entries) {
      assert.equal(m.file, 'src/security.ts', `unexpected file: ${m.file}`);
    }
  });

  test('limit caps total_matches', () => {
    const result = searchText(REPO_NAME, 'const', undefined, 5, TMP_STORE);
    assert.ok(countMatches(result) <= 5);
  });

  test('returns zero matches for unknown string', () => {
    const result = searchText(REPO_NAME, 'xyzzy_does_not_exist_12345', undefined, 10, TMP_STORE);
    assert.equal(countMatches(result), 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 11 — invalidate_cache
// ════════════════════════════════════════════════════════════════════════════

describe('invalidate_cache', () => {
  test('invalidates and allows full re-index', async () => {
    const inv = invalidateCache(REPO_NAME, TMP_STORE);
    assert.ok(inv['success'], `invalidate failed: ${JSON.stringify(inv)}`);

    const listed = listRepos(TMP_STORE);
    const repos = listed['repos'] as unknown[];
    assert.equal(repos.length, 0, 'expected empty repos after invalidate');

    const reindexed = await indexFolder(
      PROJECT_ROOT,
      false,
      ['test/', 'dist/', 'node_modules/'],
      false,
      false,
      TMP_STORE,
    );
    assert.equal(reindexed['success'], true);
    assert.ok((reindexed['symbol_count'] as number) >= 42);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 12 — parser unit tests
// ════════════════════════════════════════════════════════════════════════════

describe('parser — getLanguageForFile', () => {
  const cases: [string, string | null][] = [
    ['foo.ts',   'typescript'],
    ['foo.tsx',  'tsx'],
    ['foo.js',   'javascript'],
    ['foo.py',   'python'],
    ['foo.go',   'go'],
    ['foo.rs',   'rust'],
    ['foo.java', 'java'],
    ['foo.cs',    'csharp'],
    ['foo.c',     'c'],
    ['foo.cpp',   'cpp'],
    ['foo.dart',  'dart'],
    ['foo.swift', 'swift'],
    ['foo.md',   null],
    ['foo.json', null],
    ['foo.txt',  null],
  ];
  for (const [file, expected] of cases) {
    test(`${file} → ${expected}`, () => assert.equal(getLanguageForFile(file), expected));
  }
});

describe('parser — parseFile on known TypeScript snippet', () => {
  const snippet = `
export function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  multiply(x: number, y: number): number {
    return x * y;
  }
}
`.trim();

  test('extracts top-level function', () => {
    const syms = parseFile(snippet, 'calc.ts', 'typescript');
    const fn = syms.find(s => s.name === 'add');
    assert.ok(fn, 'add not found');
    assert.equal(fn!.kind, 'function');
    assert.equal(fn!.file, 'calc.ts');
    assert.ok(fn!.byte_offset >= 0);
    assert.ok(fn!.byte_length > 0);
  });

  test('extracts class', () => {
    const syms = parseFile(snippet, 'calc.ts', 'typescript');
    const cls = syms.find(s => s.name === 'Calculator');
    assert.ok(cls, 'Calculator not found');
    assert.equal(cls!.kind, 'class');
  });

  test('extracts method inside class', () => {
    const syms = parseFile(snippet, 'calc.ts', 'typescript');
    const method = syms.find(s => s.name === 'multiply');
    assert.ok(method, 'multiply not found');
    assert.equal(method!.kind, 'method');
    assert.ok(method!.qualified_name.includes('Calculator'));
  });

  test('byte offsets are valid and extracted content matches source', () => {
    const buf = Buffer.from(snippet, 'utf8');
    const syms = parseFile(snippet, 'calc.ts', 'typescript');
    for (const sym of syms) {
      assert.ok(sym.byte_offset >= 0 && sym.byte_offset < buf.length, `bad offset for ${sym.name}`);
      assert.ok(sym.byte_length > 0 && sym.byte_offset + sym.byte_length <= buf.length, `bad length for ${sym.name}`);
      const extracted = buf.subarray(sym.byte_offset, sym.byte_offset + sym.byte_length).toString('utf8');
      assert.ok(extracted.includes(sym.name), `extracted doesn't include "${sym.name}":\n${extracted}`);
    }
  });
});

describe('parser — parseFile handles Unicode correctly', () => {
  // ─ is U+2500, 3 UTF-8 bytes — this is what tripped the original byte-offset bug
  const snippet = `// ─── Section ───────────────────────────────────────────
export function unicodeTest(): string {
  return '→ result';
}`;

  test('byte offset is correct with multi-byte Unicode chars before the symbol', () => {
    const buf = Buffer.from(snippet, 'utf8');
    const syms = parseFile(snippet, 'u.ts', 'typescript');
    const fn = syms.find(s => s.name === 'unicodeTest');
    assert.ok(fn, 'unicodeTest not found');
    const extracted = buf.subarray(fn!.byte_offset, fn!.byte_offset + fn!.byte_length).toString('utf8');
    assert.ok(extracted.includes('unicodeTest'), `wrong byte offset, got:\n${extracted}`);
    assert.ok(extracted.startsWith('export function') || extracted.startsWith('function'),
      `source should start with function keyword, got: ${extracted.slice(0, 50)}`);
  });
});

describe('parser — parseFile on Dart snippet', () => {
  const snippet = `
/// A Flutter widget
class MyWidget {
  final String title;
  MyWidget({required this.title});
}

void greet(String name) {
  print(name);
}

enum Status { active, inactive }

mixin Flyable {
  void fly() {}
}
`.trim();

  test('extracts top-level class', () => {
    const syms = parseFile(snippet, 'widget.dart', 'dart');
    const cls = syms.find(s => s.name === 'MyWidget');
    assert.ok(cls, 'MyWidget not found');
    assert.equal(cls!.kind, 'class');
  });

  test('extracts top-level function', () => {
    const syms = parseFile(snippet, 'widget.dart', 'dart');
    const fn = syms.find(s => s.name === 'greet');
    assert.ok(fn, 'greet not found');
    assert.equal(fn!.kind, 'function');
  });

  test('extracts enum', () => {
    const syms = parseFile(snippet, 'widget.dart', 'dart');
    const e = syms.find(s => s.name === 'Status');
    assert.ok(e, 'Status not found');
    assert.equal(e!.kind, 'type');
  });

  test('extracts mixin', () => {
    const syms = parseFile(snippet, 'widget.dart', 'dart');
    const m = syms.find(s => s.name === 'Flyable');
    assert.ok(m, 'Flyable not found');
    assert.equal(m!.kind, 'class');
  });

  test('byte offsets are valid', () => {
    const buf = Buffer.from(snippet, 'utf8');
    const syms = parseFile(snippet, 'widget.dart', 'dart');
    for (const sym of syms) {
      assert.ok(sym.byte_offset >= 0 && sym.byte_offset < buf.length, `bad offset for ${sym.name}`);
      assert.ok(sym.byte_length > 0 && sym.byte_offset + sym.byte_length <= buf.length, `bad length for ${sym.name}`);
    }
  });
});

describe('parser — parseFile on Swift snippet', () => {
  const snippet = `
// A Swift greeting
func greet(name: String) -> String {
    return "Hello, \\(name)!"
}

class Animal {
    var name: String = ""
    func speak() -> String { return "" }
}

struct Point {
    var x: Double = 0
    var y: Double = 0
}

protocol Drawable {
    func draw()
}
`.trim();

  test('extracts top-level function', () => {
    const syms = parseFile(snippet, 'app.swift', 'swift');
    const fn = syms.find(s => s.name === 'greet');
    assert.ok(fn, 'greet not found');
    assert.equal(fn!.kind, 'function');
  });

  test('extracts class', () => {
    const syms = parseFile(snippet, 'app.swift', 'swift');
    const cls = syms.find(s => s.name === 'Animal');
    assert.ok(cls, 'Animal not found');
    assert.equal(cls!.kind, 'class');
  });

  test('extracts struct as class', () => {
    const syms = parseFile(snippet, 'app.swift', 'swift');
    const s = syms.find(sym => sym.name === 'Point');
    assert.ok(s, 'Point not found');
    assert.equal(s!.kind, 'class');
  });

  test('extracts protocol as interface', () => {
    const syms = parseFile(snippet, 'app.swift', 'swift');
    const p = syms.find(s => s.name === 'Drawable');
    assert.ok(p, 'Drawable not found');
    assert.equal(p!.kind, 'interface');
  });

  test('byte offsets are valid', () => {
    const buf = Buffer.from(snippet, 'utf8');
    const syms = parseFile(snippet, 'app.swift', 'swift');
    for (const sym of syms) {
      assert.ok(sym.byte_offset >= 0 && sym.byte_offset < buf.length, `bad offset for ${sym.name}`);
      assert.ok(sym.byte_length > 0 && sym.byte_offset + sym.byte_length <= buf.length, `bad length for ${sym.name}`);
    }
  });
});

describe('parser — makeSymbolId', () => {
  test('produces correct format', () => {
    const id = makeSymbolId('src/foo.ts', 'MyClass.myMethod', 'method');
    assert.equal(id, 'src/foo.ts::MyClass.myMethod#method');
  });
});

describe('parser — buildSymbolTree + flattenTree', () => {
  test('nests methods under their class', () => {
    const snippet = `class Foo {\n  bar() {}\n  baz() {}\n}`;
    const syms = parseFile(snippet, 'foo.ts', 'typescript');
    const tree = buildSymbolTree(syms);
    const cls = tree.find(n => n.symbol.name === 'Foo');
    assert.ok(cls, 'Foo not in tree');
    assert.ok(cls!.children.length >= 2, `expected >= 2 children, got ${cls!.children.length}`);
  });

  test('flattenTree produces depth-annotated list', () => {
    const snippet = `class A {\n  m() {}\n}\nfunction standalone() {}`;
    const syms = parseFile(snippet, 'a.ts', 'typescript');
    const tree = buildSymbolTree(syms);
    const flat = flattenTree(tree);
    const depths = flat.map(([, d]) => d);
    assert.ok(depths.some(d => d === 0), 'no root-level symbols');
    assert.ok(depths.some(d => d === 1), 'no nested symbols');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 13 — security unit tests
// ════════════════════════════════════════════════════════════════════════════

describe('security — validatePath', () => {
  test('allows path inside root', () => {
    assert.ok(validatePath('/tmp/testroot/foo/bar.ts', '/tmp/testroot'));
  });
  test('rejects path outside root', () => {
    assert.equal(validatePath('/tmp/other/file.ts', '/tmp/testroot'), false);
  });
  test('allows root itself', () => {
    assert.ok(validatePath('/tmp/testroot', '/tmp/testroot'));
  });
});

describe('security — isSecretFile', () => {
  const secret = ['.env', '.env.local', 'id_rsa', 'service-account.json', 'secrets.json', 'key.pem', 'cert.key'];
  const safe   = ['index.ts', 'main.go', 'README.md', 'config.json', 'utils.py'];
  for (const f of secret) { test(`"${f}" is secret`,     () => assert.ok(isSecretFile(f))); }
  for (const f of safe)   { test(`"${f}" is not secret`, () => assert.equal(isSecretFile(f), false)); }
});

describe('security — isBinaryExtension', () => {
  const binary = ['.exe', '.dll', '.so', '.png', '.jpg', '.zip', '.pdf', '.pyc', '.wasm'];
  const text   = ['.ts', '.js', '.py', '.go', '.rs', '.md', '.json', '.yaml'];
  for (const ext of binary) { test(`"${ext}" is binary`,     () => assert.ok(isBinaryExtension(`file${ext}`))); }
  for (const ext of text)   { test(`"${ext}" is not binary`, () => assert.equal(isBinaryExtension(`file${ext}`), false)); }
});

describe('security — shouldExcludeFile', () => {
  test('excludes secret file', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
    const f = path.join(d, '.env');
    fs.writeFileSync(f, 'S=1');
    assert.equal(shouldExcludeFile(f, d), 'secret_file');
    fs.rmSync(d, { recursive: true });
  });

  test('excludes oversized file', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
    const f = path.join(d, 'big.ts');
    fs.writeFileSync(f, 'x'.repeat(1024));
    assert.equal(shouldExcludeFile(f, d, 512), 'file_too_large');
    fs.rmSync(d, { recursive: true });
  });

  test('allows normal source file', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
    const f = path.join(d, 'main.ts');
    fs.writeFileSync(f, 'export function hello() {}');
    assert.equal(shouldExcludeFile(f, d), null);
    fs.rmSync(d, { recursive: true });
  });

  test('rejects path traversal', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
    assert.equal(shouldExcludeFile('/etc/passwd', d), 'path_traversal');
    fs.rmSync(d, { recursive: true });
  });
});

describe('security — env var defaults', () => {
  test('getMaxIndexFiles returns 500 by default', () => {
    delete process.env['ASTLLM_MAX_INDEX_FILES'];
    assert.equal(getMaxIndexFiles(), 500);
  });
  test('getMaxFileSizeBytes returns 512000 by default', () => {
    delete process.env['ASTLLM_MAX_FILE_SIZE_KB'];
    assert.equal(getMaxFileSizeBytes(), 500 * 1024);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14 — token tracker unit tests
// ════════════════════════════════════════════════════════════════════════════

describe('token_tracker', () => {
  test('estimateSavings: positive when raw > response', () => {
    assert.ok(estimateSavings(10000, 200) > 0);
  });
  test('estimateSavings: zero when response >= raw', () => {
    assert.equal(estimateSavings(100, 200), 0);
    assert.equal(estimateSavings(100, 100), 0);
  });
  test('estimateSavings: 4 bytes per token', () => {
    assert.equal(estimateSavings(4000, 0), 1000);
  });
  test('costAvoided: returns correct keys', () => {
    const r = costAvoided(1_000_000, 2_000_000);
    assert.ok('cost_avoided_claude_usd' in r);
    assert.ok('cost_avoided_gpt_usd' in r);
    assert.ok('total_cost_avoided_claude_usd' in r);
  });
  test('costAvoided: 1M tokens @ Opus = $15', () => {
    const r = costAvoided(1_000_000, 1_000_000);
    assert.equal(r['cost_avoided_claude_usd'], 15.0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 15 — IndexStore low-level unit tests
// ════════════════════════════════════════════════════════════════════════════

describe('IndexStore — low-level', () => {
  let store: IndexStore;
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astllm-store-'));
    store = new IndexStore(tmpDir);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('saveFile + getSymbolContent round-trip', () => {
    const content = 'export function hello() { return 42; }\n';
    store.saveFile('owner', 'repo', 'src/hello.ts', content);

    const syms = parseFile(content, 'src/hello.ts', 'typescript');
    const hello = syms.find(s => s.name === 'hello');
    assert.ok(hello, 'hello not parsed');

    // getSymbolContent needs a saved index to look up the symbol by id
    const index = {
      version: 2 as const,
      repo: 'repo',
      owner: 'owner',
      indexed_at: new Date().toISOString(),
      symbols: syms,
      file_hashes: { 'src/hello.ts': 'abc' },
    };
    store.saveIndex('owner', 'repo', index);

    const retrieved = store.getSymbolContent('owner', 'repo', hello!.id);
    assert.ok(retrieved !== null, 'getSymbolContent returned null');
    assert.ok(retrieved!.includes('hello'), `missing "hello" in: ${retrieved}`);
  });

  test('detectChanges identifies added / changed / deleted / unchanged files', () => {
    const existing = {
      version: 2 as const,
      repo: 'repo',
      owner: 'owner',
      indexed_at: new Date().toISOString(),
      symbols: [],
      file_hashes: {
        'unchanged.ts': 'abc',
        'changed.ts':   'old',
        'deleted.ts':   'xyz',
      },
    };
    const newHashes = {
      'unchanged.ts': 'abc',
      'changed.ts':   'new',
      'added.ts':     '123',
    };

    const changes = store.detectChanges(existing, newHashes);
    assert.deepEqual(changes.changed, ['changed.ts']);
    assert.deepEqual(changes.added,   ['added.ts']);
    assert.deepEqual(changes.deleted, ['deleted.ts']);
    // unchanged is not returned by detectChanges — only the delta is reported
  });
});
