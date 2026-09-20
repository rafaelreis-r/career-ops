// Worker-facing CLI for the LLM-owned apply path (web/scripts/jev-apply.mjs).
// Spawns the real process: JSON on stdout, exit 0 on a decision (including
// NONE), non-zero only on usage/transport errors. TYPESAFE_API_KEY is cleared
// so these never make a live TypeSafe call.
//
// Run:  node --test web/tests/lib/jev-apply-cli.test.mjs   (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(WEB, 'scripts', 'jev-apply.mjs');

function run(args, { input, env } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: WEB,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      TYPESAFE_API_KEY: '',
      JEV_APPLY_CONFIDENCE_THRESHOLD: '0.6',
      ...env,
    },
    timeout: 15_000,
  });
  let json = null;
  const stdout = (res.stdout || '').trim();
  try {
    json = stdout ? JSON.parse(stdout) : null;
  } catch {
    json = null;
  }
  return { status: res.status, stdout, stderr: (res.stderr || '').trim(), json };
}

test('CLI route: allowlisted host and subdomain take the fast path', () => {
  assert.deepEqual(run(['route', 'https://applytojob.com/apply/123']).json, { route: 'fast' });
  assert.equal(run(['route', 'https://applytojob.com/apply/123']).status, 0);
  assert.equal(run(['route', 'https://careers.applytojob.com/jobs/1']).json.route, 'fast');
});

test('CLI route: every other host, a suffix trick, and an unparseable URL take llm', () => {
  assert.equal(run(['route', 'https://boards.greenhouse.io/acme/jobs/1']).json.route, 'llm');
  assert.equal(run(['route', 'https://www.linkedin.com/jobs/view/1']).json.route, 'llm');
  assert.equal(run(['route', 'https://notapplytojob.com/apply/1']).json.route, 'llm');
  assert.equal(run(['route', 'not a url']).json.route, 'llm');
});

test('CLI route: path and query never move the decision', () => {
  assert.equal(run(['route', 'https://applytojob.com/x?host=greenhouse.io']).json.route, 'fast');
  assert.equal(run(['route', 'https://greenhouse.io/x?url=applytojob.com']).json.route, 'llm');
});

test('CLI route: missing URL is a usage error, not a decision', () => {
  const res = run(['route']);
  assert.equal(res.status, 1);
  assert.equal(res.json, null);
  assert.match(res.stderr, /route requires a <url>/);
});

test('CLI --help exits 0; unknown subcommand and invalid JSON exit 1', () => {
  assert.equal(run(['--help']).status, 0);
  assert.equal(run(['submit']).status, 1);
  const bad = run(['pick', '--input', '{nope']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid JSON/);
});

test('CLI ready: an empty required field is not ready (deterministic, exit 0)', () => {
  const res = run(['ready', '--input', JSON.stringify({
    fields: [
      { label: 'Email', required: true, value: 'you@example.com' },
      { label: 'Phone', required: true, value: '   ' },
    ],
  })]);
  assert.equal(res.status, 0);
  assert.equal(res.json.ready, false);
});

test('CLI ready: disabled Jev with every required field filled is ready (deterministic floor)', () => {
  const res = run(['ready', '--input', JSON.stringify({
    fields: [{ label: 'Email', required: true, value: 'you@example.com' }],
  })]);
  assert.equal(res.status, 0);
  assert.equal(res.json.ready, true);
});

test('CLI pick/bool/block: disabled Jev abstains to null and still exits 0', () => {
  const pick = run(['pick', '--input', JSON.stringify({
    options: ['Remote', 'Hybrid', 'On-site'],
    label: 'Work mode',
    desiredValue: 'Remote',
  })]);
  assert.equal(pick.status, 0);
  assert.equal(pick.json.index, null);

  const bool = run(['bool', '--input', JSON.stringify({ question: 'Do you require sponsorship?' })]);
  assert.equal(bool.status, 0);
  assert.equal(bool.json.bool, null);

  const block = run(['block', '--input', JSON.stringify({
    pageState: { visibleText: 'Please verify you are human', hasCaptchaWidget: true },
  })]);
  assert.equal(block.status, 0);
  assert.equal(block.json.block, null);
});

test('CLI pick: JSON on stdin is accepted the same as --input', () => {
  const res = run(['pick'], { input: '{"options":["Remote","Hybrid"],"desiredValue":"Remote"}\n' });
  assert.equal(res.status, 0);
  assert.equal(res.json.index, null);
});
