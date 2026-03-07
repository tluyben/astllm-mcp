#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { indexRepo } from './tools/index_repo.js';
import { indexFolder } from './tools/index_folder.js';
import { IndexStore } from './storage/index_store.js';
import { EXTENSION_TO_LANGUAGE } from './parser/languages.js';
import { listRepos } from './tools/list_repos.js';
import { getFileTree } from './tools/get_file_tree.js';
import { getFileOutline } from './tools/get_file_outline.js';
import { getRepoOutline } from './tools/get_repo_outline.js';
import { getSymbol, getSymbols } from './tools/get_symbol.js';
import { searchSymbols } from './tools/search_symbols.js';
import { searchText } from './tools/search_text.js';
import { invalidateCache } from './tools/invalidate_cache.js';

// Configure logging
const logLevel = (process.env['ASTLLM_LOG_LEVEL'] ?? 'warn').toLowerCase();
const logFile = process.env['ASTLLM_LOG_FILE'];

function log(level: string, msg: string, data?: unknown): void {
  const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((levels[level] ?? 1) < (levels[logLevel] ?? 2)) return;
  const entry = `[${level.toUpperCase()}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  if (logFile) {
    try {
      fs.appendFileSync(logFile, entry + '\n');
    } catch { /* */ }
  } else if (level === 'error') {
    process.stderr.write(entry + '\n');
  }
}

const server = new Server(
  { name: 'astllm-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'index_repo',
      description: 'Index a GitHub repository\'s source code. Fetches files, parses ASTs with tree-sitter, extracts symbols (functions, classes, methods, types), and saves to local storage for fast retrieval.',
      inputSchema: {
        type: 'object',
        properties: {
          repo_url: { type: 'string', description: 'GitHub repo URL or owner/repo slug, e.g. "https://github.com/owner/repo" or "owner/repo"' },
          generate_summaries: { type: 'boolean', default: false, description: 'Generate one-line AI summaries for each symbol (requires API key)' },
          incremental: { type: 'boolean', default: true, description: 'Only re-index changed files (faster for repeat indexing)' },
          storage_path: { type: 'string', description: 'Custom storage directory (default: ~/.code-index)' },
        },
        required: ['repo_url'],
      },
    },
    {
      name: 'index_folder',
      description: 'Index a local source code folder. Recursively discovers source files, parses ASTs, and stores symbols for fast retrieval.',
      inputSchema: {
        type: 'object',
        properties: {
          folder_path: { type: 'string', description: 'Absolute or relative path to the local folder to index' },
          generate_summaries: { type: 'boolean', default: false, description: 'Generate one-line AI summaries for each symbol' },
          extra_ignore_patterns: { type: 'array', items: { type: 'string' }, description: 'Additional gitignore-style patterns to exclude' },
          follow_symlinks: { type: 'boolean', default: false, description: 'Follow symbolic links when discovering files' },
          incremental: { type: 'boolean', default: true, description: 'Only re-index changed files' },
          storage_path: { type: 'string', description: 'Custom storage directory' },
        },
        required: ['folder_path'],
      },
    },
    {
      name: 'list_repos',
      description: 'List all indexed repositories with metadata (file count, symbol count, last indexed time).',
      inputSchema: {
        type: 'object',
        properties: {
          storage_path: { type: 'string', description: 'Custom storage directory' },
        },
      },
    },
    {
      name: 'get_file_tree',
      description: 'Get the file/directory structure of an indexed repository. Much cheaper than reading files — returns the tree with per-file language and symbol counts.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository identifier: "owner/repo" or just "repo" if unique' },
          path_prefix: { type: 'string', default: '', description: 'Filter to a specific directory path' },
          include_summaries: { type: 'boolean', default: false, description: 'Include per-file summary (if available)' },
          storage_path: { type: 'string' },
        },
        required: ['repo'],
      },
    },
    {
      name: 'get_file_outline',
      description: 'Get all symbols in a specific file as a hierarchical outline (classes containing methods, etc.). Much cheaper than reading the file.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository identifier' },
          file_path: { type: 'string', description: 'File path relative to repo root, e.g. "src/auth/login.ts"' },
          storage_path: { type: 'string' },
        },
        required: ['repo', 'file_path'],
      },
    },
    {
      name: 'get_repo_outline',
      description: 'Get a high-level overview of an indexed repository: directory tree, file counts, language breakdown, symbol kind distribution.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository identifier' },
          storage_path: { type: 'string' },
        },
        required: ['repo'],
      },
    },
    {
      name: 'get_symbol',
      description: 'Get the full source code of a specific symbol (function, class, method, etc.) by its ID. Uses byte-offset seeking for O(1) retrieval — much cheaper than reading the entire file.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository identifier' },
          symbol_id: { type: 'string', description: 'Symbol ID from get_file_outline or search_symbols, e.g. "src/auth.ts::login#function"' },
          verify: { type: 'boolean', default: false, description: 'Verify content hash matches stored hash (drift detection)' },
          context_lines: { type: 'number', default: 0, description: 'Number of lines of context to include before/after the symbol (0–50)' },
          storage_path: { type: 'string' },
        },
        required: ['repo', 'symbol_id'],
      },
    },
    {
      name: 'get_symbols',
      description: 'Get full source code for multiple symbols in one call. More efficient than multiple get_symbol calls.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository identifier' },
          symbol_ids: { type: 'array', items: { type: 'string' }, description: 'List of symbol IDs to retrieve' },
          storage_path: { type: 'string' },
        },
        required: ['repo', 'symbol_ids'],
      },
    },
    {
      name: 'search_symbols',
      description: 'Search for symbols by name, kind, language, or file pattern across the indexed repository. Returns matching symbols with signatures and summaries — no source code loaded unless you call get_symbol.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository identifier' },
          query: { type: 'string', description: 'Search query (name, partial name, or keyword)' },
          kind: { type: 'string', enum: ['function', 'class', 'method', 'type', 'constant', 'interface'], description: 'Filter by symbol kind' },
          file_pattern: { type: 'string', description: 'Glob-style file pattern, e.g. "src/**/*.ts"' },
          language: { type: 'string', description: 'Filter by language (python, typescript, go, rust, java, etc.)' },
          limit: { type: 'number', default: 50, description: 'Max results (1–100)' },
          storage_path: { type: 'string' },
        },
        required: ['repo', 'query'],
      },
    },
    {
      name: 'search_text',
      description: 'Full-text search across indexed file contents. Useful for finding string literals, comments, configuration values, or patterns not captured as symbols.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository identifier' },
          query: { type: 'string', description: 'Text to search for (case-insensitive substring match)' },
          file_pattern: { type: 'string', description: 'Glob-style file pattern to restrict search' },
          limit: { type: 'number', default: 100, description: 'Max matching lines to return' },
          storage_path: { type: 'string' },
        },
        required: ['repo', 'query'],
      },
    },
    {
      name: 'invalidate_cache',
      description: 'Delete the index for a repository, forcing a full re-index on the next index_repo or index_folder call.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository identifier to invalidate' },
          storage_path: { type: 'string' },
        },
        required: ['repo'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;
  log('debug', `Tool call: ${name}`, args);

  const a = args as Record<string, unknown>;

  try {
    let result: Record<string, unknown>;

    switch (name) {
      case 'index_repo':
        result = await indexRepo(
          String(a['repo_url']),
          Boolean(a['generate_summaries'] ?? false),
          Boolean(a['incremental'] ?? true),
          (a['storage_path'] as string | null) ?? null,
        );
        break;

      case 'index_folder':
        result = await indexFolder(
          String(a['folder_path']),
          Boolean(a['generate_summaries'] ?? false),
          (a['extra_ignore_patterns'] as string[] | null) ?? [],
          Boolean(a['follow_symlinks'] ?? false),
          Boolean(a['incremental'] ?? true),
          (a['storage_path'] as string | null) ?? null,
        );
        break;

      case 'list_repos':
        result = listRepos((a['storage_path'] as string | null) ?? null);
        break;

      case 'get_file_tree':
        result = getFileTree(
          String(a['repo']),
          String(a['path_prefix'] ?? ''),
          Boolean(a['include_summaries'] ?? false),
          (a['storage_path'] as string | null) ?? null,
        );
        break;

      case 'get_file_outline':
        result = getFileOutline(
          String(a['repo']),
          String(a['file_path']),
          (a['storage_path'] as string | null) ?? null,
        );
        break;

      case 'get_repo_outline':
        result = getRepoOutline(
          String(a['repo']),
          (a['storage_path'] as string | null) ?? null,
        );
        break;

      case 'get_symbol':
        result = getSymbol(
          String(a['repo']),
          String(a['symbol_id']),
          Boolean(a['verify'] ?? false),
          Number(a['context_lines'] ?? 0),
          (a['storage_path'] as string | null) ?? null,
        );
        break;

      case 'get_symbols':
        result = getSymbols(
          String(a['repo']),
          (a['symbol_ids'] as string[]),
          (a['storage_path'] as string | null) ?? null,
        );
        break;

      case 'search_symbols':
        result = searchSymbols(
          String(a['repo']),
          String(a['query']),
          a['kind'] ? String(a['kind']) : undefined,
          a['file_pattern'] ? String(a['file_pattern']) : undefined,
          a['language'] ? String(a['language']) : undefined,
          Number(a['limit'] ?? 50),
          (a['storage_path'] as string | null) ?? null,
        );
        break;

      case 'search_text':
        result = searchText(
          String(a['repo']),
          String(a['query']),
          a['file_pattern'] ? String(a['file_pattern']) : undefined,
          Number(a['limit'] ?? 100),
          (a['storage_path'] as string | null) ?? null,
        );
        break;

      case 'invalidate_cache':
        result = invalidateCache(
          String(a['repo']),
          (a['storage_path'] as string | null) ?? null,
        );
        break;

      default:
        result = { error: `Unknown tool: ${name}` };
    }

    log('debug', `Tool result: ${name}`, { success: !result['error'] });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    log('error', `Tool error: ${name}`, err);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: String(err) }, null, 2) }],
      isError: true,
    };
  }
});

const WATCHED_EXTENSIONS = new Set(Object.keys(EXTENSION_TO_LANGUAGE));

// ─── Persistence helpers ──────────────────────────────────────────────────────

const PERSIST_DIR = path.join(os.homedir(), '.astllm');

function persistFilePath(cwd: string): string {
  // /home/tycho/project → -home-tycho-project.json
  return path.join(PERSIST_DIR, cwd.replace(/\//g, '-') + '.json');
}

function cwdToRepoName(cwd: string): string {
  // Mirrors indexFolder's owner/name derivation: owner='local', name=basename
  return path.basename(cwd) || 'unknown';
}

function loadPersistedIndex(cwd: string): void {
  const file = persistFilePath(cwd);
  if (!fs.existsSync(file)) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    new IndexStore(null).saveIndex('local', cwdToRepoName(cwd), data);
    log('info', `Loaded persisted index from ${file}`);
  } catch (err) {
    log('warn', `Failed to load persisted index from ${file}`, String(err));
  }
}

function savePersistIndex(cwd: string): void {
  try {
    const index = new IndexStore(null).loadIndex('local', cwdToRepoName(cwd));
    if (!index) return;
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    const file = persistFilePath(cwd);
    fs.writeFileSync(file, JSON.stringify(index), 'utf8');
    log('info', `Persisted index to ${file}`);
  } catch (err) {
    log('warn', `Failed to persist index`, String(err));
  }
}

function watchCwd(cwd: string, persist: boolean): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(cwd, { recursive: true });
  } catch (err) {
    log('warn', `fs.watch not supported on this platform/Node version, file watching disabled`, String(err));
    return;
  }

  watcher.on('change', (_event, filename) => {
    if (typeof filename !== 'string') return;
    if (!WATCHED_EXTENSIONS.has(path.extname(filename))) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      log('info', `File change detected, re-indexing ${cwd}`);
      indexFolder(cwd, false, [], false, true, null).then(result => {
        log('info', `Re-indexed ${cwd}`, {
          files: result['file_count'],
          symbols: result['symbol_count'],
        });
        if (persist) savePersistIndex(cwd);
      }).catch(err => {
        log('warn', `Re-index of ${cwd} failed`, String(err));
      });
    }, 500);
  });

  watcher.on('error', err => {
    log('warn', `File watcher error`, String(err));
  });

  log('info', `Watching ${cwd} for source file changes`);
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', 'astllm-mcp server running on stdio');

  const cwd = process.cwd();

  const persistEnv = (process.env['ASTLLM_PERSIST'] ?? '').toLowerCase();
  const persist = persistEnv === '1' || persistEnv === 'true';

  // If persistence is on, pre-load the saved index so incremental diff is fast
  if (persist) loadPersistedIndex(cwd);

  // Auto-index the working directory in the background (incremental, non-blocking)
  indexFolder(cwd, false, [], false, true, null).then(result => {
    log('info', `Auto-indexed ${cwd}`, {
      files: result['file_count'],
      symbols: result['symbol_count'],
    });
    if (persist) savePersistIndex(cwd);
  }).catch(err => {
    log('warn', `Auto-index of ${cwd} failed`, String(err));
  });

  // Optional file watching (ASTLLM_WATCH=1 to enable, default off)
  const watchEnv = (process.env['ASTLLM_WATCH'] ?? '').toLowerCase();
  if (watchEnv === '1' || watchEnv === 'true') {
    watchCwd(cwd, persist);
  }
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
