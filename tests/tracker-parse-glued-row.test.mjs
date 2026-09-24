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
// reused here, not a second parser — because the set-status.mjs note-append
// path and canonical writers that resolve rows through parseTrackerRow use it.
import { pass, fail } from './helpers.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';

console.log('\ntracker-parse.mjs — glued-row rejection (#1127/#1128, #2003/#2004, #2123/#2124)');

const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |';
const SEP = '|---|------|---------|------|-------|--------|-----|--------|-------|';
const colmap = resolveColumns([HEADER, SEP]);

{
  const customHeader = '| # | Date | Company | Priority | Role | Score | Status | PDF | Report | Notes |';
  const customMap = resolveColumns([customHeader]);
  const row = '| 42 | 2026-01-01 | Acme | 2 | Director | 4.0/5 | Evaluated | ❌ | [42](../reports/42-acme.md) | notes here |';
  const parsed = parseTrackerRow(row, customMap);
  if (parsed && parsed.num === 42 && parsed.role === 'Director' && parsed.notes === 'notes here') {
    pass('a numeric Priority cell in a custom layout remains a valid row');
  } else {
    fail(`custom row with numeric Priority was rejected or misparsed: ${JSON.stringify(parsed)}`);
  }
}

{
  const customHeader = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | Priority |';
  const customMap = resolveColumns([customHeader]);
  const first = '| 1127 | 2026-09-06 | Wellhub | Staff PM | 4.3/5 | Applied | ✅ | [1127](../reports/1127-wellhub.md) | sent | 2 |';
  const second = '| 1128 | 2026-09-06 | Jobgether | PM | 3.7/5 | Discarded | ✅ | [1128](../reports/1128-jobgether.md) | later | 1 |';
  const parsed = parseTrackerRow(first, customMap);
  if (parsed && parsed.num === 1127 && parsed.notes === 'sent') {
    pass('a row with a trailing custom Priority column still parses');
  } else {
    fail(`row with trailing custom Priority was rejected or misparsed: ${JSON.stringify(parsed)}`);
  }
  const glued = parseTrackerRow(first + second, customMap);
  if (glued === null) {
    pass('glued rows after a trailing custom Priority column are rejected');
  } else {
    fail(`glued rows after trailing custom Priority were accepted: ${JSON.stringify(glued)}`);
  }
  const firstWithoutTrailingPipe = first.slice(0, -1);
  const singleWithoutTrailingPipe = parseTrackerRow(firstWithoutTrailingPipe, customMap);
  if (singleWithoutTrailingPipe?.num === 1127) {
    pass('a single row without a trailing pipe still parses');
  } else {
    fail(`single row without a trailing pipe was rejected: ${JSON.stringify(singleWithoutTrailingPipe)}`);
  }
  const gluedAfterFirstWithoutTrailingPipe = parseTrackerRow(firstWithoutTrailingPipe + second, customMap);
  if (gluedAfterFirstWithoutTrailingPipe === null) {
    pass('glued rows are rejected when the first row has no trailing pipe');
  } else {
    fail(`glued rows without a first trailing pipe were accepted: ${JSON.stringify(gluedAfterFirstWithoutTrailingPipe)}`);
  }
  const gluedBeforeSecondWithoutTrailingPipe = parseTrackerRow(first + second.slice(0, -1), customMap);
  if (gluedBeforeSecondWithoutTrailingPipe === null) {
    pass('glued rows are rejected when the last row has no trailing pipe');
  } else {
    fail(`glued rows without a last trailing pipe were accepted: ${JSON.stringify(gluedBeforeSecondWithoutTrailingPipe)}`);
  }
}

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

{
  const row = '| 42 | 2026-01-01 | Acme | Director | 4.0/5 | Evaluated | ❌ | [42](../reports/42-acme.md) | notes here | extra |';
  const parsed = parseTrackerRow(row, colmap);
  if (parsed?.num === 42 && parsed.notes === 'notes here') {
    pass('surplus cells without a second row-start signature remain parseable');
  } else {
    fail(`surplus cells without a second row start were rejected: ${JSON.stringify(parsed)}`);
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
