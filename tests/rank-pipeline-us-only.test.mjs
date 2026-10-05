// tests/rank-pipeline-us-only.test.mjs — US-only postings are ranked below the forwarding cutoff.
//
// The candidate lives in Brazil and cannot take a job restricted to US employees.
// rank-pipeline.mjs screens each pending row before any scorer sees it: a posting
// whose location, title, or JD text limits employment to the United States is
// annotated below `rank_forward_threshold` with the reason, and never reaches the
// scorer. A remote posting open to Brazil, Latin America, or the world is scored
// as before.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nrank-pipeline — US-only postings ranked below the cutoff');

const check = (label, cond) => (cond ? pass(label) : fail(label));

try {
  const { usOnlySignals, isUsOnlyLocation, limitsRemoteToUnitedStates, requiresUsAuthorizationWithoutSponsorship } =
    await import(pathToFileURL(join(ROOT, 'lib', 'us-only.mjs')).href);
  const { usOnlyRankScore } = await import(pathToFileURL(join(ROOT, 'rank-pipeline.mjs')).href);

  check('locations naming only US places are US-only',
    ['Remote - US', 'Remote (US)', 'US Remote', 'Remote, United States', 'United States', 'Remote - USA',
      'Austin, TX', 'San Francisco, CA; New York, NY', 'Remote - Colorado']
      .every(isUsOnlyLocation));
  check('remote and mixed locations are not US-only',
    ['Remote', '', 'Remote - LATAM', 'Remote - Brazil', 'Remote - US or Brazil', 'Remote (Worldwide)',
      'Remote - Global', 'London, UK', 'Remote - Georgia', 'San Francisco, CA; London', 'Remote; New York, NY']
      .every(location => !isUsOnlyLocation(location)));
  check('remote limited to the US is read from title and JD lines',
    ['Staff Platform Engineer (Remote - US)', 'Remote within the United States', 'US-only role',
      'Candidates must reside in the United States.', 'Must be located in the U.S.',
      'Open to candidates based in the US.', 'US citizens only']
      .every(limitsRemoteToUnitedStates));
  check('a line that opens the scope to Brazil or the world is not a limit',
    ['Remote - US, Brazil, or Canada', 'Remote within the US or worldwide', 'Work with us remotely',
      'Our US-based company hires globally', 'The remote team ships to users in the US']
      .every(text => !limitsRemoteToUnitedStates(text)));
  check('US work authorization without sponsorship fires; either half alone does not',
    requiresUsAuthorizationWithoutSponsorship('You must be authorized to work in the US. We are unable to provide visa sponsorship.')
      && !requiresUsAuthorizationWithoutSponsorship('You must be authorized to work in the US.')
      && !requiresUsAuthorizationWithoutSponsorship('We do not offer sponsorship for relocation to Mars.'));
  check('signals carry the benefits matcher of the long evaluation',
    usOnlySignals({ text: 'We offer a 401(k) and HSA.' }).join() === 'the JD offers 401(k), HSA');
  check('a posting open to the world has no signal',
    usOnlySignals({ title: 'Platform Engineer', location: 'Remote - Worldwide', text: 'Remote, work from anywhere. Health insurance.' }).length === 0);
  check('the US-only score sits below any cutoff above 0.1',
    [2.5, 3.5, 1.1, 0.5, 0.2].every(cutoff => usOnlyRankScore(cutoff) < cutoff) && usOnlyRankScore(3.5) === 1);

  const root = mkdtempSync(join(tmpdir(), 'career-ops-rank-us-only-'));
  try {
    mkdirSync(join(root, 'data'));
    mkdirSync(join(root, 'config'));
    mkdirSync(join(root, 'jds'));
    const profile = join(root, 'config', 'profile.yml');
    const baseProfile = 'target_roles:\n  target_level: Senior\ncompensation:\n  target_range: USD 8K/month\n'
      + 'rank_forward_threshold: 3.5\n';
    writeFileSync(profile, `${baseProfile}location:\n  authorized_in: ["Brazil"]\n`);
    writeFileSync(join(root, 'jds', 'focus.md'),
      'Staff Platform Engineer\n\nThis is a fully remote role. Candidates must reside in the United States.\n');
    writeFileSync(join(root, 'jds', 'adhoc.md'),
      'Senior Engineer\n\nYou must be authorized to work in the US. We are unable to provide visa sponsorship.\n');
    writeFileSync(join(root, 'jds', 'koniag.md'),
      'Program Manager\n\nBenefits: medical, 401(k) with match, disability insurance, FSA.\n');
    writeFileSync(join(root, 'jds', 'global.md'),
      'Platform Engineer\n\nWork remotely from anywhere. Open to Brazil, Canada, and the US. Paid time off.\n');
    const pipelinePath = join(root, 'data', 'pipeline.md');
    const pristine = [
      '## Pending',
      '- [ ] https://boards.example/focus/1 | Focus | Staff Platform Engineer | Remote - US | posted: 2026-10-01',
      '- [ ] local:jds/focus.md | Focus JD | Staff Platform Engineer | Remote',
      '- [ ] local:jds/adhoc.md | Ad Hoc | Senior Engineer | Remote',
      '- [ ] local:jds/koniag.md | Koniag | Program Manager | Remote',
      '- [ ] local:jds/global.md | Globex | Platform Engineer | Remote',
      '- [ ] https://boards.example/latam/2 | Latamco | Platform Engineer | Remote - LATAM',
      '',
    ].join('\n');
    writeFileSync(join(root, 'fake-scorer.cjs'), [
      'if (process.argv.length === 1) {',
      '  process.on("uncaughtException", () => {',
      '    require("fs").appendFileSync(process.env.PROMPT_LOG, process.execArgv[1] + "\\n=====\\n");',
      '    process.stdout.write(JSON.stringify([0, 1, 2, 3, 4, 5].map(id => ({ id, score: 4.6, reason: "fake scorer" }))));',
      '    process.exitCode = 0;',
      '  });',
      '}',
      '',
    ].join('\n'));
    const promptLog = join(root, 'prompts.log');
    const rank = (extraArgs = []) => {
      writeFileSync(pipelinePath, pristine);
      writeFileSync(promptLog, '');
      const r = spawnSync(process.execPath, [join(ROOT, 'rank-pipeline.mjs'), '--cli', process.execPath, ...extraArgs], {
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, CAREER_OPS_ROOT: root, TYPESAFE_API_KEY: '', PROMPT_LOG: promptLog,
          NODE_OPTIONS: '--require=./fake-scorer.cjs' },
      });
      const lines = readFileSync(pipelinePath, 'utf8').split('\n');
      const row = needle => lines.find(line => line.includes(needle)) ?? '';
      return { ...r, row, prompts: readFileSync(promptLog, 'utf8') };
    };

    const run = rank();
    check('the run succeeds', run.status === 0);
    check('Focus, restricted to remote US by location, is ranked 1.0 with the reason',
      run.row('boards.example/focus/1').includes('| rank: cal-v3 1.0/5 — US-only employment: location is US-only (Remote - US)'));
    check('Focus, restricted to US residents by its JD, is ranked 1.0 with the reason',
      run.row('local:jds/focus.md').includes('| rank: cal-v3 1.0/5 — US-only employment: remote work is limited to the United States'));
    check('Ad Hoc, requiring US work authorization without sponsorship, is ranked 1.0 with the reason',
      run.row('local:jds/adhoc.md').includes('| rank: cal-v3 1.0/5 — US-only employment: the JD requires US work authorization and offers no sponsorship'));
    check('Koniag, offering US benefits, is ranked 1.0 with the benefits named',
      run.row('local:jds/koniag.md').includes('| rank: cal-v3 1.0/5 — US-only employment: the JD offers 401(k), disability insurance, FSA'));
    check('a global remote posting and a LATAM posting are scored by the scorer',
      run.row('local:jds/global.md').includes('| rank: cal-v3 4.6/5 — fake scorer')
        && run.row('boards.example/latam/2').includes('| rank: cal-v3 4.6/5 — fake scorer'));
    check('the scorer never sees a US-only posting',
      ['Focus', 'Ad Hoc', 'Koniag'].every(name => !run.prompts.includes(name))
        && run.prompts.includes('Globex') && run.prompts.includes('Latamco'));
    check('every US-only score is below the configured 3.5 cutoff',
      ['boards.example/focus/1', 'local:jds/focus.md', 'local:jds/adhoc.md', 'local:jds/koniag.md']
        .every(needle => Number(/rank: cal-v3 (\d+\.\d)\/5/.exec(run.row(needle))?.[1]) < 3.5));

    const limited = rank(['--limit', '1']);
    check('US-only rows do not count against --limit',
      limited.row('local:jds/koniag.md').includes('rank: cal-v3 1.0/5')
        && limited.row('local:jds/global.md').includes('rank: cal-v3 4.6/5')
        && !limited.row('boards.example/latam/2').includes('rank:'));

    const dry = rank(['--dry-run']);
    check('--dry-run prints the US-only annotations and writes nothing',
      dry.stdout.includes('US-only employment: location is US-only (Remote - US)')
        && readFileSync(pipelinePath, 'utf8') === pristine);

    writeFileSync(profile, `${baseProfile}location:\n  authorized_in: ["Brazil", "United States"]\n`);
    const authorized = rank();
    check('a candidate authorized in the US keeps every posting for the scorer',
      authorized.row('boards.example/focus/1').includes('rank: cal-v3 4.6/5')
        && authorized.row('local:jds/koniag.md').includes('rank: cal-v3 4.6/5')
        && !authorized.stdout.includes('US-only'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} catch (err) {
  fail(`rank-pipeline US-only suite threw: ${err?.stack ?? err}`);
}
