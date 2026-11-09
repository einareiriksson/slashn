#!/usr/bin/env node
// Builds the store package: dist/slashn-<version>.zip with manifest.json, icons/ and src/ only (no tests, tools or docs).
// Checks that manifest.json and package.json agree on the version and that every file the manifest names is in the zip.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`version mismatch: manifest.json ${manifest.version}, package.json ${pkg.version}`);
  process.exit(1);
}
const out = path.join(root, 'dist', `slashn-${manifest.version}.zip`);
mkdirSync(path.dirname(out), { recursive: true });
if (existsSync(out)) rmSync(out);
execFileSync('zip', ['-r', '-X', '-q', out, 'manifest.json', 'icons', 'src', '-x', '*.DS_Store'], { cwd: root, stdio: 'inherit' });

const files = new Set(execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n'));
const named = new Set([
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.background?.service_worker,
  manifest.options_ui?.page,
  ...(manifest.content_scripts || []).flatMap((c) => c.js || []),
  ...(manifest.web_accessible_resources || []).flatMap((w) => w.resources || []),
].filter(Boolean));
const missing = [...named].filter((f) => !files.has(f));
if (missing.length) {
  console.error('files named in manifest.json but missing from the zip:', missing.join(', '));
  process.exit(1);
}
const stray = [...files].filter((f) => /(^|\/)(test|tools|node_modules)\//.test(f) || /\.(md|zip)$/.test(f));
if (stray.length) {
  console.error('unexpected files in the zip:', stray.join(', '));
  process.exit(1);
}
console.log(`${path.relative(root, out)}: ${files.size} files, version ${manifest.version}`);
