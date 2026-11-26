// Checks with no browser: pinned starter files, the build tool, the session staying out of the source, and the report limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeReport, checkReport, LIMITS } from '../tools/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const SHA = '0123456789abcdef0123456789abcdef01234567';

test('pinned: app/api.js and .github/workflows/prove.yml are byte for byte the starter files', () => {
  // starter sched-prod-board-2dff0937.zip, hashed 2026-11-25 (log.md)
  assert.equal(sha256('app/api.js'), 'd922074822588f12132b023a5471af90e9672c47dbd8eca55385c21b21319e92');
  assert.equal(sha256('.github/workflows/prove.yml'), 'bc0bbd32e1227260d51e4746a9213f311f5353d2a5c486b061d39cf7dfd427f7');
});

test('secret: app/config.js in the source keeps the starter placeholders (the session is written only into the build)', () => {
  assert.equal(sha256('app/config.js'), '88f3657418686b56766b92b4b335267e28a58faaf19fc30c1a75455a548cc972');
  const g = spawnSync('grep', ['-rlE', 'v1\\.eyJ[A-Za-z0-9_-]{20,}', 'app', 'tools', 'test', 'plan.md', 'README.md', 'package.json', '.github'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(g.status, 1, `session-shaped text in ${g.stdout}${g.stderr}`); // grep: 1 = no match
});

function runBuild(args) {
  return spawnSync('node', [path.join(ROOT, 'tools/build.mjs'), ...args], { encoding: 'utf8' });
}

test('build: writes the sha twice into index.html, config.js from the session file, and build.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
  fs.writeFileSync(path.join(tmp, 's.txt'), 'v1.test-session\n');
  const r = runBuild(['--out', path.join(tmp, 'd'), '--session-file', path.join(tmp, 's.txt'), '--sha', SHA, '--api', 'https://example.test/api']);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(path.join(tmp, 'd/index.html'), 'utf8');
  assert.match(html, new RegExp(`<meta name="build" content="${SHA}" />`));
  assert.match(html, new RegExp(`<code data-testid="build-sha">${SHA}</code>`));
  assert.doesNotMatch(html, /__BUILD_SHA__/);
  assert.equal(fs.readFileSync(path.join(tmp, 'd/config.js'), 'utf8'), '// Written by tools/build.mjs; not in git.\nexport const API = "https://example.test/api";\nexport const SESSION = "v1.test-session";\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'd/build.json'), 'utf8')), { sha: SHA });
  assert.doesNotMatch(r.stdout, /v1\.test-session/, 'the build never prints the session');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('build: refuses a short sha, a bad api and an odd session, naming the input', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
  fs.writeFileSync(path.join(tmp, 's.txt'), 'v1.ok');
  fs.writeFileSync(path.join(tmp, 'bad.txt'), 'v1.x";alert(1)//');
  const out = path.join(tmp, 'd');
  let r = runBuild(['--out', out, '--session-file', path.join(tmp, 's.txt'), '--sha', 'abc123']);
  assert.equal(r.status, 1); assert.match(r.stderr, /--sha must be a full 40-character git sha, got "abc123"/);
  r = runBuild(['--out', out, '--session-file', path.join(tmp, 's.txt'), '--sha', SHA, '--api', "javascript:alert('x')"]);
  assert.equal(r.status, 1); assert.match(r.stderr, /--api must be an http\(s\) URL/);
  r = runBuild(['--out', out, '--session-file', path.join(tmp, 'bad.txt'), '--sha', SHA]);
  assert.equal(r.status, 1); assert.match(r.stderr, /the session in .*bad\.txt has characters a session never has/);
  assert.doesNotMatch(r.stderr, /alert/, 'the session value is not printed');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const goodTimeline = {
  url: 'https://board.example/', sha: SHA, videoLink: 'https://video.example/step1.mp4', durationS: 75,
  segments: [{ name: 'berlin', locale: 'de-DE', timezoneId: 'Europe/Berlin', startS: 0 }],
  events: [
    { flow: 'open-board', atS: 3.2, what: 'board loaded, 8 rows, loader gone', sha: SHA },
    { flow: 'ack-incident', atS: 21.7, what: 'Ack on INC-5056 (top row); row marked acked', id: 'INC-5056', receipt: 'rcpt-abc' },
    { flow: 'watch-board', atS: 48.0, what: 'INC-7001 appeared at the top without a reload', id: 'INC-7001' },
  ],
};

test('report: has the four sections in order and one evidence block with the five fields', () => {
  const md = makeReport(goodTimeline, { flow: 'ack-incident' });
  const heads = md.match(/^## .+$/gm);
  assert.deepEqual(heads, ['## What you checked', '## When', '## Where', '## Options for product']);
  const blocks = md.match(/```evidence\n([\s\S]*?)\n```/g);
  assert.equal(blocks.length, 1);
  const ev = JSON.parse(blocks[0].replace(/^```evidence\n/, '').replace(/\n```$/, ''));
  assert.deepEqual(Object.keys(ev), ['flow', 'at', 'receipt', 'sha', 'videoLink']);
  assert.deepEqual(ev, { flow: 'ack-incident', at: '00:21', receipt: 'rcpt-abc', sha: SHA, videoLink: 'https://video.example/step1.mp4' });
  assert.match(md, /app\/app\.js:\d+/, 'Where names file:line');
  assert.deepEqual(checkReport(md, goodTimeline), []);
});

test(`report limits: at most ${LIMITS.reportBytes} bytes; flow one of the three; at mm:ss inside the video; https videoLink; 40-hex sha`, () => {
  const md = makeReport(goodTimeline, { flow: 'ack-incident' });
  assert.ok(Buffer.byteLength(md) <= LIMITS.reportBytes);
  const big = md + 'x'.repeat(LIMITS.reportBytes);
  assert.ok(checkReport(big, goodTimeline).some((e) => /report is \d+ bytes, over 65536/.test(e)));
  const bad = (patch) => checkReport(md.replace(/```evidence\n[\s\S]*?\n```/, '```evidence\n' + JSON.stringify({ flow: 'ack-incident', at: '00:21', receipt: 'rcpt-abc', sha: SHA, videoLink: 'https://video.example/step1.mp4', ...patch }, null, 2) + '\n```'), goodTimeline);
  assert.ok(bad({ flow: 'ack' }).some((e) => /flow "ack" is not one of open-board, ack-incident, watch-board/.test(e)));
  assert.ok(bad({ at: '1:5' }).some((e) => /at "1:5" is not mm:ss/.test(e)));
  assert.ok(bad({ at: '02:00' }).some((e) => /at 02:00 is past the end of the recording \(75 s\)/.test(e)));
  assert.ok(bad({ videoLink: 'http://video.example/a.mp4' }).some((e) => /videoLink must be https/.test(e)));
  assert.ok(bad({ sha: 'abc' }).some((e) => /sha "abc" is not a 40-hex git sha/.test(e)));
  assert.ok(bad({ receipt: '' }).some((e) => /receipt is empty/.test(e)));
  assert.ok(bad({ receipt: 'other' }).some((e) => /receipt is not the one the recording captured at 00:21/.test(e)));
});

test('report: an ack-incident report without a captured receipt is refused (evidence is captured, never typed)', () => {
  const t = structuredClone(goodTimeline);
  delete t.events[1].receipt;
  assert.throws(() => makeReport(t, { flow: 'ack-incident' }), /no receipt captured for the ack-incident moment/);
});
