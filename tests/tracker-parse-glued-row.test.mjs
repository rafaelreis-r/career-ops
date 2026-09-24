// tests/tracker-parse-glued-row.test.mjs — parseTrackerRow must refuse a
// physical line carrying two tracker rows glued together.
//
// 2026-09-23: three rows across tracks B and C (product #1127/#1128, ops
// #2003/#2004 and #2123/#2124) ended up on ONE physical line each — a
// set-status.mjs `--note` write landed on a row whose own trailing pipe was
// directly followed, with no `\n`, by the next row's leading pipe. #1428/#3016's
// width guard (`parts.length < width`) only rejects a row that is too SHORT; a
// glued line is wider than one row, so it sailed through, and the write that
// appended the note silently reassembled BOTH rows into the file as one line
// instead of refusing. The fix lives in tracker-parse.mjs's parseTrackerRow —
// reused here, not a second parser — because that is the one function every
// tracker writer (set-status.mjs, merge-tracker.mjs, mark-pdf-ready.mjs) calls
// to decide whether a line is a row worth touching.
import { pass, fail } from './helpers.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';

console.log('\ntracker-parse.mjs — glued-row rejection (#1127/#1128, #2003/#2004, #2123/#2124)');

const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |';
const SEP = '|---|------|---------|------|-------|--------|-----|--------|-------|';
const colmap = resolveColumns([HEADER, SEP]);

// ── Control: an ordinary well-formed row still parses ───────────────────────
{
  const row = '| 1127 | 2026-09-06 | Wellhub | Staff PM | 4.3/5 | Applied | ✅ | [1127](../reports/1127-wellhub.md) | fixed Staff base. |';
  const parsed = parseTrackerRow(row, colmap);
  if (parsed && parsed.num === 1127 && parsed.company === 'Wellhub' && parsed.notes === 'fixed Staff base.') {
    pass('an ordinary single row still parses (the guard does not over-fire)');
  } else {
    fail(`ordinary row wrongly rejected or misparsed: ${JSON.stringify(parsed)}`);
  }
}

// ── The exact incident shape: row #1127's own note directly followed, with no
// \n, by row #1128's leading pipe. Byte-for-byte the seam career-ops-product's
// data/applications.md line 111 actually shows.
{
  const glued =
    '| 1127 | 2026-09-06 | Wellhub | Staff PM | 4.3/5 | Applied | ✅ | [1127](../reports/1127-wellhub.md) | ' +
    'fixed Staff base.; enviada pelo capitao em 2026-09-23, confirmacao do empregador na tela || ' +
    '1128 | 2026-09-06 | ? | Travel eSIM PM | 3.7/5 | Discarded | ✅ | [1128](../reports/1128-jobgether.md) | Ask Jobgether for scope. |';
  const parsed = parseTrackerRow(glued, colmap);
  if (parsed === null) {
    pass('a line carrying two glued rows is rejected outright (returns null)');
  } else {
    fail(`glued line was accepted as one row: ${JSON.stringify(parsed)}`);
  }
}

// ── A report link's own digits ("[1127](...)") must not trip the guard: the
// bracket breaks the `| <digits> |` shape, so a normal row with only ONE bare
// numeric cell (its own #) is never mistaken for a glued pair.
{
  const row = '| 42 | 2026-01-01 | Acme | Director | 4.0/5 | Evaluated | ❌ | [42](../reports/42-acme.md) | notes here |';
  const parsed = parseTrackerRow(row, colmap);
  if (parsed && parsed.num === 42) {
    pass('a bracketed report-link number does not falsely trigger the glued-row guard');
  } else {
    fail(`row with a report-link number was wrongly rejected: ${JSON.stringify(parsed)}`);
  }
}

// ── Three glued rows on one line (in case a future incident chains more than
// two) must also be rejected, not merely tolerated up to two.
{
  const glued3 =
    '| 1 | 2026-01-01 | A | R | 4/5 | Evaluated | ❌ | [1](r/1.md) | n1 |' +
    '| 2 | 2026-01-01 | B | R | 4/5 | Evaluated | ❌ | [2](r/2.md) | n2 |' +
    '| 3 | 2026-01-01 | C | R | 4/5 | Evaluated | ❌ | [3](r/3.md) | n3 |';
  const parsed = parseTrackerRow(glued3, colmap);
  if (parsed === null) {
    pass('three rows glued onto one line are also rejected');
  } else {
    fail(`triple-glued line was accepted: ${JSON.stringify(parsed)}`);
  }
}
