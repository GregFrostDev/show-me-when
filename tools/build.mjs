#!/usr/bin/env node
// Build the board into an output folder: app/ copied, the build sha written into <meta name="build"> and the footer (R6),
// config.js written from the session file, so the session never sits in git (app/config.js keeps its placeholders).
// Usage: node tools/build.mjs --out <dir> --session-file <file> [--api <base>] [--sha <40-hex>] [--allow-dirty]
//   --sha defaults to `git rev-parse HEAD`; without --sha a dirty worktree under app/ is refused (the page must name the build it is).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = (msg) => { console.error(`build: ${msg}`); process.exit(1); };

const out = opt('--out');
const sessionFile = opt('--session-file');
const api = opt('--api') || 'https://hq.mega.dev/challenges/show-me-when/api';
if (!out || !sessionFile) fail('usage: node tools/build.mjs --out <dir> --session-file <file> [--api <base>] [--sha <40-hex>] [--allow-dirty]');
let sha = opt('--sha');
if (!sha) {
  sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'app'], { cwd: HERE, encoding: 'utf8' }).trim();
  if (dirty && !args.includes('--allow-dirty')) fail(`app/ has changes not in commit ${sha.slice(0, 12)}; commit them first, so the sha on the page is the build it serves (or pass --sha)`);
}
if (!/^[0-9a-f]{40}$/.test(sha)) fail(`--sha must be a full 40-character git sha, got "${String(sha).slice(0, 50)}"`);
if (!/^https?:\/\/[^\s'"`\\]+$/.test(api)) fail(`--api must be an http(s) URL with no quotes or spaces, got "${api.slice(0, 80)}"`);
const session = fs.readFileSync(sessionFile, 'utf8').trim();
if (!/^[A-Za-z0-9._~-]+$/.test(session)) fail(`the session in ${sessionFile} has characters a session never has; check the file (its value is not printed)`);

const src = path.join(HERE, 'app');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(out, f));
const indexPath = path.join(out, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const n = html.split('__BUILD_SHA__').length - 1;
if (n !== 2) fail(`app/index.html must hold __BUILD_SHA__ twice (meta and footer), found ${n}`);
fs.writeFileSync(indexPath, html.replaceAll('__BUILD_SHA__', sha));
fs.writeFileSync(path.join(out, 'config.js'),
  `// Written by tools/build.mjs; not in git.\nexport const API = ${JSON.stringify(api)};\nexport const SESSION = ${JSON.stringify(session)};\n`);
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify({ sha }) + '\n');
console.log(`build: ${out} sha ${sha} api ${api} files ${fs.readdirSync(out).length}`);
