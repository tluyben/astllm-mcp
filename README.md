# astllm-mcp

MCP server for efficient code indexing and symbol retrieval. Index GitHub repos or local folders once with tree-sitter AST parsing, then let AI agents retrieve only the specific symbols they need — instead of loading entire files.

**Cut code-reading token costs by up to 99%.**

## How it works

1. **Index** — fetch source files, parse ASTs with tree-sitter, store symbols with byte offsets
2. **Explore** — browse file trees and outlines without touching file content
3. **Retrieve** — fetch only the exact function/class/method you need via O(1) byte-offset seek
4. **Savings** — every response reports tokens saved vs loading raw files

The index is stored locally in `~/.code-index/` (configurable). Incremental re-indexing only re-parses changed files.

The server **automatically indexes the working directory on startup** (incremental, non-blocking). Optionally set `ASTLLM_WATCH=1` to also watch for file changes and re-index automatically.

## Supported languages

Python, JavaScript, TypeScript, TSX, Go, Rust, Java, PHP, Dart, C#, C, C++

## Installation

Requires Node.js 18+ and a C++20-capable compiler (for tree-sitter native bindings).

```bash
git clone <this-repo>
cd astllm-mcp
CXXFLAGS="-std=c++20" npm install --legacy-peer-deps
npm run build
```

> **Note on Node.js v22+**: The `CXXFLAGS="-std=c++20"` flag is required because Node.js v22+ v8 headers mandate C++20. The `--legacy-peer-deps` flag is needed because tree-sitter grammar packages target slightly different tree-sitter core versions.

## MCP client configuration

### Claude Code

Add to your MCP config (usually `~/.claude/claude_code_config.json` or via `/mcp add`):

```json
{
  "mcpServers": {
    "astllm": {
      "command": "node",
      "args": ["/path/to/astllm-mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "astllm": {
      "command": "node",
      "args": ["/path/to/astllm-mcp/dist/index.js"]
    }
  }
}
```

## Tools

### Indexing

#### `index_repo`
Index a GitHub repository. Fetches source files via the GitHub API, parses ASTs, stores symbols locally.

```
repo_url            GitHub URL or "owner/repo" slug
generate_summaries  Generate one-line AI summaries (requires API key, default: false)
incremental         Only re-index changed files (default: true)
storage_path        Custom storage directory
```

#### `index_folder`
Index a local folder recursively.

```
folder_path             Path to index
generate_summaries      AI summaries (default: false)
extra_ignore_patterns   Additional gitignore-style patterns
follow_symlinks         Follow symlinks (default: false)
incremental             Only re-index changed files (default: true)
storage_path            Custom storage directory
```

### Navigation

#### `list_repos`
List all indexed repositories with file count, symbol count, and last-indexed time.

#### `get_repo_outline`
High-level overview: directory breakdown, language distribution, symbol kind counts.

```
repo    Repository identifier ("owner/repo" or short name if unique)
```

#### `get_file_tree`
File and directory structure with per-file language and symbol count. Much cheaper than reading files.

```
repo             Repository identifier
path_prefix      Filter to a subdirectory
include_summaries  Include per-file summaries
```

#### `get_file_outline`
All symbols in a file as a hierarchical tree (methods nested under their class).

```
repo       Repository identifier
file_path  File path relative to repo root
```

### Retrieval

#### `get_symbol`
Full source code for a single symbol, retrieved by byte-offset seek (O(1)).

```
repo          Repository identifier
symbol_id     Symbol ID from get_file_outline or search_symbols
verify        Check content hash for drift detection (default: false)
context_lines Lines of context around the symbol (0–50, default: 0)
```

#### `get_symbols`
Batch retrieval of multiple symbols in one call.

```
repo        Repository identifier
symbol_ids  Array of symbol IDs
```

### Search

#### `search_symbols`
Search symbols by name, kind, language, or file pattern. Returns signatures and summaries — no source loaded until you call `get_symbol`.

