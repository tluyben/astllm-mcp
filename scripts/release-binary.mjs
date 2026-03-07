#!/usr/bin/env node
// Upload a platform binary to the GitHub release for the current package version.
// Usage: node scripts/release-binary.mjs <platform>
// Platforms: macosx-arm | linux-x86 | linux-arm

import { createReadStream, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg  = JSON.parse(await import('fs').then(f => f.promises.readFile(join(root, 'package.json'), 'utf8')));

const REPO  = 'tluyben/astllm-mcp';
const TAG   = `v${pkg.version}`;

// ── Validate args ─────────────────────────────────────────────────────────────

const platform = process.argv[2];
if (!['macosx-arm', 'linux-x86', 'linux-arm'].includes(platform)) {
  console.error('Usage: node scripts/release-binary.mjs <macosx-arm|linux-x86|linux-arm>');
  process.exit(1);
}

// ── Check token ───────────────────────────────────────────────────────────────

const token = process.env['GITHUB_TOKEN'];
if (!token) {
  console.error(`
ERROR: GITHUB_TOKEN is not set.

To upload release assets you need a GitHub personal access token with repo scope:
  1. Go to https://github.com/settings/tokens/new
  2. Give it a name, set expiry, tick the "repo" scope
  3. Copy the token and run:

       export GITHUB_TOKEN=ghp_your_token_here
       npm run release:${platform}
`);
  process.exit(1);
}

// ── Check binary exists ───────────────────────────────────────────────────────

const binaryName = `astllm-mcp-${platform}`;
const binaryPath = join(root, 'dist', binaryName);
if (!existsSync(binaryPath)) {
  console.error(`Binary not found: dist/${binaryName}`);
  console.error(`Build it first:  npm run build:${platform}`);
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept:        'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent':  'astllm-mcp-release-script',
};

// ── Fetch release ─────────────────────────────────────────────────────────────

console.log(`Looking up release ${TAG} on ${REPO}...`);
const releaseRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers });

if (!releaseRes.ok) {
  const body = await releaseRes.text();
  if (releaseRes.status === 404) {
    console.error(`Release ${TAG} not found on GitHub.`);
    console.error(`Create it at: https://github.com/${REPO}/releases/new?tag=${TAG}`);
  } else {
    console.error(`GitHub API error ${releaseRes.status}: ${body}`);
  }
  process.exit(1);
}

const release = await releaseRes.json();
const uploadUrl = release.upload_url.replace('{?name,label}', '');

// ── Delete existing asset if present (allow re-upload) ────────────────────────

const existing = release.assets?.find(a => a.name === binaryName);
if (existing) {
  console.log(`Replacing existing asset: ${binaryName}`);
  await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${existing.id}`, {
    method: 'DELETE', headers,
  });
}

// ── Upload ────────────────────────────────────────────────────────────────────

const size = statSync(binaryPath).size;
console.log(`Uploading ${binaryName} (${(size / 1024 / 1024).toFixed(1)} MB)...`);

const uploadRes = await fetch(`${uploadUrl}?name=${binaryName}`, {
  method:  'POST',
  headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
  body:    createReadStream(binaryPath),
  duplex:  'half',
});

if (!uploadRes.ok) {
  const body = await uploadRes.text();
  console.error(`Upload failed ${uploadRes.status}: ${body}`);
  process.exit(1);
}

const asset = await uploadRes.json();
console.log(`Done: ${asset.browser_download_url}`);
