import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE, ROOT, rmSync } from './helpers.mjs';

// Report numbers are three digits at minimum, not exactly three: tracks number
// in 1000-1999 and, after the block migration, in 100000-399999. The report
// scan used to match `\d{3}` only, so every report from 1000 up vanished from
// the advertised-comp side of the gap analysis.
const report = (company, comp) => [
  `# Eval: ${company}`, '', '## Machine Summary', '', '```yaml',
  `company: "${company}"`, 'role: "SRE"', `advertised_comp: "${comp}"`, '```', '',
].join('\n');

test('salary-gap reads reports of any number width, in numeric order', () => {
  const root = mkdtempSync(join(tmpdir(), 'salary-gap-width-'));
  try {
    mkdirSync(join(root, 'reports'));
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'reports', '025-acme-2026-08-04.md'), report('Acme', '80k USD'));
    writeFileSync(join(root, 'reports', '1037-kosli-2026-09-21.md'), report('Kosli', '90k USD'));
    writeFileSync(join(root, 'reports', '103244-gitlab-2026-10-08.md'), report('GitLab', '100k USD'));
    writeFileSync(join(root, 'data', 'salary-observations.tsv'), '103244\t2026-10-12\tactual\t95000\tUSD\toffer-letter\toffer\n');

    const run = spawnSync(NODE, [join(ROOT, 'salary-gap.mjs')], {
      encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: root },
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result.applications.map((a) => a.num), ['025', '1037', '103244']);
    const gitlab = result.applications.find((a) => a.num === '103244');
    assert.equal(gitlab.company, 'GitLab');
    assert.equal(gitlab.actual.value, 95000);
    assert.deepEqual(result.quality?.orphans ?? [], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
