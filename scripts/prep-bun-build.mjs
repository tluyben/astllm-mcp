#!/usr/bin/env node
// Prepares tree-sitter core for `bun build --compile`.
//
// The tree-sitter npm package compiles from source on install (no prebuilds
// shipped in the tarball). But its Bun-specific loading path expects:
//   node_modules/tree-sitter/prebuilds/{platform}-{arch}/tree-sitter.node
//
// This script copies the locally-compiled binary into that location so Bun
// can find and embed it. Run this on the TARGET platform before building.

import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch } from 'process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsDir = join(root, 'node_modules', 'tree-sitter');
const src   = join(tsDir, 'build', 'Release', 'tree_sitter_runtime_binding.node');
const dest  = join(tsDir, 'prebuilds', `${platform}-${arch}`, 'tree-sitter.node');

if (!existsSync(src)) {
  console.error(`ERROR: tree-sitter native binary not found at:\n  ${src}`);
  console.error('Run:  CXXFLAGS="-std=c++20" npm install --legacy-peer-deps');
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`tree-sitter prebuild ready: prebuilds/${platform}-${arch}/tree-sitter.node`);
