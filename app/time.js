// SCHED-4514 (R5): an incident time in the viewer's own time zone and date order.
// EU locales always read day before month (dd/mm), also where Intl's own default is year first (sv, lt, hu).
// The full UTC value stays in <time datetime> (app.js); this module only makes the visible text.

// EU-27 member states (ISO 3166-1 alpha-2).
const EU_REGIONS = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' '));
// Languages whose bare tag (no region, e.g. "de") means an EU locale. "en" alone is not one (Intl reads it as en-US).
const EU_LANGUAGES = new Set('bg hr cs da nl et fi fr de el hu ga it lv lt mt pl pt ro sk sl es sv'.split(' '));

export function isEuLocale(tag) {
  let loc;
  try { loc = new Intl.Locale(tag); } catch { return false; }
  return loc.region ? EU_REGIONS.has(loc.region) : EU_LANGUAGES.has(loc.language);
}

/**
 * Visible text for an ISO time, in `timeZone` (default: the viewer's) and `locale` (default: the viewer's).
 * Returns { text, zone }: text like "24/11/2026, 16:11" (EU) or "11/24/2026, 4:11 PM" (en-US); zone like "NZDT".
 * Throws on a value that is not a valid date, so the caller can show the raw value instead of a wrong one.
 */
export function formatLocal(iso, { locale, timeZone } = {}) {
  const d = new Date(iso);
  if (typeof iso !== 'string' || Number.isNaN(d.getTime())) throw new Error(`not a time: ${String(iso).slice(0, 40)}`);
  const resolved = new Intl.DateTimeFormat(locale).resolvedOptions();
  const loc = resolved.locale;
  const tz = timeZone || resolved.timeZone;
  const parts = new Intl.DateTimeFormat(loc, {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).formatToParts(d);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  const order = parts.filter((p) => ['day', 'month', 'year'].includes(p.type)).map((p) => p.type);
  const dateOrder = isEuLocale(loc) ? ['day', 'month', 'year'] : order;
  const date = dateOrder.map(get).join('/');
  const dayPeriod = get('dayPeriod');
  const clock = `${get('hour')}:${get('minute')}${dayPeriod ? ` ${dayPeriod}` : ''}`;
  return { text: `${date}, ${clock}`, zone: get('timeZoneName') || tz };
}
