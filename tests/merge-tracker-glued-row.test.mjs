// tests/merge-tracker-glued-row.test.mjs — merge-tracker.mjs must never delete a
// tracker row that shares a physical line with the row being replaced.
//
// 2026-09-24 review finding: #1127 and #1128 sit glued on ONE physical line
// (`... |<next row>| 1128 | ...`). merge-tracker's parseAppLine parsed that line
// as row #1127 with `raw` = the whole line, so a re-evaluation of #1127
// replaced the physical line with the rebuilt #1127 and #1128 vanished. The fix
// reuses tracker-parse.mjs's glued-row guard (the one parseTrackerRow applies);
// this drives the real CLI end-to-end.
import { pass, fail } from './helpers.mjs';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MERGE = join(HERE, '..', 'merge-tracker.mjs');
const ok = (name, fn) => { try { fn(); pass(name); } catch (e) { fail(`${name} — ${e.message}`); } };

const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |';
const SEP = '|---|------|---------|------|-------|--------|-----|--------|-------|';
const ROW_5 = '| 5 | 2026-06-05 | Umbrella | Platform Eng | 3.9/5 | Evaluated | ❌ | [5](../reports/005-umbrella-2026-06-05.md) | pipeline heavy |';
const ROW_1127 = '| 1127 | 2026-09-06 | Wellhub | Staff PM | 4.0/5 | Evaluated | ✅ | [1127](../reports/1127-wellhub.md) | fixed Staff base. |';
const ROW_1128 = '| 1128 | 2026-09-06 | Jobgether | Travel eSIM PM | 3.7/5 | Discarded | ✅ | [1128](../reports/1128-jobgether.md) | Ask Jobgether for scope. |';
const ROW_6 = '| 6 | 2026-06-06 | Hooli | Backend Eng | 4.1/5 | Evaluated | ❌ | [6](../reports/006-hooli-2026-06-06.md) | — |';
const GLUED = ROW_1127 + ROW_1128;

function run(rows, tsvs) {
  const base = mkdtempSync(join(tmpdir(), 'merge-glued-test-'));
  try {
    const addDir = join(base, 'additions');
    mkdirSync(join(base, 'data'), { recursive: true });
    mkdirSync(addDir, { recursive: true });
    const tracker = join(base, 'data', 'applications.md');
    writeFileSync(tracker, ['# Applications Tracker', '', HEADER, SEP, ...rows, ''].join('\n'));
    for (const [name, cols] of Object.entries(tsvs)) writeFileSync(join(addDir, name), cols.join('\t'));
    const stdout = execFileSync('node', [MERGE], {
      encoding: 'utf-8',
      env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: addDir },
    });
    return { stdout, lines: readFileSync(tracker, 'utf-8').split('\n') };
  } finally { rmSync(base, { recursive: true, force: true }); }
}

console.log('\nmerge-tracker — glued tracker rows survive a re-evaluation');

ok('THE BUG: re-evaluating #1127 keeps the glued #1128 and leaves the glued line byte-identical', () => {
  const { lines } = run([ROW_5, GLUED, ROW_6], {
    // Same company+role as #1127, higher score: this is the replace path.
    '1127-wellhub.tsv': ['1127', '2026-10-01', 'Wellhub', 'Staff PM', 'Evaluated', '4.6/5', '✅', '[1127](../reports/1127-wellhub.md)', 'second pass'],
  });
  assert.ok(lines.includes(GLUED), 'the glued physical line must be preserved verbatim');
  const all = lines.join('\n');
  assert.ok(all.includes('Travel eSIM PM') && all.includes('Ask Jobgether for scope.'), '#1128 content must survive');
  assert.ok(lines.includes(ROW_5) && lines.includes(ROW_6), 'neighbouring rows untouched');
});

ok('the re-evaluation is not lost and does not reuse the glued #1128 number', () => {
  const { lines } = run([ROW_5, GLUED, ROW_6], {
    '1127-wellhub.tsv': ['1127', '2026-10-01', 'Wellhub', 'Staff PM', 'Evaluated', '4.6/5', '✅', '[1127](../reports/1127-wellhub.md)', 'second pass'],
  });
  const appended = lines.filter(l => l.startsWith('|') && l !== GLUED && l.includes('second pass'));
  assert.equal(appended.length, 1, `expected the re-evaluation to be appended once, got ${appended.length}`);
  const num = parseInt(appended[0].split('|')[1], 10);
  assert.ok(num !== 1127 && num !== 1128, `appended row reused a glued number: #${num}`);
});

ok('MUST NOT CHANGE: a well-formed row still updates in place', () => {
  const { lines } = run([ROW_5, GLUED, ROW_6], {
    '6-hooli.tsv': ['6', '2026-10-01', 'Hooli', 'Backend Eng', 'Evaluated', '4.8/5', '❌', '[6](../reports/006-hooli-2026-06-06.md)', 'rescored'],
  });
  const hooli = lines.filter(l => l.includes('Hooli'));
  assert.equal(hooli.length, 1, 'Hooli row updated in place, not duplicated');
  assert.ok(hooli[0].includes('4.8/5'), 'score updated');
  assert.ok(lines.includes(GLUED), 'glued line untouched');
});
