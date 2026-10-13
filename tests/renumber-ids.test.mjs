import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { applyPlan, parseIdMap, planShared, planTrack, writePlan } from '../renumber-ids.mjs';
import { canonicalizeTrackerPath, trackerLockDirFor } from '../tracker-utils.mjs';
import { isNestedCheckout } from '../lib/mjs-files.mjs';
import { NODE, ROOT, rmSync } from './helpers.mjs';

// One fixture per data format the migration touches (tracker, reports and
// their bodies, pipeline, ledger, follow-ups, pdf-index, jds, outcomes,
// follow-up drafts, application packets, output files, anchors, backups and a
// shared-file symlink).
const TRACKER_A = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|-----|------|-------|--------|-----|--------|-------|',
  '| 25 | 2026-08-04 | Nortal | — | DevOps | 2.8/5 | SKIP | ✅ | [25](../reports/025-nortal-2026-08-04.md) | Story #1 fits; see #056 and #9999; req 1057 |',
  '| 56 | 2026-08-07 | Articul8 | — | Infra | 3.8/5 | Applied | ✅ | [056](../reports/056-articul8-2026-08-07.md) | PDF at output/cv-candidate-articul8-056-2026-08-07.pdf |',
  '| 17 | 2026-08-07 | Remote | — | SRE | 3.5/5 | Applied | ✅ | [17](../reports/017-remote-2026-08-07.md) | follow-up in data/followup-drafts/17-remote.md |',
  '| 1037 | 2026-09-21 | Kosli | — | Solutions | 1.9/5 | SKIP | ❌ | [1037](../reports/1037-kosli-2026-09-21.md) | Lisbon only |',
  '| 3244 | 2026-10-08 | Anterior | TurnKey | EM | 3.3/5 | Rejected | ✅ | [3255](../reports/3255-anterior-2026-10-08.md) | duplicate # of #3244/#3255 |',
  '| 3244 | 2026-10-08 | GitLab | — | CX Platform | 3.3/5 | Applied | ✅ | [3244](../reports/3244-gitlab-2026-10-08.md) | PDF at output/cv-candidate-gitlab-3244-2026-10-08.pdf; https://example.com/jobs#3244 |',
  '',
].join('\n');

