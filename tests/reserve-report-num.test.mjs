// Regression: a dated file in reports/ must not be read as a report number.
//
// `scan-ats-full.mjs --md-out reports/` writes `reports/YYYY-MM-DD.md`. The old
// occupancy scan matched `/^(\d+)-/`, so `2026-08-12.md` was read as report
// #2026 and the next reservation jumped to 2027 — silently, and permanently.

import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  findReportNumberCollisions, reserveReportNumbers, releaseReportNumbers,
} from '../reserve-report-num.mjs';
import { pass, fail, NODE, ROOT } from './helpers.mjs';

// Reserve one slot in a scratch root and report which number it got. Released
// afterwards so the assertion reflects the occupancy scan, not leftover state.
async function peekIn(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rrn-'));
  mkdirSync(join(dir, 'reports'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(
    join(dir, 'data/applications.md'),
    '# Applications Tracker\n\n'
    + '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n'
    + '|---|---|---|---|---|---|---|---|---|\n'
  );
  for (const f of files) writeFileSync(join(dir, 'reports', f), '# x\n');
  try {
    const nums = await reserveReportNumbers(1, { rootDir: dir });
    await releaseReportNumbers(nums, { rootDir: dir });
    return String(nums[0]).padStart(3, '0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  {
    name: 'scan digest is ignored',
    files: ['009-acme-2026-08-12.md', '2026-08-12.md'],
    expect: '010',
  },
  {
    name: 'real reports still counted',
    files: ['009-acme-2026-08-12.md', '010-globex-2026-08-12.md'],
    expect: '011',
  },
  {
    name: 'RESERVED sentinels still counted',
    files: ['009-acme-2026-08-12.md', '010-RESERVED.md'],
    expect: '011',
  },
  {
    name: 'digest alone leaves numbering at the start',
    files: ['2026-08-12.md'],
    expect: '001',
  },
];

for (const c of cases) {
  let got;
  try {
    got = await peekIn(c.files);
  } catch (err) {
    fail(`${c.name}: threw ${err.message.split('\n')[0]}`);
    continue;
  }
  try {
    assert.equal(got, c.expect);
    pass(`${c.name} → ${got}`);
  } catch {
    fail(`${c.name}: expected ${c.expect}, got ${got}`);
  }
}

// Regression: `--help`/`-h` used to fall through the CLI's cmd dispatch into
// the default reserve-1 path — silently burning a real report-number slot
// instead of printing usage. It must now short-circuit before touching any
// reports/tracker path at all.
for (const flag of ['--help', '-h']) {
  const dir = mkdtempSync(join(tmpdir(), 'rrn-help-'));
  try {
    const result = spawnSync(NODE, [join(ROOT, 'reserve-report-num.mjs'), flag], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 15000,
    });
    const sentinels = existsSync(join(dir, 'reports'))
      ? readdirSync(join(dir, 'reports')).filter((f) => /-RESERVED\.md$/.test(f))
      : [];
    if (result.status === 0 && /Usage: node reserve-report-num\.mjs/.test(result.stdout) && sentinels.length === 0) {
      pass(`${flag} prints usage and reserves nothing`);
    } else {
      fail(`${flag}: exit=${result.status}, sentinels=${sentinels.length}, stdout=${JSON.stringify(result.stdout.slice(0, 120))}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// An installation range is an allocation boundary, not a formatting hint.
{
  const dir = mkdtempSync(join(tmpdir(), 'rrn-range-'));
  const reports = join(dir, 'reports');
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, '1000-acme-2026-09-22.md'), '# fixture\n');
  writeFileSync(join(reports, '1001-globex-2026-09-22.md'), '# fixture\n');
  const previousRange = process.env.CAREER_OPS_REPORT_NUMBER_RANGE;
  process.env.CAREER_OPS_REPORT_NUMBER_RANGE = '1000-1001';
  let rangeError = null;
  let sentinels = [];
  try {
    await reserveReportNumbers(1, { rootDir: dir });
  } catch (err) {
    rangeError = err;
  } finally {
    if (previousRange === undefined) delete process.env.CAREER_OPS_REPORT_NUMBER_RANGE;
    else process.env.CAREER_OPS_REPORT_NUMBER_RANGE = previousRange;
    sentinels = readdirSync(reports).filter((name) => /-RESERVED\.md$/.test(name));
    rmSync(dir, { recursive: true, force: true });
  }
  if (rangeError instanceof RangeError && sentinels.length === 0) {
    pass('configured report-number range refuses reservations beyond its upper bound');
  } else {
    fail(`configured range guard failed: error=${rangeError?.message}, sentinels=${sentinels.length}`);
  }
}

function writeCollisionFixture(root, number, company, slug) {
  const reports = join(root, 'reports');
  const data = join(root, 'data');
  mkdirSync(reports, { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(reports, `${number}-${slug}-2026-09-22.md`), `# Evaluation: ${company} — Engineer\n`);
  writeFileSync(
    join(data, 'applications.md'),
    '# Applications Tracker\n\n'
    + '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n'
    + '|---|---|---|---|---|---|---|---|---|\n'
    + `| ${number} | 2026-09-22 | ${company} | Engineer | 4.0/5 | Evaluated | ❌ | [${number}](../reports/${number}-${slug}-2026-09-22.md) | fixture |\n`,
  );
}

{
  const first = mkdtempSync(join(tmpdir(), 'rrn-collision-a-'));
  const second = mkdtempSync(join(tmpdir(), 'rrn-collision-b-'));
  try {
    writeCollisionFixture(first, 1155, 'Thales', 'thales');
    writeCollisionFixture(second, 1155, 'Intermedia', 'intermedia');
    const collisions = findReportNumberCollisions([first, second]);
    const cli = spawnSync(NODE, [
      join(ROOT, 'reserve-report-num.mjs'), '--collisions', first, second,
    ], { cwd: ROOT, encoding: 'utf-8', timeout: 15000 });
    const companies = collisions[0]?.companies.map((entry) => entry.company).sort().join(',');
    if (collisions.length === 1 && collisions[0].number === 1155 && companies === 'Intermedia,Thales') {
      pass('collision diagnostic identifies the same number used by different companies');
    } else {
      fail(`collision API result was unexpected: ${JSON.stringify(collisions)}`);
    }
    const sentinelsAfterCli = [
      ...readdirSync(join(first, 'reports')),
      ...readdirSync(join(second, 'reports')),
    ].filter((name) => /-RESERVED\.md$/.test(name));
    if (cli.status === 0 && /1155:/.test(cli.stdout) && /Thales/.test(cli.stdout)
        && /Intermedia/.test(cli.stdout) && sentinelsAfterCli.length === 0) {
      pass('collision diagnostic CLI prints the planted collision without writing');
    } else {
      fail(`collision CLI failed: exit=${cli.status}, sentinels=${sentinelsAfterCli.length}, stdout=${JSON.stringify(cli.stdout)}, stderr=${JSON.stringify(cli.stderr)}`);
    }
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
}
