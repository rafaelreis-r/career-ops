import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  const pipelinePath = join(root, 'data', 'pipeline.md');
  const row = '- [ ] https://jobs.example/1 | Acme | Director of Engineering';
  writeFileSync(pipelinePath, `## Pending\n${row}\n`);
  const scorerPath = join(tempDir, 'scorer.cjs');
  const receivedPath = join(tempDir, 'received.txt');
  writeFileSync(scorerPath, [
    '#!/usr/bin/env node',
    'const fs = require("fs");',
    'fs.writeFileSync(process.env.RECEIVED_PROMPT, process.argv[3]);',
    'process.stdout.write(JSON.stringify([{id:0, score:4, reason:"target match"}]));',
  ].join('\n'));
  chmodSync(scorerPath, 0o755);
  const run = (path) => spawnSync(process.execPath,
    [join(ROOT, 'rank-pipeline.mjs'), '--cli', scorerPath],
    { encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: root,
      CAREER_OPS_PROFILE: path, TYPESAFE_API_KEY: '', RECEIVED_PROMPT: receivedPath } });
  for (const path of [join(tempDir, 'missing.yml'), compensationOnlyPath, join(tempDir, 'level-only.yml')]) {
    const bad = run(path);
    check(`ranking rejects incomplete targets in ${path.split('/').pop()} before invoking the scorer`,
      bad.status !== 0 && !existsSync(receivedPath) && !readFileSync(pipelinePath, 'utf8').includes('rank:'));
  }
  const good = run(profilePath);
  check('CLI ranking passes targets and persists the returned score',
    good.status === 0 && readFileSync(receivedPath, 'utf8').includes('target level: Senior Manager or Director')
      && readFileSync(pipelinePath, 'utf8').includes('rank: cal-v2 4.0/5 — target match'));
} catch (error) {
  fail(`rank target tests threw: ${error?.message ?? error}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