function write(root, rel, content) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function trackA(dir) {
  const root = join(dir, 'A');
  write(root, 'data/applications.md', TRACKER_A);
  write(root, 'reports/025-nortal-2026-08-04.md', '# Nortal\n\nSee [the earlier one](056-articul8-2026-08-07.md) and #3244.\n');
  write(root, 'reports/056-articul8-2026-08-07.md', '# Articul8 #056\n\nJD: [jd](../jds/056-articul8.md)\n');
  write(root, 'reports/017-remote-2026-08-07.md', '# Remote\n');
  write(root, 'reports/1037-kosli-2026-09-21.md', '# Kosli\n');
  write(root, 'reports/3244-gitlab-2026-10-08.md', '# GitLab\n\nCV: `output/cv-candidate-gitlab-3244-2026-10-08.pdf`\n');
  write(root, 'reports/3255-anterior-2026-10-08.md', '# Anterior\n');
  write(root, 'reports/331-picpay-2026-08-22.md.bak', 'old copy citing #056\n');
  write(root, 'reports/999REAL-ciandt-2026-09-18.md', '# not a numbered report\n');
  write(root, 'reports/2026-08-12.md', '# scan digest\n');
  write(root, 'data/pipeline.md', [
    '# Pipeline',
    '',
    '- [x] #25 | https://jobs.example.com/a#123 | Nortal | DevOps | 2.8/5 | report: [025](../reports/025-nortal-2026-08-04.md)',
    '- [x] [3244](../reports/3244-gitlab-2026-10-08.md) | https://example.com/gitlab | GitLab | CX | 3.3/5 | PDF ✅',
    '- [ ] https://example.com/new | New Co | Role',
    '',
  ].join('\n'));
  write(root, 'data/status-log.tsv', [
    '25\t2026-08-05\tEvaluated\tSKIP\tset-status\t',
    '3244\t2026-10-08\tEvaluated\tApplied\tset-status\t',
    '3244\t2026-10-11\tEvaluated\tApplied\tset-status\t',
    '3244\t2026-10-11\tApplied\tRejected\tset-status\t',
    '',
  ].join('\n'));
  write(root, 'data/follow-ups.md', [
    '# Follow-ups',
    '',
    '| num | appNum | date | company | role | channel | contact | notes |',
    '|---|---|---|---|---|---|---|---|',
    '| 1 | 17 | 2026-08-24 | Remote | SRE | LinkedIn | Clara | asked about #056 too |',
    '',
    '- next #17 2026-08-31 (set 2026-08-24)',
    '- next #3244 2026-10-15 (set 2026-10-08)',
    '- 2026-08-12 · #56 Articul8 — sent',
    '',
  ].join('\n'));
  write(root, 'data/pdf-index.tsv', [
    '# report\tpdf\thtml\tformat\tdate — written by generate-pdf.mjs, do not edit',
    '056\toutput/cv-candidate-articul8-056-2026-08-07.pdf\toutput/cv-candidate-articul8-056.html\ta4\t2026-08-07',
    '3244\toutput/cv-candidate-gitlab-3244-2026-10-08.pdf\toutput/cv-candidate-gitlab-3244.html\tletter\t2026-10-08',
    '',
  ].join('\n'));
  write(root, 'data/followup-drafts/17-remote.md', 'Draft for [remote](../../reports/017-remote-2026-08-07.md)\n');
  write(root, 'data/outcomes/56_articul8_infra/outcome.md', 'Outcome of reports/056-articul8-2026-08-07.md\n');
  write(root, 'data/application-packets/2026-08-31/001-056-articul8.md', '- **Tracker:** #056\n- **Report:** `reports/056-articul8-2026-08-07.md`\n');
  write(root, 'jds/056-articul8.md', 'JD text\n');
  write(root, 'jds/scraped-no-number.md', 'JD text\n');
  write(root, 'output/cv-candidate-articul8-056-2026-08-07.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]));
  write(root, 'output/cv-candidate-articul8-056.html', '<html>cv</html>\n');
  write(root, 'output/cv-candidate-gitlab-3244-2026-10-08.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46]));
  write(root, 'output/cv-candidate-gitlab-3244.html', '<html>cv</html>\n');
  write(root, 'output/cv-rafael-reis-amazon-top-10-2026-08-07.pdf', 'x');
  write(root, 'output/contacto/3244-gitlab.md', 'Report: [3244](../../reports/3244-gitlab-2026-10-08.md)\n');
  write(root, 'output/2026-09-07-notes.md', 'dated note citing output/cv-candidate-gitlab-3244.html\n');
  write(root, 'output/.tracker-before-2026-10-08.md', '| 3244 | x | [3244](../reports/3244-gitlab-2026-10-08.md) |\n');
  write(dir, 'shared/contacts.tsv', 'x\n');
  symlinkSync(join(dir, 'shared/contacts.tsv'), join(root, 'data/contacts.tsv'));
  return root;
}

function trackB(dir) {
  const root = join(dir, 'B');
  write(root, 'data/applications.md', [
    '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| 1037 | 2026-08-22 | ClickHouse | — | PM | 3.0/5 | Applied | ✅ | [1037](../reports/1037-clickhouse-2026-08-22.md) | |',
    '',
  ].join('\n'));
  write(root, 'reports/1037-clickhouse-2026-08-22.md', '# ClickHouse\n');
  write(root, 'reports/999-faixa-inicial.md', '# Âncora da faixa\n\nNão apagar.\n');
  return root;
}

/** Every path under `root` with its bytes (or symlink target), for byte-exact comparison. */
function treeOf(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join('/');
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out[rel] = `-> ${readlinkSync(full)}`;
      else if (!st.isDirectory()) out[rel] = readFileSync(full).toString('base64');
      else {
        out[`${rel}/`] = 'dir';
        if (!isNestedCheckout(full)) walk(full);
      }
    }
  };
  walk(root);
  return out;
}

const LEDGER_A = ['3244@2026-10-08=103244', '3244@2026-10-11=103255'];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'renumber-ids-'));
  return { dir, a: trackA(dir), b: trackB(dir), out: (name) => join(dir, 'plans', name) };
}

async function forward(root, track, base, out, ledgerAssign = []) {
  const plan = planTrack({ root, track, base, ledgerAssign });
  assert.deepEqual(plan.errors, []);
  writePlan(plan, out);
  await applyPlan(join(out, 'plan.json'));
  return plan;
}

