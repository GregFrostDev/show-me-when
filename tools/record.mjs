#!/usr/bin/env node
// Record the board in use (open-board, ack-incident, watch-board) with Playwright and write the timeline the report is made from.
// Times, the sha and the ack receipt are captured from the running page, never typed.
// Usage: node tools/record.mjs --url <board url> --out <dir> --expect-sha <40-hex> [--ack top|<incident id>|none]
//          [--watch-s 45] [--yes-ack] [--auckland-s 8] [--api-host hq.mega.dev]
//   --yes-ack is required to press Ack on a board that is not on 127.0.0.1 (a real ack on the live course).
// Prints one JSON line: {"ok":true,"video":...,"timeline":...,"durationS":...,"events":n} or {"ok":false,"field":...,"error":...}.
// Exit 0 ok, 1 a check failed (nothing is sent after it), 2 a wrong call.
import { raceVerdict } from './race.mjs';
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
const stepArg = opt('--step', '1'); // 2 = product's step-2 build: every Ack must open a confirm naming the id (Sol P2)
if (!['1', '2'].includes(stepArg)) wrong('--step', 'must be 1 or 2');
const step2 = stepArg === '2';
let board;
try { board = new URL(url); } catch { wrong('--url', `"${String(url).slice(0, 80)}" is not a URL. Send the deployed board, like https://<host>/`); }
if (!['https:', 'http:'].includes(board.protocol)) wrong('--url', 'must be http(s). Send the https address of the board');
const local = ['127.0.0.1', 'localhost'].includes(board.hostname);
if (!local && board.protocol !== 'https:') wrong('--url', 'a deployed board must be https. Send its https address');
if (!outArg) wrong('--out', 'missing. Send a folder for the video and timeline, like private/rec-step1');
const out = path.resolve(outArg); // absolute: ffmpeg's concat list reads paths relative to its own folder
if (!/^[0-9a-f]{40}$/.test(String(expectSha))) wrong('--expect-sha', 'must be the 40-hex sha of the deployed build. Send the sha the deploy printed');
if (!(ackWhat === 'top' || ackWhat === 'none' || ackWhat === 'race' || /^[A-Za-z0-9-]{1,40}$/.test(ackWhat))) wrong('--ack', 'must be top, none or an incident id like INC-5056');
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
  const ackReqs = [];
  page.on('request', (r) => { const u = r.url(); if (/\/ack(\?|$)/.test(new URL(u).pathname + (new URL(u).search ? '?' : ''))) ackReqs.push({ id: new URL(u).searchParams.get('id'), at: Date.now() }); });
  const local = [];
  const mark = (e) => local.push({ ...e, ms: Date.now() - t0 });
  try { await body({ page, mark, ackLines, polls, ackReqs }); } finally {
    await ctx.close();
  }
  const video = fs.readdirSync(path.join(rawDir, name)).find((f) => f.endsWith('.webm'));
  return { name, locale, timezoneId, webm: path.join(rawDir, name, video), local };
}

