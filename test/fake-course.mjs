// A fake of the course's incident API plus a static server for the built board, for local tests and rehearsals.
// Shapes come from the real replies in ../../samples/incidents-reply.json (GET /incidents: whole current list each call,
// a new cursor each call, the 400 body for a cursor from elsewhere). The ack reply follows the README shape
// { id, ackedAt, receipt } only: no real ack reply was read (the hub keeps acks off the live course until the deploy).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'incidents-reply.json'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm' };

// The real 400 for a cursor from elsewhere, word for word (samples/incidents-reply.json badSince).
export const BAD_CURSOR = { message: 'That cursor is not from this session. Load the board again (poll without since) to start over.', error: 'Bad Request', statusCode: 400 };

export function startFake({ dist: distDir, session, incidents = SAMPLE.first.body.incidents, port = 0 } = {}) {
  let dist = distDir;
  const state = {
    incidents: structuredClone(incidents),
    cursors: [], // every cursor issued, in order
    calls: [], // { path, at, since, end } for every API call
    acks: [], // { id, cursor, latest, at }
    delayMs: 0, // delay for /incidents replies
    failIncidents: 0, // next N /incidents calls answer this fake's 400
    ackDelayMs: 0,
    failAck: 0, // next N acks answer 500
    slide: false, // like the live API (log.md 23:28Z): every reply moves each openedAt to "now minus its offset"
    inFlight: 0,
    maxInFlight: 0,
  };
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'private, no-store' });
    res.end(JSON.stringify(body));
  };
  const newCursor = () => { const c = crypto.randomBytes(24).toString('base64url'); state.cursors.push(c); return c; };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      const call = { path: url.pathname, at: Date.now(), since: url.searchParams.get('since') };
      state.calls.push(call);
      if (url.searchParams.get('t') !== session) return json(res, 400, { message: 'Unknown session (fake).', error: 'Bad Request', statusCode: 400 });
      if (url.pathname === '/api/incidents') {
        state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
        state.inFlight--; call.end = Date.now();
        if (state.failIncidents > 0) { state.failIncidents--; return json(res, 503, { message: 'fake outage', error: 'Service Unavailable', statusCode: 503 }); }
        const since = url.searchParams.get('since');
        if (since && !state.cursors.includes(since)) return json(res, 400, BAD_CURSOR);
        const list = state.slide ? state.incidents.map((i) => ({ ...i, openedAt: new Date(Date.now() - (i.offsetMs ??= Math.max(0, Date.now() - Date.parse(i.openedAt)))).toISOString() })) : state.incidents;
        return json(res, 200, { updatedAt: new Date().toISOString(), incidents: list.map(({ offsetMs, ...i }) => i), cursor: newCursor() });
      }
      if (url.pathname === '/api/ack') {
        const id = url.searchParams.get('id');
        const cursor = url.searchParams.get('cursor');
        if (state.ackDelayMs) await new Promise((r) => setTimeout(r, state.ackDelayMs));
        state.acks.push({ id, cursor, latest: cursor === state.cursors.at(-1), at: Date.now() });
        if (state.failAck > 0) { state.failAck--; return json(res, 500, { message: 'fake ack failure', error: 'Internal Server Error', statusCode: 500 }); }
        if (!state.incidents.some((i) => i.id === id)) return json(res, 404, { message: `No incident ${id} (fake).`, error: 'Not Found', statusCode: 404 });
        return json(res, 200, { id, ackedAt: new Date().toISOString(), receipt: `fake-receipt-${state.acks.length}-${id}` });
      }
      return json(res, 404, { message: 'no such call (fake)', error: 'Not Found', statusCode: 404 });
    }
    // static files of the built board
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(dist, rel);
    if (!file.startsWith(path.resolve(dist) + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, api: `${base}/api`, state, setDist: (d) => { dist = d; }, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) });
  }));
}

// `node test/fake-course.mjs <dist> <session file> [port]`: run the fake for a rehearsal in a browser.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dist, sessionFile, port] = process.argv.slice(2);
  const session = fs.readFileSync(sessionFile, 'utf8').trim();
  const f = await startFake({ dist, session, port: Number(port || 0) });
  console.log(`fake course: board ${f.base}/ api ${f.api}`);
  // a new incident every 20 s, so watch-board has something to show
  let n = 0;
  setInterval(() => {
    n++;
    f.state.incidents.unshift({ id: `INC-${7000 + n}`, service: 'booking-api', region: 'eu-central', summary: `rehearsal incident ${n}`, severity: 'sev2', openedAt: new Date().toISOString() });
  }, 20000);
}
