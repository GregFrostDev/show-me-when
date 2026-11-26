// R1 (Sol, claim 2): a race-mode ack counts only when it has a receipt, it hit the incident that landed, and that is not the row meant.
// Returns null when the race counts, else { field, error } for record.mjs to throw.
// With the step-2 confirm (caught = the id the first confirm named), the race counts when the confirm caught the landed
// incident and the final ack went to the row meant.
export function raceVerdict({ meant, landed, hit, receipt, caught = null }) {
  if (![meant, landed, hit].every((x) => String(x || '').trim())) return { field: 'race', error: `missing id: meant ${meant}, landed ${landed}, hit ${hit}` };
  if (!String(receipt || '').trim()) return { field: 'receipt', error: `the ack of ${hit} has no receipt in its console line` };
  if (caught) return caught === landed && hit === meant ? null : { field: 'race', error: `the confirm caught ${caught} (landed ${landed}) but the Ack went to ${hit}, not ${meant}` };
  if (hit === meant || hit !== landed) return { field: 'race', error: `no misbehaviour caught: meant ${meant}, landed ${landed}, the Ack went to ${hit}; run again` };
  return null;
}