const browser = await chromium.launch();
let segs;
try {
  const s1 = await segment(browser, { name: 'berlin', locale: 'de-DE', timezoneId: 'Europe/Berlin' }, async ({ page, mark, ackLines, polls, ackReqs }) => {
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
    let raced = false;
    if (ackWhat === 'race') {
      // Click like a person (check-lane ack-race): aim the mouse at the Ack of the row we mean, keep it there while the board
      // refreshes, and click at that spot when a new incident lands at the top. The page is not held still for the click.
      const meantRow = page.locator('[data-testid="incident-row"]:has([data-testid="ack"])').first();
      const meant = await meantRow.getAttribute('data-id', { timeout: 5000 });
      const box = await meantRow.locator('[data-testid="ack"]').boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x - 160, y + 90);
      await page.mouse.move(x, y, { steps: 20 });
      mark({ flow: 'ack-incident', what: `aimed the mouse at the Ack of ${meant}, the top open row, the row I meant`, id: meant, aim: true });
      const topNow = await rows.first().getAttribute('data-id');
      const tAim = Date.now();
      let landed = null;
      while (Date.now() - tAim < watchS * 1000) {
        const top = await rows.first().getAttribute('data-id').catch(() => null);
        if (top && top !== topNow && !initial.includes(top)) { landed = top; break; }
        await page.waitForTimeout(20);
      }
      if (!landed) throw Object.assign(new Error(`no new incident landed in ${watchS} s while the mouse was on the Ack of ${meant}; run again with a longer --watch-s`), { field: 'race' });
      mark({ flow: 'watch-board', what: `${landed} landed at the top without a reload while the mouse rested on the Ack of ${meant}; the rows moved down`, id: landed });
      await page.waitForTimeout(150); // a person's click already on its way
      const before = ackLines.length;
      const reqsBefore = ackReqs.length; // Sol P2-cancel: counted before the raced click
      await page.mouse.click(x, y);
      // Product's step-2 build: Ack opens a confirm that names the incident id. A person reads it: a wrong id -> Cancel, then
      // the Ack of the row meant, then confirm. The old build has no confirm and acks at once.
      const confirm = page.locator('[data-testid="confirm"]');
      let caught = null;
      const opened = await confirm.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false);
      if (step2 && !opened) throw Object.assign(new Error('step 2: the click opened no confirm'), { field: 'race' });
      if (opened) {
        const shown = await confirm.getAttribute('data-id');
        if (step2 && shown !== landed) throw Object.assign(new Error(`step 2: the first confirm names ${shown}, not ${landed}, the incident that landed under the pointer`), { field: 'race' });
        if (step2 && !(await confirm.textContent()).includes(shown)) throw Object.assign(new Error(`step 2: the confirm text does not name ${shown}`), { field: 'race' });
        if (shown !== meant) {
          caught = shown;
          await page.waitForTimeout(1200); // reading the confirm
          await page.locator('[data-testid="confirm-cancel"]').click();
          await confirm.waitFor({ state: 'hidden', timeout: 3000 });
          await page.waitForTimeout(600);
          if (ackReqs.length !== reqsBefore) throw Object.assign(new Error(`a GET /ack went out before the confirm (${ackReqs.slice(reqsBefore).map((r) => r.id).join(', ')})`), { field: 'race' });
          mark({ flow: 'ack-incident', what: `the click landed on the moved row: the confirm named ${shown}, not ${meant}, the row I meant; pressed Cancel; no ack request went out`, id: shown, meant, landed, caught: true });
          await page.locator(`[data-testid="incident-row"][data-id="${meant}"] [data-testid="ack"]`).click();
          await confirm.waitFor({ state: 'visible', timeout: 3000 });
          if ((await confirm.getAttribute('data-id')) !== meant || !(await confirm.textContent()).includes(meant)) throw Object.assign(new Error(`the second confirm does not name ${meant}`), { field: 'race' });
          if (ackReqs.length !== reqsBefore) throw Object.assign(new Error('a GET /ack went out before the second confirm'), { field: 'race' });
          await page.waitForTimeout(1000);
        }
        await page.locator('[data-testid="confirm-ack"]').click();
      }
      const tClick = Date.now();
      while (ackLines.length === before && Date.now() - tClick < 10000) await page.waitForTimeout(50);
      const line = ackLines[before];
      if (!line) throw Object.assign(new Error('no "ack <id> ..." console line with a receipt after the click'), { field: 'receipt' });
      const [, hit, ackedAt, ...rest] = line.t.split(' ');
      const miss = hit !== meant;
      await page.waitForTimeout(500);
      const sent = ackReqs.slice(reqsBefore);
      if (step2 && !(sent.length === 1 && sent[0].id === meant)) throw Object.assign(new Error(`step 2: expected exactly one GET /ack for ${meant}, saw ${sent.map((r) => r.id).join(', ') || 'none'}`), { field: 'race' });
      const bad = raceVerdict({ meant, landed, hit, receipt: rest.join(' '), caught }); // R1 (Sol, claim 2), tested in test/race.test.mjs
      if (bad) throw Object.assign(new Error(bad.error), { field: bad.field });
      mark({ flow: 'ack-incident', what: caught ? `the confirm named ${meant}; pressed Ack ${meant}: the Ack went to ${hit}, the row I meant; the ack API answered ackedAt ${ackedAt}` : miss ? `clicked the same spot: the Ack went to ${hit}, the incident that had just landed, not to ${meant}, the row I meant; the ack API answered ackedAt ${ackedAt}` : `clicked the same spot: the Ack went to ${hit}, the row I meant; the ack API answered ackedAt ${ackedAt}`, id: hit, meant, landed, miss, caught: Boolean(caught), ackedAt, receipt: rest.join(' ') });
      raced = true;
      await page.waitForTimeout(4000);
    }
    if (ackWhat !== 'none' && !raced) {
      const target = ackWhat === 'top' ? page.locator('[data-testid="incident-row"]:has([data-testid="ack"])').first() : page.locator(`[data-testid="incident-row"][data-id="${ackWhat}"]`);
      const id = await target.getAttribute('data-id', { timeout: 5000 });
      const row = page.locator(`[data-testid="incident-row"][data-id="${id}"]`); // pin the row: the ":has(ack)" locator moves on after the ack
      const nReq = ackReqs.length;
      await row.locator('[data-testid="ack"]').click();
      const cf = page.locator('[data-testid="confirm"]');
      const cfOpen = await cf.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false);
      if (step2 && !cfOpen) throw Object.assign(new Error('step 2: Ack opened no confirm'), { field: 'confirm' });
      if (cfOpen) {
        if ((await cf.getAttribute('data-id')) !== id || !(await cf.textContent()).includes(id)) throw Object.assign(new Error(`the confirm does not name ${id}`), { field: 'confirm' });
        await page.waitForTimeout(800);
        if (ackReqs.length !== nReq) throw Object.assign(new Error('a GET /ack went out before the confirm'), { field: 'confirm' });
        await page.locator('[data-testid="confirm-ack"]').click();
      }
      await row.locator('[data-testid="acked"]').waitFor({ timeout: 10000 });
      if (step2) { await page.waitForTimeout(300); const sentN = ackReqs.slice(nReq); if (!(sentN.length === 1 && sentN[0].id === id)) throw Object.assign(new Error(`step 2: expected exactly one GET /ack for ${id}, saw ${sentN.map((r) => r.id).join(', ') || 'none'}`), { field: 'confirm' }); }
      const line = ackLines.find((l) => l.t.split(' ')[1] === id);
      if (!line) throw Object.assign(new Error(`no "ack ${id} ..." console line with a receipt after the click`), { field: 'receipt' });
      const [, , ackedAt, ...rest] = line.t.split(' ');
      mark({ flow: 'ack-incident', what: `pressed Ack on ${id}, the top open row; the row shows the acked mark; the ack API answered ackedAt ${ackedAt}`, id, ackedAt, receipt: rest.join(' ') });
    }
    const pollsBefore = polls.length;
    const tWatch = Date.now();
    let appeared = null;
    while (!raced && Date.now() - tWatch < watchS * 1000) {
      const now = await rows.evaluateAll((els) => els.map((e) => e.dataset.id));
      const fresh = now.find((x) => !initial.includes(x));
      if (fresh && now[0] === fresh) { appeared = fresh; break; }
      await page.waitForTimeout(250);
    }
    const refreshes = polls.length - pollsBefore;
    if (raced) { /* the watch-board moment is the landing during the race */ } else if (appeared) mark({ flow: 'watch-board', what: `${appeared} came in and showed at the top without a reload (${refreshes} refreshes while watching)`, id: appeared });
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
