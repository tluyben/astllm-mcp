# CLAUDE.md — astllm-mcp

TypeScript MCP server that indexes codebases with tree-sitter and exposes 11 tools for token-efficient symbol retrieval.

## Build & run

```bash
# Install (CXXFLAGS required on Node.js v22+ for native tree-sitter)
CXXFLAGS="-std=c++20" npm install --legacy-peer-deps

# Compile TypeScript
npm run build

# Run (stdio MCP server)
node dist/index.js

# Dev (no compile step)
npm run dev
```

## Project layout

```
src/
  index.ts                    MCP server, tool dispatch, logging
  security.ts                 Path validation, secret/binary detection
  parser/
    symbols.ts                CodeSymbol interface, makeSymbolId, disambiguateOverloads
    languages.ts              LanguageSpec configs for all 12 languages
    hierarchy.ts              buildSymbolTree, flattenTree (SymbolNode tree)
    extractor.ts              tree-sitter AST walker → CodeSymbol[]
  storage/
    index_store.ts            IndexStore class: save/load/search/detect-changes
    token_tracker.ts          estimateSavings, recordSavings, costAvoided
  summarizer/
    batch_summarize.ts        3-tier: docstring → Anthropic/Gemini/OpenAI → signature
  tools/
    _utils.ts                 resolveRepo(), makeMeta()
    index_folder.ts           Local folder indexing
    index_repo.ts             GitHub repo indexing (fetch + parse)
    list_repos.ts
    get_file_tree.ts
    get_file_outline.ts
    get_repo_outline.ts
    get_symbol.ts             get_symbol + get_symbols
    search_symbols.ts
    search_text.ts
    invalidate_cache.ts
```

## Code search

An astllm-mcp index is available for this project. Prefer MCP tools over Grep/Glob/Read for all code exploration:

- `search_symbols` — find functions, classes, methods by name (use this first)
- `get_file_outline` — list all symbols in a file before deciding to read it
- `get_repo_outline` — understand project structure without reading files
- `get_symbol` — read a specific function/class source (O(1), much cheaper than reading the file)
- `get_symbols` — batch-read multiple symbols in one call
- `search_text` — full-text search for strings, comments, config values
- `get_file_tree` — browse directory structure with symbol counts

Only fall back to Grep/Read when the MCP tools cannot cover the case (e.g. a file type not indexed by tree-sitter).


## Critical architectural facts

### 1. tree-sitter startIndex is a CHARACTER index, not bytes

`node.startIndex` from tree-sitter (when parsing a JS string) is a character index in the string, **not** a UTF-8 byte offset. Files with multi-byte characters (e.g. `─` U+2500 = 3 UTF-8 bytes, used in section header comments) cause divergence.

**Fix in `extractor.ts` `buildSymbol()`:**
```typescript
const byteOffset = Buffer.byteLength(content.slice(0, outerNode.startIndex), 'utf8');
const byteLength = Buffer.byteLength(content.slice(outerNode.startIndex, outerNode.endIndex), 'utf8');
```

Never store `node.startIndex` directly as a byte offset. Always convert.

### 2. ESM module system

The project is `"type": "module"`. All local imports use `.js` extensions:
```typescript
import { CodeSymbol } from './symbols.js';      // correct
import { CodeSymbol } from './symbols';          // wrong — breaks at runtime
```

### 3. tree-sitter grammars are CJS — use createRequire

The `tree-sitter-*` packages are CommonJS. Load them from ESM using `createRequire`:
```typescript
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const JavaScript = _require('tree-sitter-javascript');
```
Never use `import` for tree-sitter grammar packages — they'll fail.

### 4. @modelcontextprotocol/sdk import paths

SDK 1.27+ is ESM. These are the valid import paths:
```typescript
import { Server } from '@modelcontextprotocol/sdk/server';           // explicit export
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';  // via wildcard
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';        // via wildcard
```
The `.js` extension in wildcard paths is required — it maps through `"./*"` → `"./dist/esm/*"`.

### 5. Symbol IDs

Format: `file/path::qualified.Name#kind`

