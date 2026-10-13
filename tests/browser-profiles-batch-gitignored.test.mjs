// tests/browser-profiles-batch-gitignored.test.mjs
//
// Browser profiles hold live session cookies, and every batch round writes its
// state, input, selection, prompts, results and logs next to the reusable
// scripts in batch/. None of that may be stageable by a reflexive `git add .`,
// while the reusable files in batch/ must stay visible to git.

import { spawnSync } from 'child_process';
import { pass, fail, ROOT } from './helpers.mjs';

function checkIgnore(probe) {
  const r = spawnSync('git', ['check-ignore', '-q', '--no-index', probe], { cwd: ROOT, encoding: 'utf-8' });
  if (r.status === 0) return 'ignored';
  if (r.status === 1) return 'not-ignored';
  return `unanswerable: ${(r.stderr || r.error?.message || `git exited ${r.status}`).trim()}`;
}

const mustBeIgnored = [
  '.browser-profiles/jobgether-1018/Default/Cookies',
  'batch/batch-state-avalia-1012.tsv',
  'batch/batch-state.tsv.messy-bak',
  'batch/batch-input-avalia-1012b.tsv',
  'batch/batch-prompt-avalia-1012.md',
  'batch/batch-runner-avalia-1012.sh',
  'batch/batch-runner-avalia-1013.pid',
  'batch/batch-runner.paused',
  'batch/.batch-state.lock/pid',
  'batch/selected-avalia-1012-B.json',
  'batch/results-B-avalia-1012.json',
  'batch/monitor-counts-avalia-1012.jsonl',
  'batch/runner-console-avalia-1012-A.log',
  'batch/liveness-input-avalia-1012.txt',
  'batch/rank-avalia-1012-A.exit',
  'batch/logs-avalia-1012/offer-1.log',
  'batch/tracker-additions-avalia-1012/1-acme.tsv',
  'batch/.rank-sandbox-avalia-1012/prompt.md',
  'batch/scan-c-2026-09-23/runner.log',
  'batch/orphan-avalia-1004/state.txt',
];

const mustStayVisible = [
  'batch/batch-runner.sh',
  'batch/batch-prompt.md',
  'batch/aggregate-tokens.mjs',
  'batch/README.md',
  'batch/select-avalia-1012.mjs',
  'batch/logs/.gitkeep',
  'batch/tracker-additions/.gitkeep',
];

for (const path of mustBeIgnored) {
  const verdict = checkIgnore(path);
  if (verdict === 'ignored') pass(`${path} is git-ignored`);
  else if (verdict === 'not-ignored') fail(`${path} is NOT git-ignored — session or per-round data could be committed`);
  else fail(`${path}: git check-ignore could not answer — ${verdict}`);
}

for (const path of mustStayVisible) {
  const verdict = checkIgnore(path);
  if (verdict === 'not-ignored') pass(`${path} stays visible to git`);
  else if (verdict === 'ignored') fail(`${path} became ignored — a reusable batch file could no longer be committed`);
  else fail(`${path}: git check-ignore could not answer — ${verdict}`);
}
