// The recorder and the report, end to end against the fake course (a local rehearsal of step one; no live call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFake } from './fake-course.mjs';
import { makeReport, checkReport } from '../tools/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'fedcba9876543210fedcba9876543210fedcba98';

test('record: open-board, ack-incident with its receipt, watch-board and an Auckland viewer, in one mp4; report passes its checks', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  fs.writeFileSync(path.join(tmp, 's.txt'), 'v1.test-session-not-real');
  const fake = await startFake({ session: 'v1.test-session-not-real' });
  const dist = path.join(tmp, 'dist');
  execFileSync('node', [path.join(ROOT, 'tools/build.mjs'), '--out', dist, '--session-file', path.join(tmp, 's.txt'), '--api', fake.api, '--sha', SHA]);
  fake.setDist(dist);
  const add = setTimeout(() => fake.state.incidents.unshift({ id: 'INC-7001', service: 'booking-api', region: 'eu-central', summary: 'rehearsal incident', severity: 'sev2', openedAt: new Date().toISOString() }), 9000);
  const out = path.join(tmp, 'rec');
  const host = new URL(fake.base).host;
  const r = await new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) => execFile('node', [path.join(ROOT, 'tools/record.mjs'), '--url', `${fake.base}/`, '--out', out, '--expect-sha', SHA, '--watch-s', '15', '--auckland-s', '2', '--api-host', host], { encoding: 'utf8' }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
  });
  clearTimeout(add);
  await fake.close();
  const res = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(res.ok, true, r.stdout + r.stderr);
  assert.ok(Buffer.byteLength(r.stdout.trim().split('\n').at(-1)) <= 400, 'stdout line within the 400 B budget of tools/record.TOOL.md');
  const tl = JSON.parse(fs.readFileSync(path.join(out, 'timeline.json'), 'utf8'));
  assert.deepEqual(tl.events.map((e) => e.flow), ['open-board', 'ack-incident', 'watch-board', 'open-board']);
  const ack = tl.events[1];
  assert.equal(ack.id, 'INC-5056');
  assert.equal(ack.receipt, 'fake-receipt-1-INC-5056');
  assert.equal(fake.state.acks.length, 1);
  assert.equal(fake.state.acks[0].latest, true);
  assert.match(tl.events[2].what, /^INC-7001 came in and showed at the top without a reload/);
  assert.match(tl.events[3].what, /Auckland.*\d\d\/\d\d\/2026/);
  for (const e of tl.events) assert.ok(e.atS >= 0 && e.atS <= tl.durationS, `${e.flow} at ${e.atS} inside ${tl.durationS}`);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', path.join(out, 'recording.mp4')], { encoding: 'utf8' }).trim();
  assert.equal(probe, 'h264,1280,720');
  const md = makeReport(tl, { flow: 'ack-incident', videoLink: 'https://video.example/recording.mp4' });
  assert.deepEqual(checkReport(md, tl), []);
  fs.writeFileSync(path.join(ROOT, 'test-results-report.md'), md);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('record: refuses a live Ack without --yes-ack, and a short sha, naming the field (nothing is opened)', () => {
  let r = spawnSync('node', [path.join(ROOT, 'tools/record.mjs'), '--url', 'https://board.example/', '--out', '/tmp/x-rec', '--expect-sha', SHA], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).field, '--yes-ack');
  r = spawnSync('node', [path.join(ROOT, 'tools/record.mjs'), '--url', 'https://board.example/', '--out', '/tmp/x-rec', '--expect-sha', 'abc', '--ack', 'none'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).field, '--expect-sha');
  r = spawnSync('node', [path.join(ROOT, 'tools/record.mjs'), '--url', 'http://board.example/', '--out', '/tmp/x-rec', '--expect-sha', SHA, '--ack', 'none'], { encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).field, '--url');
});
