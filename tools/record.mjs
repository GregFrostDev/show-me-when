#!/usr/bin/env node
// Record the board in use (open-board, ack-incident, watch-board) with Playwright and write the timeline the report is made from.
// Times, the sha and the ack receipt are captured from the running page, never typed.
// Usage: node tools/record.mjs --url <board url> --out <dir> --expect-sha <40-hex> [--ack top|<incident id>|none]
//          [--watch-s 45] [--yes-ack] [--auckland-s 8] [--api-host hq.mega.dev]
//   --yes-ack is required to press Ack on a board that is not on 127.0.0.1 (a real ack on the live course).
// Prints one JSON line: {"ok":true,"video":...,"timeline":...,"durationS":...,"events":n} or {"ok":false,"field":...,"error":...}.
// Exit 0 ok, 1 a check failed (nothing is sent after it), 2 a wrong call.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const done = (code, obj) => { console.log(JSON.stringify(obj)); process.exit(code); };
const wrong = (field, error) => done(2, { ok: false, field, error });

const url = opt('--url');
const outArg = opt('--out');
const expectSha = opt('--expect-sha');
const ackWhat = opt('--ack', 'top');
const watchS = Number(opt('--watch-s', '45'));
const aucklandS = Number(opt('--auckland-s', '8'));
const apiHostArg = opt('--api-host', 'hq.mega.dev');
let board;
try { board = new URL(url); } catch { wrong('--url', `"${String(url).slice(0, 80)}" is not a URL. Send the deployed board, like https://<host>/`); }
if (!['https:', 'http:'].includes(board.protocol)) wrong('--url', 'must be http(s). Send the https address of the board');
const local = ['127.0.0.1', 'localhost'].includes(board.hostname);
if (!local && board.protocol !== 'https:') wrong('--url', 'a deployed board must be https. Send its https address');
if (!outArg) wrong('--out', 'missing. Send a folder for the video and timeline, like private/rec-step1');
const out = path.resolve(outArg); // absolute: ffmpeg's concat list reads paths relative to its own folder
if (!/^[0-9a-f]{40}$/.test(String(expectSha))) wrong('--expect-sha', 'must be the 40-hex sha of the deployed build. Send the sha the deploy printed');
if (!(ackWhat === 'top' || ackWhat === 'none' || /^[A-Za-z0-9-]{1,40}$/.test(ackWhat))) wrong('--ack', 'must be top, none or an incident id like INC-5056');
if (!(watchS >= 0 && watchS <= 600)) wrong('--watch-s', 'must be 0 to 600 seconds');
if (ackWhat !== 'none' && !local && !args.includes('--yes-ack')) wrong('--yes-ack', 'pressing Ack on a deployed board sends a real ack to the course. Add --yes-ack only with your human\'s yes for it');

fs.mkdirSync(out, { recursive: true });
const rawDir = path.join(out, 'raw');
fs.rmSync(rawDir, { recursive: true, force: true });
const events = [];
const segments = [];
const SIZE = { width: 1280, height: 720 };

async function segment(browser, { name, locale, timezoneId }, body) {
  const ctx = await browser.newContext({ locale, timezoneId, viewport: SIZE, recordVideo: { dir: path.join(rawDir, name), size: SIZE } });
  // Trust gate: the page may reach only the board's host and the API host; every other request is aborted.
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    return u.host === board.host || u.host === apiHostArg ? route.continue() : route.abort();
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const ackLines = [];
  const polls = [];
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('ack ')) ackLines.push({ t, at: Date.now() }); });
  page.on('request', (r) => { if (r.url().includes('/incidents')) polls.push(Date.now()); });
  const local = [];
  const mark = (e) => local.push({ ...e, ms: Date.now() - t0 });
  try { await body({ page, mark, ackLines, polls }); } finally {
    await ctx.close();
  }
  const video = fs.readdirSync(path.join(rawDir, name)).find((f) => f.endsWith('.webm'));
  return { name, locale, timezoneId, webm: path.join(rawDir, name, video), local };
}