```
repo          Repository identifier
query         Search query
kind          Filter: function | class | method | type | constant | interface
file_pattern  Glob pattern, e.g. "src/**/*.ts"
language      Filter by language
limit         Max results 1–100 (default: 50)
```

#### `search_text`
Full-text search across indexed file contents. Useful for string literals, comments, config values.

```
repo          Repository identifier
query         Case-insensitive substring
file_pattern  Glob pattern to restrict files
limit         Max matching lines (default: 100)
```

### Cache

#### `invalidate_cache`
Delete a repository's index, forcing full re-index on next operation.

```
repo    Repository identifier
```

## Symbol IDs

Symbol IDs have the format `file/path::qualified.Name#kind`, for example:

```
src/auth/login.ts::AuthService.login#method
src/utils.go::parseURL#function
lib/models.py::User#class
```

Get IDs from `get_file_outline` or `search_symbols`, then pass them to `get_symbol`.

## Token savings

Every response includes a `_meta` envelope:

```json
{
  "_meta": {
    "timing_ms": 2.1,
    "tokens_saved": 14823,
    "total_tokens_saved": 89412,
    "cost_avoided_claude_usd": 0.222345,
    "cost_avoided_gpt_usd": 0.148230,
    "total_cost_avoided_claude_usd": 1.34118
  }
}
```


## AI summaries (optional)

Set one of these environment variables to enable one-line symbol summaries:

```bash
# Anthropic Claude Haiku (recommended)
export ANTHROPIC_API_KEY=sk-ant-...

# Google Gemini Flash
export GOOGLE_API_KEY=...

# OpenAI-compatible (Ollama, etc.)
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=llama3
```

Summaries use a three-tier fallback: docstring first-line → AI → signature.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CODE_INDEX_PATH` | `~/.code-index` | Index storage directory |
| `GITHUB_TOKEN` | — | GitHub API token (higher rate limits, private repos) |
| `ASTLLM_MAX_INDEX_FILES` | `500` | Max files to index per repo |
| `ASTLLM_MAX_FILE_SIZE_KB` | `500` | Max file size to index (KB) |
| `ASTLLM_LOG_LEVEL` | `warn` | Log level: debug, info, warn, error |
| `ASTLLM_LOG_FILE` | — | Log to file instead of stderr |
| `ASTLLM_WATCH` | `0` | Watch working directory for source file changes and re-index automatically (`1` or `true` to enable) |
| `ASTLLM_PERSIST` | `0` | Persist the index to `~/.astllm/{path}.json` after every index, and pre-load it on startup (`1` or `true` to enable) |
| `ANTHROPIC_API_KEY` | — | Enable Claude Haiku summaries |
| `GOOGLE_API_KEY` | — | Enable Gemini Flash summaries |
| `OPENAI_BASE_URL` | — | Enable local LLM summaries |

> Legacy `JASTLLM_*` variable names are also accepted for compatibility with the original Python version's indexes.

## Telling Claude to use this MCP

By default Claude will use `Grep`/`Glob`/`Read` to explore code. To make it prefer the MCP tools, add the following to your **project's `CLAUDE.md`**:

```markdown
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
```

The repo identifier to pass to MCP tools is `local/<folder-name>` for locally indexed folders (e.g. `local/src`). Use `list_repos` if unsure.

## Security

- Path traversal and symlink-escape protection
- Secret files excluded (`.env`, `*.pem`, `*.key`, credentials, etc.)
- Binary files excluded by extension and content sniffing
- File size limits enforced before reading

## Development

```bash
npm run build   # compile TypeScript → dist/
npm run dev     # run directly with tsx (no compile step)
```

The project is TypeScript ESM. All local imports use `.js` extensions (TypeScript NodeNext resolution).

## Storage layout

```
~/.code-index/
  <owner>/
    <repo>/
      index.json        # symbol index with byte offsets
      files/            # raw file copies for byte-offset seeking
        src/
          auth.ts
          ...
  _savings.json         # cumulative token savings
```
