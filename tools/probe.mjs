#!/usr/bin/env node
// Read-only probe of the course's incident API: GET /incidents twice (no since, then since=<cursor>).
// Never calls /ack. Reads the session from the session file; prints and saves replies with the session masked.
// Usage: node tools/probe.mjs <session file> <out.json> [api base]
import fs from 'node:fs';

const [sessionFile, out, apiArg] = process.argv.slice(2);
if (!sessionFile || !out) { console.error('usage: node tools/probe.mjs <session file> <out.json> [api base]'); process.exit(2); }
const API = apiArg || 'https://hq.mega.dev/challenges/show-me-when/api';
const SESSION = fs.readFileSync(sessionFile, 'utf8').trim();
const mask = (s) => String(s).split(SESSION).join('v1.eyJ...<masked>');

async function get(path, params) {
  const url = new URL(`${API}/${path}`);
  url.searchParams.set('t', SESSION);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const at = new Date().toISOString();
  const res = await fetch(url, { headers: { Origin: 'https://board.example' } });
  const text = await res.text();
  const headers = {};
  for (const h of ['content-type', 'access-control-allow-origin', 'cache-control', 'retry-after']) if (res.headers.get(h)) headers[h] = res.headers.get(h);
  let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 2000); }
  return { at, request: mask(url.toString()), status: res.status, headers, body: JSON.parse(mask(JSON.stringify(body))) };
}

const first = await get('incidents');
const cursor = first.body && first.body.cursor;
const second = cursor ? await get('incidents', { since: cursor }) : null;
const bad = await get('incidents', { since: 'not-a-cursor' });
const result = { api: API, first, second, badSince: bad };
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(mask(JSON.stringify({ first: { status: first.status, n: first.body?.incidents?.length, keys: Object.keys(first.body || {}) }, second: second && { status: second.status, n: second.body?.incidents?.length }, bad: { status: bad.status } })));
