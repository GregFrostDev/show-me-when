// sched-prod incident board. Plan R1-R6; issues SCHED-4511 (live list + Ack), 4512 (loader), 4513 (refresh), 4514 (local times).
// Incident fields come from the API and are data: they reach the page only as text (textContent, dataset), never as HTML.
import { fetchIncidents, ack } from './api.js';
import { formatLocal } from './time.js';

export const REFRESH_MS = 2000; // R4: the board refreshes itself every 2 seconds while open.

const board = document.querySelector('[data-testid="board"]');
const list = document.querySelector('[data-testid="incident-list"]');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const status = document.querySelector('[data-role="status"]');

const acked = new Map(); // incident id -> ackedAt (ISO), kept across refreshes
const pending = new Set(); // incident ids with an ack in flight
const ackErrors = new Map(); // incident id -> error text shown in its row
const firstSeen = new Map(); // incident id -> ms when this board first showed it
const nodes = new Map(); // incident id -> { li, c, actSig }: rows are kept and patched, not rebuilt, so a click is never lost to a refresh
let loaded = false;
let current = [];
export const NEW_MS = 10000; // a row that came in after the first load is marked new for 10 s

// R1: newest first by openedAt; equal times keep the API's order.
export function newestFirst(incidents) {
  return incidents
    .map((inc, n) => ({ inc, n, t: Date.parse(inc.openedAt) }))
    .sort((a, b) => (Number.isNaN(b.t) ? -1 : Number.isNaN(a.t) ? 1 : b.t - a.t) || a.n - b.n)
    .map((x) => x.inc);
}

function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

// Set text or an attribute only when it changed, so a refresh does not touch what the viewer is using.
const setText = (e, v) => { if (e.textContent !== v) e.textContent = v; };
const setAttr = (e, k, v) => { if (e.getAttribute(k) !== v) e.setAttribute(k, v); };

function skeleton(id) {
  const li = el('li', { 'data-testid': 'incident-row', class: 'row' });
  li.dataset.id = id;
  const c = { id: el('span', { class: 'id' }), sev: el('span', { class: 'sev' }), what: el('span', { class: 'what' }),
    when: el('span', { class: 'when' }), time: el('time'), tz: el('span', { class: 'tz' }), act: el('span', { class: 'act' }) };
  c.when.append(c.time, c.tz);
  li.append(c.id, c.sev, c.what, c.when, c.act);
  return { li, c, actSig: null, sev: null };
}

function update(n, inc) {
  const id = String(inc.id);
  const { li, c } = n;
  setText(c.id, id);
  const sev = String(inc.severity ?? '');
  if (n.sev !== sev) { if (n.sev && /^sev\d$/.test(n.sev)) li.classList.remove(n.sev); if (/^sev\d$/.test(sev)) li.classList.add(sev); n.sev = sev; }
  setText(c.sev, sev);
  setText(c.what, [inc.service, inc.region, inc.summary].map((x) => String(x ?? '')).join(' · '));
  const iso = String(inc.openedAt ?? '');
  setAttr(c.time, 'datetime', iso); // R5: the full UTC value stays in the attribute
  try {
    const { text, zone } = formatLocal(inc.openedAt);
    setText(c.time, text);
    setText(c.tz, zone);
    setAttr(c.time, 'title', `${zone} · UTC ${iso}`);
  } catch {
    setText(c.time, iso || 'no time');
    setText(c.tz, '');
  }
  const ackedAt = acked.get(id) || inc.ackedAt;
  const actSig = JSON.stringify([ackedAt || null, pending.has(id), ackErrors.get(id) || null]);
  if (actSig === n.actSig) return;
  n.actSig = actSig;
  li.classList.toggle('acked', Boolean(ackedAt));
  if (ackedAt) {
    let when = '';
    try { when = ` ${formatLocal(ackedAt).text.split(', ').at(-1)}`; } catch { /* show the mark without a time */ }
    c.act.replaceChildren(el('span', { 'data-testid': 'acked', class: 'acked-mark', title: `acked ${ackedAt}` }, `✓ acked${when}`));
    return;
  }
  let btn = c.act.querySelector('[data-testid="ack"]');
  if (!btn) {
    btn = el('button', { type: 'button', 'data-testid': 'ack', class: 'ack' });
    btn.addEventListener('click', () => askAck(id)); // product (step 2): Ack asks to confirm, and the confirm names the incident id
  }
  setText(btn, pending.has(id) ? 'Acking…' : 'Ack');
  btn.disabled = pending.has(id);
  const parts = [btn];
  if (ackErrors.has(id)) parts.push(el('span', { class: 'ack-error', role: 'alert' }, ackErrors.get(id)));
  c.act.replaceChildren(...parts);
}

