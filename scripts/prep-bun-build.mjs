#!/usr/bin/env node
// Prepares tree-sitter native binaries for `bun build --compile`.
//
// Bun's loading path expects locally-compiled .node files at:
//   node_modules/<pkg>/prebuilds/{platform}-{arch}/<pkg>.node
//
// Some npm prebuilds ship incorrect binaries for certain platforms (e.g.
// tree-sitter-typescript ships x86-64 binaries in its linux-arm64 slot).
// This script replaces any locally-compiled binaries over the prebuilt slots
// so Bun embeds the correct native code for the current platform.
//
// Run this on the TARGET platform before building.

import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch } from 'process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function prep(pkg, srcName, destName) {
  const pkgDir = join(root, 'node_modules', pkg);
  const src    = join(pkgDir, 'build', 'Release', srcName);
  const dest   = join(pkgDir, 'prebuilds', `${platform}-${arch}`, destName);
  if (!existsSync(src)) return false;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`${pkg}: prebuilds/${platform}-${arch}/${destName} ← local build`);
  return true;
}

// tree-sitter core (always required — no prebuilds shipped in npm tarball)
if (!prep('tree-sitter', 'tree_sitter_runtime_binding.node', 'tree-sitter.node')) {
  console.error('ERROR: tree-sitter native binary not found. Run: CXXFLAGS="-std=c++20" npm install --legacy-peer-deps');
  process.exit(1);
}

// Grammar packages: copy local builds over prebuilts when available.
// Some npm-published linux-arm64 prebuilds are actually x86-64 binaries.
prep('tree-sitter-typescript', 'tree_sitter_typescript_binding.node', 'tree-sitter-typescript.node');
prep('tree-sitter-java',       'tree_sitter_java_binding.node',       'tree-sitter-java.node');
prep('tree-sitter-cpp',        'tree_sitter_cpp_binding.node',        'tree-sitter-cpp.node');
prep('tree-sitter-c-sharp',    'tree_sitter_c_sharp_binding.node',    'tree-sitter-c-sharp.node');

// Patch tree-sitter/index.js: bun's NAPI returns language objects with non-writable
// properties. Replace the direct assignment with Object.defineProperty so it works
// in both Node.js and bun compiled binaries.
const tsIndexPath = join(root, 'node_modules', 'tree-sitter', 'index.js');
const tsIndex = readFileSync(tsIndexPath, 'utf8');
const patched = tsIndex
  .replace(
    'language.nodeSubclasses = nodeSubclasses',
    'Object.defineProperty(language, "nodeSubclasses", { value: nodeSubclasses, writable: true, configurable: true })'
  )
  .replace(
    'nodeSubclass.prototype.type = typeName;',
    'try { nodeSubclass.prototype.type = typeName; } catch { Object.defineProperty(nodeSubclass.prototype, "type", { value: typeName, writable: true, configurable: true }); }'
  )
  .replace(
    'nodeSubclass.prototype.fields = Object.freeze(fieldNames.sort())',
    'try { nodeSubclass.prototype.fields = Object.freeze(fieldNames.sort()); } catch { Object.defineProperty(nodeSubclass.prototype, "fields", { value: Object.freeze(fieldNames.sort()), writable: true, configurable: true }); }'
  );
if (patched !== tsIndex) {
  writeFileSync(tsIndexPath, patched, 'utf8');
  console.log('tree-sitter/index.js: patched language.nodeSubclasses assignment for bun compatibility');
} else {
  console.log('tree-sitter/index.js: already patched or pattern not found');
}
