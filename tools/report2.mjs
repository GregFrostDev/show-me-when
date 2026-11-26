#!/usr/bin/env node
// Make the step-two report (start reply submit.step2) from the step-2 recording's timeline, never from memory:
// the step-one sections, a ## System Diff section (behavior, UX, data, product's decision, data-testid hooks touched),
// and one evidence block { sha, videoLink, runUrl }. The hub checks the run (prove.yml, success, the deployed sha) with gh before this.
// Usage: node tools/report2.mjs <timeline.json> <out.md> --video-link https://... [--run-url https://github.com/.../actions/runs/<id>]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { makeReport, where, mmss } from './report.mjs';

export const PRODUCT = 'New incidents stay live at the top and Ack stays on the row, but Ack asks to confirm, and the confirm names the incident id.';

export function makeStep2Report(tl, { videoLink, runUrl, checkRun = true } = {}) {
  const base = makeReport(tl, { videoLink });
  const ev = tl.events.find((e) => e.flow === 'ack-incident' && e.receipt);
  const caught = tl.events.find((e) => e.caught === true && !e.receipt);
  if (!ev || !caught) throw new Error('the step-2 timeline needs a confirm that caught the moved row and a confirmed ack of the row meant');
  if (ev.id !== ev.meant) throw new Error(`the confirmed ack went to ${ev.id}, not ${ev.meant}`);
  // Sol P3: both events describe the same race, in order.
  if (!(tl.events.indexOf(caught) < tl.events.indexOf(ev) && caught.atS <= ev.atS && caught.meant === ev.meant && caught.id === ev.landed && ev.caught === true)) throw new Error('the confirm event and the ack event do not describe the same race');
  const link = videoLink || tl.videoLink;
  if (!/^[0-9a-f]{40}$/.test(String(tl.sha || '')) || !/^https:\/\//.test(String(link || '')) || !/^https:\/\/github\.com\/GregFrostDev\/show-me-when\/actions\/runs\/\d+$/.test(String(runUrl || ''))) throw new Error('the GitHub prove path needs sha (40 hex), an https videoLink and a runUrl of an Actions run');
  // Sol P3 (round 3): the run must be a successful prove run at the deployed sha; checked here, not by hand.
  if (checkRun) {
    const id = runUrl.split('/').at(-1);
    const run = JSON.parse(execFileSync('gh', ['run', 'view', id, '-R', 'GregFrostDev/show-me-when', '--json', 'workflowName,conclusion,headSha'], { encoding: 'utf8' }));
    if (!(run.workflowName === 'prove' && run.conclusion === 'success' && run.headSha === tl.sha)) throw new Error(`run ${id} is ${run.workflowName} ${run.conclusion} at ${run.headSha}, not a successful prove run at ${tl.sha}`);
  }
  const head = base.slice(0, base.indexOf('```evidence')).trimEnd();
  const diff = [
    '## System Diff',
    `- Product's decision: "${PRODUCT}"`,
    `- Behavior: Ack no longer acks at once. It opens a confirm that names the incident id (and its service and summary); only "Ack <id>" in the confirm sends api.ack(id); Cancel or Escape sends nothing. In the recording at ${mmss(caught.atS)} the click hit the moved row, the confirm named ${caught.id}, not ${caught.meant}, and Cancel acked nothing; at ${mmss(ev.atS)} the confirm named ${ev.meant} and the ack went to ${ev.id}, the row meant.`,
    '- UX: new incidents still land live at the top every 2 s (no change to the refresh). The confirm sits in a fixed place outside the list, so a refresh never moves it; while it is open, a backdrop takes every click outside it and does not close it, so a click on a moved row cannot ack. The focus starts on Cancel.',
    '- Data: no change. Same API calls (GET /incidents every 2 s, GET /ack?id once per confirmed Ack), same fields; acks still kept in the page only.',
    `- data-testid hooks touched: added confirm (the confirm, with data-id = the incident id and its text naming the id), confirm-ack (its text "Ack <id>"), confirm-cancel, confirm-text; changed ack (now opens the confirm instead of acking); unchanged incident-row, acked, loader, board, incident-list, build-sha.`,
    `- Code: ${where('ack-incident')[0]} (the ack, now behind the confirm), app/app.js askAck and closeConfirm, app/style.css (.confirm, .confirm-backdrop).`,
  ];
  const evidence = { sha: tl.sha, videoLink: link, runUrl };
  return [head, '', ...diff, '', '```evidence', JSON.stringify(evidence, null, 2), '```', ''].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tlFile, out] = process.argv.slice(2);
  const opt = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  if (!tlFile || !out || !opt('--video-link')) { console.error('usage: node tools/report2.mjs <timeline.json> <out.md> --video-link https://... [--run-url https://...]'); process.exit(2); }
  try {
    const md = makeStep2Report(JSON.parse(fs.readFileSync(tlFile, 'utf8')), { videoLink: opt('--video-link'), runUrl: opt('--run-url') });
    if (Buffer.byteLength(md) > 64 * 1024) throw new Error('report is over 64 KB');
    fs.writeFileSync(out, md);
    console.log(JSON.stringify({ ok: true, out, bytes: Buffer.byteLength(md) }));
  } catch (e) { console.log(JSON.stringify({ ok: false, error: String(e.message || e) })); process.exit(1); }
}