function render() {
  const now = Date.now();
  const want = current.map((inc) => {
    const id = String(inc.id);
    let n = nodes.get(id);
    if (!n) { n = skeleton(id); nodes.set(id, n); }
    update(n, inc);
    n.li.classList.toggle('new', firstSeen.has(id) && now - firstSeen.get(id) < NEW_MS);
    return n.li;
  });
  const ids = new Set(current.map((i) => String(i.id)));
  for (const id of nodes.keys()) if (!ids.has(id)) nodes.delete(id);
  const same = want.length === list.children.length && want.every((li, k) => list.children[k] === li);
  if (!same) list.replaceChildren(...want);
  empty.hidden = current.length > 0;
  board.setAttribute('aria-busy', 'false');
}

// Product's decision (step 2): new incidents stay live at the top and Ack stays on the row, but Ack asks to confirm, and the
// confirm names the incident id. The confirm sits outside the list, in a fixed place, so a refresh never moves it; while it
// is open, a backdrop takes every click outside it (and does not close it), so a row that moved cannot be acked by mistake.
let confirmFor = null;
const backdrop = el('div', { class: 'confirm-backdrop', hidden: '' });
const confirmText = el('p', { 'data-testid': 'confirm-text', id: 'confirm-text' });
const confirmAck = el('button', { type: 'button', 'data-testid': 'confirm-ack', class: 'ack' });
const confirmCancel = el('button', { type: 'button', 'data-testid': 'confirm-cancel', class: 'ack cancel' }, 'Cancel');
const confirmBox = el('div', { 'data-testid': 'confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-text', class: 'confirm', hidden: '' });
confirmBox.append(confirmText, el('div', { class: 'confirm-actions' }), backdrop);
confirmBox.querySelector('.confirm-actions').append(confirmAck, confirmCancel);
confirmBox.removeChild(backdrop);
document.body.append(backdrop, confirmBox);

export function askAck(id) {
  if (pending.has(id) || acked.has(id) || confirmFor) return;
  const inc = current.find((i) => String(i.id) === id);
  confirmFor = id;
  confirmBox.dataset.id = id;
  confirmText.textContent = `Ack ${id}${inc && inc.summary ? ` (${[inc.service, inc.summary].map((x) => String(x ?? '')).join(' · ')})` : ''}?`;
  confirmAck.textContent = `Ack ${id}`;
  backdrop.hidden = false;
  confirmBox.hidden = false;
  confirmCancel.focus(); // the safe choice has the focus
}
function closeConfirm() {
  confirmFor = null;
  delete confirmBox.dataset.id;
  confirmBox.hidden = true;
  backdrop.hidden = true;
}
confirmAck.addEventListener('click', () => { const id = confirmFor; closeConfirm(); if (id) onAck(id); });
confirmCancel.addEventListener('click', closeConfirm);
backdrop.addEventListener('click', (e) => e.stopPropagation()); // takes the click; only Cancel or Escape closes the confirm
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && confirmFor) closeConfirm(); });

async function onAck(id) {
  if (pending.has(id) || acked.has(id)) return; // one ack per row: a double click sends one request
  pending.add(id);
  ackErrors.delete(id);
  render();
  try {
    const reply = await ack(id); // R2: api.ack(id) sends the latest cursor and keeps the receipt in `acks`
    if (!reply || String(reply.id) !== id) throw new Error(`the reply names ${reply && reply.id}, not ${id}`);
    acked.set(id, reply.ackedAt || new Date().toISOString());
  } catch (err) {
    ackErrors.set(id, `Ack for ${id} failed: ${String(err.message || err).slice(0, 160)}. Press Ack again.`);
  } finally {
    pending.delete(id);
    render();
  }
}

function setStatus(text) {
  status.textContent = text;
  status.hidden = !text;
}

async function refresh() {
  const started = Date.now();
  try {
    const page = await fetchIncidents();
    current = newestFirst(Array.isArray(page.incidents) ? page.incidents : []);
    for (const i of current) if (!firstSeen.has(String(i.id))) firstSeen.set(String(i.id), loaded ? Date.now() : -Infinity);
    loaded = true;
    if (loader) loader.remove(); // R3: the loader is gone once incidents load
    render();
    setStatus('');
    board.dataset.updatedAt = String(page.updatedAt ?? '');
  } catch (err) {
    setStatus(`Could not load incidents: ${String(err.message || err).slice(0, 200)}. Trying again in ${REFRESH_MS / 1000} s.`);
  } finally {
    // R4: one request at a time, a new one every REFRESH_MS from the start of the last.
    setTimeout(refresh, Math.max(0, REFRESH_MS - (Date.now() - started)));
  }
}

refresh();
