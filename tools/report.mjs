#!/usr/bin/env node
// Make the step-one report (start reply report.format) from a recording's timeline (tools/record.mjs), never from memory:
// every time, receipt and sha in the report comes from the timeline the recorder captured.
// Usage: node tools/report.mjs <timeline.json> <out.md> [--flow ack-incident] [--video-link https://...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIMITS = { reportBytes: 64 * 1024, flows: ['open-board', 'ack-incident', 'watch-board'] };
export const SECTIONS = ['## What you checked', '## When', '## Where', '## Options for product'];

export const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fromMmss = (t) => { const m = /^(\d{2}):([0-5]\d)$/.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// file:line of the code behind each flow, found in the source so the line numbers follow the code.
const WHERE = {
  'open-board': [['app/app.js', 'loader.remove()'], ['app/app.js', 'current = newestFirst(']],
  'ack-incident': [['app/app.js', 'await ack(id)'], ['app/api.js', 'export async function ack(id)']],
  'watch-board': [['app/app.js', 'setTimeout(refresh'], ['app/app.js', 'export const REFRESH_MS']],
  times: [['app/time.js', 'export function formatLocal('], ['app/app.js', "setAttr(c.time, 'datetime', iso)"]],
  build: [['app/index.html', '<meta name="build"'], ['app/index.html', 'data-testid="build-sha"']],
};
export function where(key, root = ROOT) {
  return WHERE[key].map(([file, needle]) => {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    const n = lines.findIndex((l) => l.includes(needle));
    if (n < 0) throw new Error(`where: "${needle}" not found in ${file}`);
    return `${file}:${n + 1}`;
  });
}

export function makeReport(tl, { flow = 'ack-incident', videoLink } = {}) {
  if (!LIMITS.flows.includes(flow)) throw new Error(`flow "${flow}" is not one of ${LIMITS.flows.join(', ')}`);
  const link = videoLink || tl.videoLink;
  const ev = tl.events.find((e) => e.flow === flow && e.receipt) || tl.events.find((e) => e.flow === flow);
  if (!ev) throw new Error(`the timeline has no ${flow} moment; record it first`);
  if (!ev.receipt) throw new Error(`no receipt captured for the ${flow} moment at ${mmss(ev.atS)}; the evidence block needs the ack API's receipt for that moment`);
  const seg = (e) => (tl.segments || []).filter((s) => s.startS <= e.atS).at(-1);
  const viewer = (e) => { const s = seg(e); return s ? ` (viewer ${s.locale}, ${s.timezoneId})` : ''; };
  const checked = tl.events.map((e) => `- ${mmss(e.atS)} · ${e.flow} · ${e.what}${viewer(e)}`);
  const evidence = { flow, at: mmss(ev.atS), receipt: ev.receipt, sha: tl.sha, videoLink: link };
  const md = [
    SECTIONS[0],
    `I opened the deployed board at ${tl.url} in Chromium and recorded it (${Math.round(tl.durationS)} s). What I did and what I saw, in order:`,
    ...checked,
    `The footer and \`<meta name="build">\` show build ${tl.sha} in the recording.`,
    '',
    SECTIONS[1],
    ...tl.events.map((e) => `- ${mmss(e.atS)} ${e.flow}${e.id ? ` (${e.id})` : ''}`),
    `- Reported moment: ${mmss(ev.atS)}, ${flow}.`,
    '',
    SECTIONS[2],
    `- ${where(flow)[0]} (${flow}, the reported moment; also ${where(flow).slice(1).join(', ')})`,
    ...LIMITS.flows.filter((k) => k !== flow).map((k) => `- ${k}: ${where(k).join(', ')}`),
    `- local times (SCHED-4514): ${where('times').join(', ')}`,
    `- build sha (R6): ${where('build').join(', ')}`,
    '',
    SECTIONS[3],
    '1. Acked rows. (a) Stay in place with an acked mark, as built now (two-way door). (b) Move below the open ones (two-way). (c) Hide after some minutes (two-way, but on-call loses the history on screen).',
    '2. Who acked. (a) No name, as built now: the ack API takes no name. (b) Show the on-call name: needs a new field in the ack API and stored data (one-way door once others read it).',
    '3. Time format. (a) The viewer\'s own clock (12 h in en-NZ and en-US) with the zone name, dd/mm for EU locales, as built now (two-way). (b) A 24-hour clock for everyone (two-way). (c) Local time plus UTC beside it (two-way).',
    '4. Refresh. (a) Every 2 s while open (R4), as built now (two-way). (b) Pause while the tab is hidden, to cut load (two-way).',
    '5. Ack state for other viewers. (a) Shown on the page that acked until it is reloaded, as built now: the incidents API returns no ack state (two-way). (b) Also kept in that browser across a reload (two-way). (c) Shared with every viewer: the incidents API returns ackedAt (a data change, one-way door once others rely on it).',
    '',
    '```evidence',
    JSON.stringify(evidence, null, 2),
    '```',
    '',
  ].join('\n');
  const errs = checkReport(md, tl);
  if (errs.length) throw new Error(`report check: ${errs.join('; ')}`);
  return md;
}

export function checkReport(md, tl) {
  const errs = [];
  const bytes = Buffer.byteLength(md);
  if (bytes > LIMITS.reportBytes) errs.push(`report is ${bytes} bytes, over ${LIMITS.reportBytes} (64 KB)`);
  const heads = md.match(/^## .+$/gm) || [];
  for (const s of SECTIONS) if (!heads.includes(s)) errs.push(`section "${s}" is missing`);
  const order = heads.filter((h) => SECTIONS.includes(h));
  if (order.join() !== SECTIONS.filter((s) => order.includes(s)).join()) errs.push('sections are not in the order of the start reply');
  const blocks = [...md.matchAll(/```evidence\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) { errs.push(`${blocks.length} evidence blocks, want exactly 1`); return errs; }
  let ev;
  try { ev = JSON.parse(blocks[0][1]); } catch (e) { errs.push(`evidence block is not JSON: ${e.message}`); return errs; }
  for (const k of ['flow', 'at', 'receipt', 'sha', 'videoLink']) if (!(k in ev)) errs.push(`evidence has no ${k}`);
  if (!LIMITS.flows.includes(ev.flow)) errs.push(`flow "${ev.flow}" is not one of ${LIMITS.flows.join(', ')}`);
  const at = fromMmss(String(ev.at));
  if (at === null) errs.push(`at "${ev.at}" is not mm:ss`);
  else if (tl && at > tl.durationS) errs.push(`at ${ev.at} is past the end of the recording (${Math.round(tl.durationS)} s)`);
  if (!ev.receipt) errs.push('receipt is empty');
  else if (tl && !tl.events.some((e) => e.receipt === ev.receipt && mmss(e.atS) === ev.at)) errs.push(`receipt is not the one the recording captured at ${ev.at}`);
  if (!/^[0-9a-f]{40}$/.test(String(ev.sha))) errs.push(`sha "${ev.sha}" is not a 40-hex git sha`);
  else if (tl && ev.sha !== tl.sha) errs.push(`sha ${ev.sha} is not the build the recording shows (${tl.sha})`);
  if (!/^https:\/\/[^\s]+$/.test(String(ev.videoLink))) errs.push('videoLink must be https');
  return errs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const [tlFile, out] = args;
  if (!tlFile || !out) { console.error('usage: node tools/report.mjs <timeline.json> <out.md> [--flow ack-incident] [--video-link https://...]'); process.exit(2); }
  const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  try {
    const md = makeReport(tl, { flow: opt('--flow'), videoLink: opt('--video-link') });
    fs.writeFileSync(out, md);
    console.log(JSON.stringify({ ok: true, out, bytes: Buffer.byteLength(md), at: md.match(/"at": "([^"]+)"/)[1] }));
  } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1); }
}
