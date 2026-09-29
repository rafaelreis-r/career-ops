import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nrank-pipeline targets — profile input and scorer prompts');

const check = (label, condition) => (condition ? pass(label) : fail(label));
const tempDir = mkdtempSync(join(tmpdir(), 'career-ops-rank-targets-'));

try {
  const { loadRankTargets, buildPrompt, buildJevRankInstructions } = await import(
    pathToFileURL(join(ROOT, 'rank-pipeline.mjs')).href,
  );
  const profilePath = join(tempDir, 'profile.yml');
  writeFileSync(profilePath, [
    'target_roles:',
    '  target_level: "Senior Manager or Director"',
    'compensation:',
    '  target_range: "USD 8K/month"',
    '  minimum: "USD 8K/month"',
    '  currency: "USD"',
    'location:',
    '  country: "Brazil"',
    '',
  ].join('\n'));

  const targets = loadRankTargets(profilePath);
  check('profile targets include home country, level, range, minimum, and currency',
    [
      'home country: Brazil',
      'target level: Senior Manager or Director',
      'target compensation: USD 8K/month',
      'minimum compensation: USD 8K/month',
      'currency: USD',
    ].every(value => targets.includes(value)));

  const entry = [{ company: 'Acme', title: 'Director of Engineering', url: 'https://jobs.example/1' }];
  const cliPrompt = buildPrompt(entry, '', targets);
  const jevPrompt = buildJevRankInstructions('', targets);
  check('CLI prompt receives configured targets and value-based scoring rules',
    cliPrompt.includes('target level: Senior Manager or Director')
      && cliPrompt.includes('target compensation: USD 8K/month')
      && cliPrompt.includes('at or above the target range')
      && cliPrompt.includes('Staff and Principal as senior individual-contributor levels comparable to senior management')
      && cliPrompt.includes('below the equivalent level'));
  check('Jev instructions receive the same configured targets and scoring rules',
    jevPrompt.includes('target level: Senior Manager or Director')
      && jevPrompt.includes('target compensation: USD 8K/month')
      && jevPrompt.includes('at or above the target range')
      && jevPrompt.includes('Staff and Principal as senior individual-contributor levels comparable to senior management')
      && jevPrompt.includes('below the equivalent level'));
  check('both scorer prompts keep absent salary neutral',
    [cliPrompt, jevPrompt].every(prompt =>
      prompt.includes('Missing salary is unknown, not low')
        && prompt.includes('Do not lower a score solely because salary is absent')));

  const compensationOnlyPath = join(tempDir, 'compensation-only.yml');
  writeFileSync(compensationOnlyPath, 'compensation:\n  target_range: "USD 8K/month"\n');
  check('target level stays optional when compensation is configured',
    loadRankTargets(compensationOnlyPath) === 'target compensation: USD 8K/month');
  check('a missing profile yields no target block',
    loadRankTargets(join(tempDir, 'missing.yml')) === ''
      && !buildPrompt(entry, '', '').includes('CANDIDATE TARGETS'));
} catch (error) {
  fail(`rank target tests threw: ${error?.message ?? error}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