const browser = await chromium.launch();
let segs;
try {
  const s1 = await segment(browser, { name: 'berlin', locale: 'de-DE', timezoneId: 'Europe/Berlin' }, async ({ page, mark, ackLines, polls }) => {
    await page.goto(board.toString());
    const rows = page.locator('[data-testid="incident-row"]');
    await rows.first().waitFor({ timeout: 15000 });
    const meta = await page.locator('meta[name="build"]').getAttribute('content');
    const foot = (await page.locator('[data-testid="build-sha"]').textContent()).trim();
    if (meta !== expectSha || foot !== expectSha) throw Object.assign(new Error(`the page names build ${meta} (meta) / ${foot} (footer), not ${expectSha}`), { field: '--expect-sha' });
    const initial = await rows.evaluateAll((els) => els.map((e) => e.dataset.id));
    const loaderGone = (await page.locator('[data-testid="loader"]').count()) === 0;
    mark({ flow: 'open-board', what: `board loaded with ${initial.length} incidents, newest first, loader ${loaderGone ? 'gone' : 'still shown'}; footer shows build ${expectSha.slice(0, 12)}`, sha: meta });
    await page.waitForTimeout(4000);
    if (ackWhat !== 'none') {
      const target = ackWhat === 'top' ? page.locator('[data-testid="incident-row"]:has([data-testid="ack"])').first() : page.locator(`[data-testid="incident-row"][data-id="${ackWhat}"]`);
      const id = await target.getAttribute('data-id', { timeout: 5000 });
      const row = page.locator(`[data-testid="incident-row"][data-id="${id}"]`); // pin the row: the ":has(ack)" locator moves on after the ack
      await row.locator('[data-testid="ack"]').click();
      await row.locator('[data-testid="acked"]').waitFor({ timeout: 10000 });
      const line = ackLines.find((l) => l.t.split(' ')[1] === id);
      if (!line) throw Object.assign(new Error(`no "ack ${id} ..." console line with a receipt after the click`), { field: 'receipt' });
      const [, , ackedAt, ...rest] = line.t.split(' ');
      mark({ flow: 'ack-incident', what: `pressed Ack on ${id}, the top open row; the row shows the acked mark; the ack API answered ackedAt ${ackedAt}`, id, ackedAt, receipt: rest.join(' ') });
    }
    const pollsBefore = polls.length;
    const tWatch = Date.now();
    let appeared = null;
    while (Date.now() - tWatch < watchS * 1000) {
      const now = await rows.evaluateAll((els) => els.map((e) => e.dataset.id));
      const fresh = now.find((x) => !initial.includes(x));
      if (fresh && now[0] === fresh) { appeared = fresh; break; }
      await page.waitForTimeout(250);
    }
    const refreshes = polls.length - pollsBefore;
    if (appeared) mark({ flow: 'watch-board', what: `${appeared} came in and showed at the top without a reload (${refreshes} refreshes while watching)`, id: appeared });
    else mark({ flow: 'watch-board', what: `kept the board open ${watchS} s without a reload: ${refreshes} refreshes, no new incident in that time` });
    await page.waitForTimeout(3000);
  });
  const s2 = await segment(browser, { name: 'auckland', locale: 'en-NZ', timezoneId: 'Pacific/Auckland' }, async ({ page, mark }) => {
    await page.goto(board.toString());
    await page.locator('[data-testid="incident-row"]').first().waitFor({ timeout: 15000 });
    const t = await page.locator('[data-testid="incident-row"] time').first().textContent();
    const z = await page.locator('[data-testid="incident-row"] .tz').first().textContent();
    mark({ flow: 'open-board', what: `same board as a viewer in Auckland (en-NZ): times in NZ time, day before month, e.g. top row ${t} ${z}` });
    await page.waitForTimeout(aucklandS * 1000);
  });
  segs = [s1, s2];
} catch (e) {
  await browser.close();
  done(1, { ok: false, field: e.field || 'recording', error: String(e.message || e).slice(0, 300) });
}
await browser.close();

try {
// webm -> one mp4 (H.264), with each segment's start in the final video
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
let offset = 0;
const parts = [];
for (const s of segs) {
  const mp4 = s.webm.replace(/\.webm$/, '.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', s.webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '25', '-an', mp4]);
  const d = dur(mp4);
  segments.push({ name: s.name, locale: s.locale, timezoneId: s.timezoneId, startS: offset, durationS: d });
  for (const e of s.local) { const { ms, ...rest } = e; events.push({ ...rest, atS: Math.round((offset + ms / 1000) * 10) / 10 }); }
  parts.push(mp4);
  offset += d;
}
const list = path.join(rawDir, 'concat.txt');
fs.writeFileSync(list, parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join('\n') + '\n');
const video = path.join(out, 'recording.mp4');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', video]);
const durationS = dur(video);
const timeline = { url: board.toString(), sha: expectSha, recordedAt: new Date().toISOString(), durationS, bytes: fs.statSync(video).size, segments, events };
fs.writeFileSync(path.join(out, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');
  done(0, { ok: true, video, timeline: path.join(out, 'timeline.json'), durationS, bytes: timeline.bytes, events: events.length });
} catch (e) {
  done(1, { ok: false, field: 'video', error: `ffmpeg or ffprobe failed: ${String(e.stderr || e.message || e).slice(0, 300)}` });
}