test('apply moves every format into the block and keeps unrelated numbers', async () => {
  const f = fixture();
  try {
    await forward(f.a, 'A', 100000, f.out('a'), LEDGER_A);
    const read = (rel) => readFileSync(join(f.a, rel), 'utf8');

    const tracker = read('data/applications.md');
    assert.match(tracker, /\| 100025 \| 2026-08-04 \| Nortal .*\[100025\]\(\.\.\/reports\/100025-nortal-2026-08-04\.md\)/);
    assert.match(tracker, /Story #1 fits; see #100056 and #9999; req 1057 \|/, 'D4: only #NNN of this track changes');
    assert.match(tracker, /\[100056\]\(\.\.\/reports\/100056-articul8-2026-08-07\.md\) \| PDF at output\/cv-candidate-articul8-100056-2026-08-07\.pdf \|/);
    assert.match(tracker, /\| 103255 \| 2026-10-08 \| Anterior .*\[103255\]/, 'E1: the duplicate row takes its own report number');
    assert.match(tracker, /\| 103244 \| 2026-10-08 \| GitLab .*cv-candidate-gitlab-103244-2026-10-08\.pdf; https:\/\/example\.com\/jobs#3244 \|/);
    assert.match(tracker, /duplicate # of #103244\/#103255 \|/);
    assert.match(tracker, /\| 101037 \| 2026-09-21 \| Kosli /);

    assert.equal(read('data/status-log.tsv').split('\n').map((l) => l.split('\t')[0]).join(','), '100025,103244,103255,103255,');
    const pipeline = read('data/pipeline.md');
    assert.match(pipeline, /^- \[x\] #100025 \| https:\/\/jobs\.example\.com\/a#123 \|.*\[100025\]\(\.\.\/reports\/100025-nortal-2026-08-04\.md\)$/m);
    assert.match(pipeline, /^- \[x\] \[103244\]\(\.\.\/reports\/103244-gitlab-2026-10-08\.md\)/m);
    const followups = read('data/follow-ups.md');
    assert.match(followups, /^\| 1 \| 100017 \| 2026-08-24 .*asked about #100056 too \|$/m);
    assert.match(followups, /^- next #100017 2026-08-31/m);
    assert.match(followups, /^- next #103244 2026-10-15/m);
    assert.match(followups, /^- 2026-08-12 · #100056 Articul8/m);
    assert.match(read('data/pdf-index.tsv'), /^100056\toutput\/cv-candidate-articul8-100056-2026-08-07\.pdf\toutput\/cv-candidate-articul8-100056\.html\t/m);

    assert.equal(read('reports/100025-nortal-2026-08-04.md'), '# Nortal\n\nSee [the earlier one](100056-articul8-2026-08-07.md) and #103244.\n');
    assert.equal(read('reports/100056-articul8-2026-08-07.md'), '# Articul8 #100056\n\nJD: [jd](../jds/100056-articul8.md)\n');
    assert.match(read('reports/103244-gitlab-2026-10-08.md'), /`output\/cv-candidate-gitlab-103244-2026-10-08\.pdf`/);
    assert.equal(read('reports/100331-picpay-2026-08-22.md.bak'), 'old copy citing #056\n', 'E6: backups are renamed, not rewritten');
    assert.ok(existsSync(join(f.a, 'reports/999REAL-ciandt-2026-09-18.md')), 'E5 stays');
    assert.ok(existsSync(join(f.a, 'reports/2026-08-12.md')), 'a bare date file is not a report');

    assert.equal(read('data/followup-drafts/100017-remote.md'), 'Draft for [remote](../../reports/100017-remote-2026-08-07.md)\n');
    assert.equal(read('data/outcomes/100056_articul8_infra/outcome.md'), 'Outcome of reports/100056-articul8-2026-08-07.md\n');
    assert.equal(read('data/application-packets/2026-08-31/001-100056-articul8.md'),
      '- **Tracker:** #056\n- **Report:** `reports/100056-articul8-2026-08-07.md`\n', 'packet ordinal kept, path rewritten');
    assert.ok(existsSync(join(f.a, 'jds/100056-articul8.md')));
    assert.ok(existsSync(join(f.a, 'jds/scraped-no-number.md')));
    for (const name of ['cv-candidate-articul8-100056-2026-08-07.pdf', 'cv-candidate-articul8-100056.html',
      'cv-candidate-gitlab-103244-2026-10-08.pdf', 'cv-rafael-reis-amazon-top-10-2026-08-07.pdf', '2026-09-07-notes.md']) {
      assert.ok(existsSync(join(f.a, 'output', name)), `output/${name}`);
    }
    assert.equal(read('output/contacto/103244-gitlab.md'), 'Report: [103244](../../reports/103244-gitlab-2026-10-08.md)\n');
    assert.equal(read('output/2026-09-07-notes.md'), 'dated note citing output/cv-candidate-gitlab-103244.html\n');
    assert.equal(read('output/.tracker-before-2026-10-08.md'), '| 3244 | x | [3244](../reports/3244-gitlab-2026-10-08.md) |\n');
    assert.ok(lstatSync(join(f.a, 'data/contacts.tsv')).isSymbolicLink());
    assert.equal(readFileSync(join(f.dir, 'shared/contacts.tsv'), 'utf8'), 'x\n', 'symlinked shared files stay out of track mode');

    const idMap = parseIdMap(readFileSync(join(f.out('a'), 'id-map.tsv'), 'utf8'));
    const row = (tipo, antigo) => idMap.find((r) => r.tipo === tipo && r.antigo === antigo);
    assert.equal(row('block', '-').novo, '100000');
    assert.equal(row('tracker+report', '25').novo, '100025');
    assert.equal(row('tracker-exception', '3244').novo, '103255');
    assert.deepEqual(idMap.filter((r) => r.tipo === 'ledger').map((r) => r.novo).sort(), ['103244', '103255']);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('--reverse after apply gives back the original bytes, anchors included', async () => {
  const f = fixture();
  try {
    const before = { a: treeOf(f.a), b: treeOf(f.b) };
    await forward(f.a, 'A', 100000, f.out('a'), LEDGER_A);
    await forward(f.b, 'B', 200000, f.out('b'));
    assert.ok(!existsSync(join(f.b, 'reports/999-faixa-inicial.md')), 'D6: anchors are deleted');
    assert.ok(existsSync(join(f.b, 'reports/201037-clickhouse-2026-08-22.md')));
    assert.notDeepEqual(treeOf(f.a), before.a);

    for (const [root, name] of [[f.a, 'a'], [f.b, 'b']]) {
      const idMapRows = parseIdMap(readFileSync(join(f.out(name), 'id-map.tsv'), 'utf8'));
      const back = planTrack({ root, reverse: true, idMapRows });
      assert.deepEqual(back.errors, []);
      writePlan(back, f.out(`${name}-reverse`));
      await applyPlan(join(f.out(`${name}-reverse`), 'plan.json'));
    }
    assert.deepEqual(treeOf(f.a), before.a);
    assert.deepEqual(treeOf(f.b), before.b);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('apply refuses live reservations, a held tracker lock, a running batch and a changed tree', async () => {
  const f = fixture();
  try {
    const plan = planTrack({ root: f.a, track: 'A', base: 100000, ledgerAssign: LEDGER_A });
    writePlan(plan, f.out('a'));
    const planPath = join(f.out('a'), 'plan.json');
    const before = treeOf(f.a);
    const refuse = async (setup, undo, pattern) => {
      setup();
      await assert.rejects(applyPlan(planPath), pattern);
      undo();
      assert.deepEqual(treeOf(f.a), before, 'a refused apply changes nothing');
    };

    await refuse(() => write(f.a, 'reports/3300-RESERVED.md', 'pid'),
      () => rmSync(join(f.a, 'reports/3300-RESERVED.md')), /report reservations are live: 3300-RESERVED\.md/);
    const lockDir = trackerLockDirFor(canonicalizeTrackerPath(join(f.a, 'data/applications.md')));
    await refuse(() => mkdirSync(lockDir), () => rmSync(lockDir, { recursive: true }), /the tracker lock is held/);
    await refuse(() => write(f.a, 'batch/batch-state-x.tsv', 'id\turl\tstatus\n1\thttps://x\tprocessing\n'),
      () => rmSync(join(f.a, 'batch'), { recursive: true }), /batch\/batch-state-x\.tsv has a row in processing/);
    const report = join(f.a, 'reports/1037-kosli-2026-09-21.md');
    await refuse(() => writeFileSync(report, '# Kosli, edited after the plan\n'),
      () => writeFileSync(report, '# Kosli\n'), /changed since the plan was written/);

    await applyPlan(planPath);
    assert.ok(existsSync(join(f.a, 'reports/101037-kosli-2026-09-21.md')));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a ledger event of a repeated tracker # needs an explicit owner', () => {
  const f = fixture();
  try {
    const plan = planTrack({ root: f.a, track: 'A', base: 100000 });
    assert.match(plan.errors.join('\n'), /status-log\.tsv:3 records #3244 on 2026-10-11.*--ledger-assign 3244@2026-10-11=<new number>/);
    const typo = planTrack({ root: f.a, track: 'A', base: 100000, ledgerAssign: [...LEDGER_A, '3244@2026-10-09=103244'] });
    assert.match(typo.errors.join('\n'), /3244@2026-10-09=103244 matches no ledger event/);

    const cli = spawnSync(NODE, [join(ROOT, 'renumber-ids.mjs'), 'plan', '--root', f.a, '--track', 'A', '--base', '100000', '--out', f.out('cli')], { encoding: 'utf8' });
    assert.equal(cli.status, 2);
    assert.match(cli.stderr, /nothing was written/);
    assert.ok(!existsSync(f.out('cli')));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('shared mode migrates each row with the base of the track that owns it, and back', async () => {
  const f = fixture();
  try {
    const shared = join(f.dir, 'shared-data');
    const contacts = [
      'Ana\tKosli\trecruiter\tTA\t\t\thttps://linkedin.com/in/ana\t1037\tre Solutions req 1057; see #1037',
      'Bo\tClickHouse\tpeer\tPM\t\t\thttps://linkedin.com/in/bo\t1037\tB-side contact, see #1037',
      'Cy\tGitLab\trecruiter\tTA\t\t\thttps://linkedin.com/in/cy\t3244\tPRIMARY for #3244',
      'Di\tAnterior\trecruiter\tTA\t\t\thttps://linkedin.com/in/di\t3244\tTurnKey recruiter',
      '',
    ].join('\n');
    write(shared, 'contacts.tsv', contacts);
    write(shared, 'salary-observations.tsv', '56\t2026-09-13\tdesired\t8000\tUSD\tuser\tnote\n');
    write(shared, 'assessments.tsv', '# header comment\n2026-09-01\tKosli\t1037\tCodility\tGo\t-\t-\t\n2026-09-02\tX\t-\tHR\tY\t-\t-\t\n');
    const before = treeOf(shared);

    const tracks = [{ track: 'A', root: f.a, base: 100000 }, { track: 'B', root: f.b, base: 200000 }];
    const plan = planShared({ sharedDir: shared, tracks, ledgerAssign: { A: LEDGER_A } });
    assert.deepEqual(plan.errors, []);
    writePlan(plan, f.out('shared'));
    await applyPlan(join(f.out('shared'), 'plan.json'));
    const lines = readFileSync(join(shared, 'contacts.tsv'), 'utf8').split('\n');
    assert.equal(lines[0].split('\t').slice(7).join('|'), '101037|re Solutions req 1057; see #101037', 'company picks A; req number untouched');
    assert.equal(lines[1].split('\t').slice(7).join('|'), '201037|B-side contact, see #201037');
    assert.equal(lines[2].split('\t')[7], '103244');
    assert.equal(lines[3].split('\t')[7], '103255', 'E1 row resolved by company');
    assert.equal(readFileSync(join(shared, 'salary-observations.tsv'), 'utf8').split('\t')[0], '100056');
    assert.match(readFileSync(join(shared, 'assessments.tsv'), 'utf8'), /\tKosli\t101037\t[^\n]*\n[^\n]*\tX\t-\t/);

    // Reverse needs the track id-maps (tracker exceptions) plus the shared one.
    const ta = planTrack({ root: f.a, track: 'A', base: 100000, ledgerAssign: LEDGER_A });
    const tb = planTrack({ root: f.b, track: 'B', base: 200000 });
    const idMapRows = [...ta.idMapRows, ...tb.idMapRows, ...parseIdMap(readFileSync(join(f.out('shared'), 'id-map.tsv'), 'utf8'))];
    const back = planShared({ sharedDir: shared, reverse: true, idMapRows });
    assert.deepEqual(back.errors, []);
    writePlan(back, f.out('shared-reverse'));
    await applyPlan(join(f.out('shared-reverse'), 'plan.json'));
    assert.deepEqual(treeOf(shared), before);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('shared mode refuses a row whose owner it cannot tell', () => {
  const f = fixture();
  try {
    const shared = join(f.dir, 'shared-data');
    write(shared, 'salary-observations.tsv', '1037\t2026-09-13\tdesired\t8000\tUSD\tuser\tnote\n');
    const tracks = [{ track: 'A', root: f.a, base: 100000 }, { track: 'B', root: f.b, base: 200000 }];
    const plan = planShared({ sharedDir: shared, tracks, ledgerAssign: { A: LEDGER_A } });
    assert.match(plan.errors.join('\n'), /salary-observations\.tsv:1: cannot tell which track owns #1037; pass --owner salary-observations\.tsv:1=<track>/);
    const forced = planShared({ sharedDir: shared, tracks, ledgerAssign: { A: LEDGER_A }, owners: ['salary-observations.tsv:1=B'] });
    assert.deepEqual(forced.errors, []);
    assert.equal(forced.texts.get('salary-observations.tsv').split('\t')[0], '201037');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