- Scope separator: `.` for most languages, `::` for Rust/Go/C/C++
- Overloaded symbols get `~1`, `~2` suffixes via `disambiguateOverloads()`
- IDs are stable across re-indexing (no hashing, just path + name + kind)

### 6. Storage layout

```
~/.code-index/<owner>/<repo>/
  index.json      # version, symbols[], file_hashes{}
  files/          # raw UTF-8 file copies (for byte-offset seeking)
```

`getSymbolContent()` uses `fs.readSync(fd, buf, 0, byte_length, byte_offset)` for O(1) retrieval. This is why correct byte offsets are critical.

### 7. Incremental indexing

Uses file content SHA-256 hashes (for local) or git tree SHA (for GitHub) to detect changes. Only re-parses modified/new files. `detectChanges()` → `incrementalSave()` pattern.

## Startup behaviour

On startup, `main()` in `src/index.ts`:
1. **Auto-indexes `process.cwd()`** incrementally in the background (non-blocking, always on)
2. **Watches for file changes** if `ASTLLM_WATCH=1` — uses `fs.watch(cwd, { recursive: true })`, filters to extensions in `EXTENSION_TO_LANGUAGE`, debounces 500ms, then incremental re-index. Requires Node.js v22+ on Linux for recursive watch support.
3. **Persists index** if `ASTLLM_PERSIST=1` — on startup, pre-loads `~/.astllm/{encoded-path}.json` into `IndexStore` before running incremental index (fast warm start). After every index (startup + watcher), writes the updated `CodeIndex` back to that file. Path encoding: `/home/user/proj` → `-home-user-proj.json`.

## Adding a new language

1. Add extensions to `EXTENSION_TO_LANGUAGE` in `languages.ts`
2. Add a `LanguageSpec` entry in `LANGUAGE_SPECS`
3. Add a `case` to `loadLanguage()` in `extractor.ts`
4. Install the grammar: `npm install tree-sitter-<lang>`
5. Handle any special AST structure in `walkNode()` if needed (see Go/Rust/Python special cases)

## Adding a new MCP tool

1. Create `src/tools/my_tool.ts` — export an async/sync function returning `Record<string, unknown>`
2. Import in `src/index.ts`
3. Add tool definition to `ListToolsRequestSchema` handler (name, description, inputSchema)
4. Add `case 'my_tool':` to `CallToolRequestSchema` handler

## Common mistakes to avoid

- **Do not** use `node.startIndex` directly as a byte offset — always convert via `Buffer.byteLength(content.slice(0, idx), 'utf8')`
- **Do not** import local files without `.js` extension
- **Do not** use `require()` in ESM files — use `createRequire` for CJS packages
- **Do not** use `import` for tree-sitter grammar packages — they're CJS
- **Do not** change `"type": "module"` in package.json — the SDK requires ESM

## Testing

No test framework is set up. Test manually via stdio JSON-RPC:

```bash
# Index this project
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"index_folder","arguments":{"folder_path":"/path/to/src"}}}' | node dist/index.js

# List repos
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_repos","arguments":{}}}' | node dist/index.js

# Search symbols
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_symbols","arguments":{"repo":"local/src","query":"parseFile"}}}' | node dist/index.js
```

## Environment variables that affect behaviour

```
CODE_INDEX_PATH              Override ~/.code-index storage location
GITHUB_TOKEN                 GitHub API auth (private repos, higher rate limits)
ASTLLM_MAX_INDEX_FILES    File limit per repo (default 500)
ASTLLM_MAX_FILE_SIZE_KB   Per-file size limit (default 500 KB)
ASTLLM_LOG_LEVEL          debug | info | warn | error
ASTLLM_LOG_FILE           Log to file instead of stderr
ANTHROPIC_API_KEY            Enable Claude Haiku summarization
GOOGLE_API_KEY               Enable Gemini Flash summarization
OPENAI_BASE_URL              Enable local LLM summarization (Ollama etc.)
ASTLLM_WATCH              Auto-reindex on source file changes (default off; set 1 or true to enable)
ASTLLM_PERSIST            Persist index to ~/.astllm/{encoded-path}.json after every index and pre-load on startup (default off; set 1 or true to enable)
```
