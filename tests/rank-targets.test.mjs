import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

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
  check('CLI prompt receives configured targets',
    cliPrompt.includes('target level: Senior Manager or Director')
      && cliPrompt.includes('target compensation: USD 8K/month'));
  check('Jev instructions receive the same configured targets',
    jevPrompt.includes('target level: Senior Manager or Director')
      && jevPrompt.includes('target compensation: USD 8K/month'));

  const splitTargets = loadRankTargets((() => {
    const splitPath = join(tempDir, 'currency-split.yml');
    writeFileSync(splitPath, [
      'target_roles:',
      '  target_level: "Paid in USD (international remote, contractor/EOR): Mid-level (Pleno) or Senior IC and above, including Staff, Principal, Lead, Manager, Head and Director. Paid in BRL (Brazil, CLT/PJ): Senior Manager, Head or Director and above."',
      'compensation:',
      '  target_range: "USD 8K/month"',
      '  minimum: "USD 8K/month"',
      '  currency: "USD"',
      'location:',
      '  country: "Brazil"',
      '',
    ].join('\n'));
    return splitPath;
  })());
  const splitPrompt = buildPrompt(entry, '', splitTargets);
  check('a currency-split target reaches the prompt verbatim',
    splitPrompt.includes('Paid in USD (international remote, contractor/EOR): Mid-level (Pleno) or Senior IC and above')
      && splitPrompt.includes('Paid in BRL (Brazil, CLT/PJ): Senior Manager, Head or Director and above'));
  check('the individual-contributor cap applies only where the target for that pay currency is leadership-only',
    splitPrompt.includes('Where the configured target for that pay currency and market is leadership-only')
      && splitPrompt.includes('is at most some overlap (2)')
      && !splitPrompt.includes('For a configured senior-management or director target, a specialist'));
  check('a role paid in USD at Mid or Senior IC level can score 4-5 under a target that accepts it',
    splitPrompt.includes('accepts Mid-level or Senior individual contributors')
      && splitPrompt.includes('on target and can score 4-5'));

  const compensationOnlyPath = join(tempDir, 'compensation-only.yml');
  writeFileSync(compensationOnlyPath, 'compensation:\n  target_range: "USD 8K/month"\n');
  check('a missing level prevents ranking',
    (() => { try { loadRankTargets(compensationOnlyPath); return false; } catch { return true; } })());
  writeFileSync(join(tempDir, 'level-only.yml'), 'target_roles:\n  target_level: Director\n');
  check('a missing compensation target prevents ranking',
    (() => { try { loadRankTargets(join(tempDir, 'level-only.yml')); return false; } catch { return true; } })());
  check('a missing profile prevents ranking',
    (() => { try { loadRankTargets(join(tempDir, 'missing.yml')); return false; } catch { return true; } })());

  const root = join(tempDir, 'career');
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'));
  const canonicalProfilePath = join(root, 'config', 'profile.yml');
  const pipelinePath = join(root, 'data', 'pipeline.md');
  const row = '- [ ] https://jobs.example/1 | Acme | Director of Engineering';
  writeFileSync(pipelinePath, `## Pending\n${row}\n`);
  const scorerPath = join(tempDir, 'scorer.cjs');
  const receivedPath = join(tempDir, 'received.txt');
  // The preload stops the child before Node's -p evaluates the prompt as JavaScript.
  writeFileSync(scorerPath, [
    'const promptFlag = process.execArgv.indexOf("-p");',
    'if (promptFlag !== -1) {',
    '  require("fs").writeFileSync(process.env.RECEIVED_PROMPT, process.execArgv[promptFlag + 1]);',
    '  process.stdout.write(JSON.stringify([{id:0, score:4, reason:"target match"}]));',
    '  process["exit"](0);',
    '}',
  ].join('\n'));
  const run = (path) => {
    if (existsSync(path)) writeFileSync(canonicalProfilePath, readFileSync(path, 'utf8'));
    else rmSync(canonicalProfilePath, { force: true });
    const env = { ...process.env, CAREER_OPS_ROOT: root, TYPESAFE_API_KEY: '', RECEIVED_PROMPT: receivedPath,
      NODE_OPTIONS: '--require=./scorer.cjs' };
    return spawnSync(process.execPath, [join(ROOT, 'rank-pipeline.mjs'), '--cli', process.execPath],
      { encoding: 'utf8', cwd: tempDir, env });
  };
  for (const path of [join(tempDir, 'missing.yml'), compensationOnlyPath, join(tempDir, 'level-only.yml')]) {
    const bad = run(path);
    check(`ranking rejects incomplete targets in ${path.split('/').pop()} before invoking the scorer`,
      bad.status !== 0 && !existsSync(receivedPath) && !readFileSync(pipelinePath, 'utf8').includes('rank:'));
  }
  const good = run(profilePath);
  check('CLI ranking uses the canonical profile and persists the returned score',
    good.status === 0 && readFileSync(receivedPath, 'utf8').includes('target level: Senior Manager or Director')
      && readFileSync(pipelinePath, 'utf8').includes('rank: cal-v3 4.0/5 — target match'));
} catch (error) {
  fail(`rank target tests threw: ${error?.message ?? error}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
