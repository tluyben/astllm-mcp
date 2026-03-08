// CJS shim: literal require() calls here are statically traceable by bun's bundler,
// ensuring grammar packages are embedded in `bun build --compile` output.
// Imported as a side-effect from extractor.ts.

function tryReq(fn: () => unknown): unknown {
  try { return fn(); } catch { return null; }
}

// Use module.exports (not TypeScript export=) for Node.js v24 strip-only compatibility.
module.exports = {
  typescript:  tryReq(() => require('tree-sitter-typescript')),
  javascript:  tryReq(() => require('tree-sitter-javascript')),
  python:      tryReq(() => require('tree-sitter-python')),
  go:          tryReq(() => require('tree-sitter-go')),
  rust:        tryReq(() => require('tree-sitter-rust')),
  java:        tryReq(() => require('tree-sitter-java')),
  php:         tryReq(() => require('tree-sitter-php')),
  c:           tryReq(() => require('tree-sitter-c')),
  cpp:         tryReq(() => require('tree-sitter-cpp')),
  csharp:      tryReq(() => require('tree-sitter-c-sharp')),
  dart:        tryReq(() => require('@sengac/tree-sitter-dart')),
  swift:       tryReq(() => require('tree-sitter-swift')),
};
