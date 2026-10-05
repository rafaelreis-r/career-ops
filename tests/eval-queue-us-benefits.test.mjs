// tests/eval-queue-us-benefits.test.mjs — US-only postings never reach the long evaluation.
//
// A JD that offers 401(k), disability insurance, FSA, or HSA is US employment,
// even when it says remote. When the JD text is on disk (`local:jds/...`),
// eval-queue.mjs holds the row with the benefits it found; a URL row has no
// local text and goes on to the evaluation, which applies the same rule.
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs';

console.log('\neval-queue — US-only benefits hold');

const check = (label, cond) => (cond ? pass(label) : fail(label));

try {
  const { usOnlyBenefits } = await import(pathToFileURL(join(ROOT, 'eval-queue.mjs')).href);

  const found = text => usOnlyBenefits(text).join(', ');
  check('401(k) spellings match', ['401(k) match', '401k plan', '401 (k)', '401K'].every(t => found(t) === '401(k)'));
  check('disability insurance matches', found('Short-term Disability Insurance') === 'disability insurance');
  check('FSA and its spelled-out form match',
    found('FSA') === 'FSA' && found('Flexible Spending Accounts') === 'FSA');
  check('HSA and its spelled-out form match',
    found('HSA') === 'HSA' && found('Health Savings Account (HSA)') === 'HSA');
  check('every benefit found is listed once, in a fixed order',
    found('HSA, FSA, disability insurance and a 401(k)') === '401(k), disability insurance, FSA, HSA');
  check('generic benefits and look-alikes do not match',
    usOnlyBenefits('Health insurance, retirement plan, 401 kg payload, the hsa crew, HSAB').length === 0);
  check('a 401 thousand pay figure is not a 401(k)',
    ['Compensation: $180k–$401k OTE', 'Compensation: $180k-$401k OTE', 'TC band 250-401k', '$401k', '250–401k', '401k-500k']
      .every(text => usOnlyBenefits(text).length === 0));
  check('a real 401(k) still matches beside a pay band of 401 thousand',
    found('401(k) match, TC 250-401k') === '401(k)' && found('401k plan, band $180k-$401k') === '401(k)');

  const root = mkdtempSync(join(ROOT, 'tests', '.eval-queue-us-'));
  try {
    copyFileSync(join(ROOT, 'eval-queue.mjs'), join(root, 'eval-queue.mjs'));
    for (const file of ['path-resolver.mjs', 'rank-pipeline.mjs', 'scan.mjs', 'pipeline-lock.mjs']) {
      symlinkSync(join(ROOT, file), join(root, file));
    }
    symlinkSync(join(ROOT, 'lib'), join(root, 'lib'), 'dir');
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    for (const dir of ['data', 'config', 'reports', 'batch', 'jds']) mkdirSync(join(root, dir));
    writeFileSync(join(root, 'jds', 'monami-spm.md'),
      'Senior Product Manager (Remote)\n\nBenefits: medical, dental, 401(k) with match, disability insurance, FSA and HSA.\n');
    writeFileSync(join(root, 'jds', 'acme-pm.md'), 'Product Manager (Remote, US)\n\nPerks: Health Savings Account with employer contribution.\n');
    writeFileSync(join(root, 'jds', 'beta-pm.md'), 'Product Manager (Remote)\n\nPerks: home-office stipend, paid time off.\n');
    writeFileSync(join(root, 'data', 'pipeline.md'), [
      '## Pending',
      '- [ ] local:jds/monami-spm.md | Mon Ami | Senior Product Manager | rank: cal-v3 4.2/5',
      '- [ ] local:jds/acme-pm.md | Acme | Product Manager | rank: cal-v3 3.9/5',
      '- [ ] local:jds/beta-pm.md | Beta | Product Manager | rank: cal-v3 3.6/5',
      '- [ ] https://x.test/no-local-text | Gamma | Product Manager | rank: cal-v3 3.4/5',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'data', 'applications.md'), '# Applications\n');
    const profile = join(root, 'config', 'profile.yml');
    writeFileSync(profile, 'location:\n  country: "Brazil"\n  authorized_in: ["Brazil"]\n  needs_sponsorship: false\n');
    const batchInput = join(root, 'batch', 'batch-input.tsv');
    const run = (...args) => execFileSync(NODE, [join(root, 'eval-queue.mjs'), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CAREER_OPS_ROOT: root },
    });

    const dry = run('--dry-run', '--force', 'local:jds/acme-pm.md');
    check('--dry-run shows a 401(k) JD held with the benefits it offers',
      dry.includes('local:jds/monami-spm.md | Mon Ami | Senior Product Manager\n'
        + '      US-only employment: the JD offers 401(k), disability insurance, FSA, HSA'));
    check('an HSA JD is held even when forced',
      dry.includes('local:jds/acme-pm.md | Acme | Product Manager\n'
        + '      US-only employment: the JD offers HSA; --force does not override it'));
    check('a JD without US-only benefits and a URL row with no local text are forwarded',
      dry.includes('Forwarded to the long evaluation (2):') && dry.includes('Held (2):'));

    run();
    check('the queue holds only the postings open outside the US',
      readFileSync(batchInput, 'utf8').trim().split('\n').slice(1).map(line => line.split('\t')[1]).join(' ')
        === 'local:jds/beta-pm.md https://x.test/no-local-text');

    rmSync(batchInput);
    writeFileSync(profile, 'location:\n  authorized_in: ["Brazil", "United States"]\n');
    check('a candidate authorized in the US keeps US-benefit postings',
      run('--dry-run').includes('Forwarded to the long evaluation (4):'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} catch (err) {
  fail(`eval-queue US-only benefits suite threw: ${err?.stack ?? err}`);
}
