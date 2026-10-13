import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE, ROOT, rmSync } from './helpers.mjs';

// When an addition's tracker # is already taken, merge-tracker picks another
// one itself. It used to take max+1 over the whole tracker, which lands outside
// the installation's report_number_range as soon as the range moves (a track
// moved to a new block still has rows below it) and so walks into another
// track's numbers. The fallback now stays inside the range, and refuses the
// addition when the range is full.
const HEADER = [
  '# Applications Tracker', '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
];
const row = (n, company) => `| ${n} | 2026-10-08 | ${company} | Engineer | 3.0/5 | Evaluated | ❌ | [${n}](../reports/${n}-x-2026-10-08.md) | |`;
const addition = (n, company) => [n, '2026-10-13', company, 'Platform Engineer', 'Evaluated', '3.5/5', '❌', `[${n}](reports/${n}-y-2026-10-13.md)`, 'new'].join('\t');

function merge({ range, rows, add }) {
  const work = mkdtempSync(join(tmpdir(), 'merge-range-'));
  try {
    mkdirSync(join(work, 'data'));
    mkdirSync(join(work, 'config'));
    mkdirSync(join(work, 'adds'));
    writeFileSync(join(work, 'config', 'profile.yml'), `report_number_range: "${range}"\n`);
    const tracker = join(work, 'data', 'applications.md');
    writeFileSync(tracker, [...HEADER, ...rows, ''].join('\n'));
    writeFileSync(join(work, 'adds', 'a.tsv'), `${add}\n`);
    const env = { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: join(work, 'adds') };
    delete env.CAREER_OPS_REPORT_NUMBER_RANGE;
    delete env.CAREER_OPS_PROFILE;
    const run = spawnSync(NODE, [join(ROOT, 'merge-tracker.mjs')], { encoding: 'utf8', env, timeout: 30000 });
    const nums = readFileSync(tracker, 'utf8').split('\n').map((l) => l.match(/^\| (\d+) \|/)?.[1]).filter(Boolean);
    return { run, nums, merged: existsSync(join(work, 'adds', 'merged', 'a.tsv')) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test('a colliding addition gets the next free number inside report_number_range', () => {
  const r = merge({ range: '104000-199999', rows: [row(104000, 'Acme'), row(103244, 'GitLab')], add: addition(104000, 'Newco') });
  assert.equal(r.run.status, 0, r.run.stderr);
  assert.deepEqual(r.nums.sort(), ['103244', '104000', '104001']);
  assert.match(r.run.stderr, /Tracker #104000 already used; assigning #104001/);
});

test('rows below the range do not pull the fallback out of it', () => {
  const r = merge({ range: '104000-199999', rows: [row(103244, 'GitLab'), row(103299, 'Other')], add: addition(103244, 'Newco') });
  assert.equal(r.run.status, 0, r.run.stderr);
  assert.ok(r.nums.includes('104000'), `expected #104000, got ${r.nums.join(', ')}`);
  assert.ok(!r.nums.includes('103300'));
});

test('a full range refuses the addition instead of leaving it', () => {
  const r = merge({ range: '3000-3001', rows: [row(3000, 'Acme'), row(3001, 'Beta')], add: addition(3000, 'Newco') });
  assert.notEqual(r.run.status, 0);
  assert.match(r.run.stderr, /report_number_range 3000-3001 has no free number left; this evaluation was NOT merged/);
  assert.deepEqual(r.nums, ['3000', '3001']);
  assert.equal(r.merged, false, 'the addition stays pending');
});
