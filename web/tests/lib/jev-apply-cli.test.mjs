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
import fs from 'node:fs';
import os from 'node:os';
import { main } from '../../scripts/jev-apply.mjs';

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
  // profileFacts is supplied so this spawn does not load ab-jev-apply.mjs
  // (playwright-core). The documented no-profileFacts worker path is the same
  // readyToSubmit call; the empty-required return happens before Jev either way.
  const res = run(['ready', '--input', JSON.stringify({
    fields: [
      { label: 'Email', required: true, value: 'you@example.com' },
      { label: 'Phone', required: true, value: '   ' },
    ],
    profileFacts: [],
  })]);
  assert.equal(res.status, 0);
  assert.deepEqual(res.json, { ready: false, confidence: 1, abstained: false });
});

test('CLI ready: disabled Jev with every required field filled is ready (deterministic floor)', () => {
  const res = run(['ready', '--input', JSON.stringify({
    fields: [{ label: 'Email', required: true, value: 'you@example.com' }],
    profileFacts: [],
  })]);
  assert.equal(res.status, 0);
  assert.deepEqual(res.json, { ready: true, confidence: 0, abstained: true });
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

// ── ready: profile-fact injection (in-process, mocked fetch — no live call) ──
//
// This exercises jev-apply.mjs's `ready` subcommand directly (not spawned) so
// the Jev transport can be mocked at the global.fetch boundary and the actual
// request body inspected — a spawned child process with TYPESAFE_API_KEY
// cleared never reaches the transport at all, so it can't prove what state
// would have been sent.

test('CLI ready: a below-threshold Jev noul (confidence 0.12) is ready and abstained, not a hold-back', async () => {
  // Pins the 2026-09-20 Tier 1 round: Cohere/CookUnity/General Legal/Lightning AI
  // came back ready:false at confidence 0.12–0.32 even though every required
  // field was filled. noul 0.56 → |0.56-0.5|*2 = 0.12. Abstention is "no
  // decision", not "not ready"; the deterministic floor already passed.
  const originalFetch = global.fetch;
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  const hadKeyEnv = 'TYPESAFE_API_KEY' in process.env;
  const savedKeyEnv = process.env.TYPESAFE_API_KEY;
  const hadThresholdEnv = 'JEV_APPLY_CONFIDENCE_THRESHOLD' in process.env;
  const savedThresholdEnv = process.env.JEV_APPLY_CONFIDENCE_THRESHOLD;

  let stdout = '';
  let exitCodeAfter = 0;
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_APPLY_CONFIDENCE_THRESHOLD = '0.6';
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ answers: { ready_to_submit: { noul: 0.56 } } }),
  });
  process.stdout.write = (chunk) => { stdout += chunk; return true; };

  try {
    await main(['ready', '--input', JSON.stringify({
      fields: [{ label: 'Email', required: true, value: 'jordan.rivera@example.com' }],
      profileFacts: [{ label: 'Email', value: 'jordan.rivera@example.com' }],
    })]);
    exitCodeAfter = process.exitCode || 0;
  } finally {
    global.fetch = originalFetch;
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
    if (hadKeyEnv) process.env.TYPESAFE_API_KEY = savedKeyEnv; else delete process.env.TYPESAFE_API_KEY;
    if (hadThresholdEnv) process.env.JEV_APPLY_CONFIDENCE_THRESHOLD = savedThresholdEnv;
    else delete process.env.JEV_APPLY_CONFIDENCE_THRESHOLD;
  }

  const json = JSON.parse(stdout.trim());
  assert.equal(json.ready, true);
  assert.equal(json.abstained, true);
  assert.ok(json.confidence < 0.6, `expected below-threshold confidence, got ${json.confidence}`);
  assert.equal(exitCodeAfter, 0);
});

test('CLI ready: the candidate\'s profile facts are always attached to the state sent to Jev', async () => {
  const tmpProfile = join(os.tmpdir(), `co-jev-apply-cli-${process.pid}-${Date.now()}.yml`);
  fs.writeFileSync(
    tmpProfile,
    'candidate:\n  full_name: Jordan Rivera\n  email: jordan.rivera@example.com\n  phone: "+1 555 0100"\n',
  );

  const originalFetch = global.fetch;
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  const hadProfileEnv = 'CAREER_OPS_PROFILE' in process.env;
  const savedProfileEnv = process.env.CAREER_OPS_PROFILE;
  const hadKeyEnv = 'TYPESAFE_API_KEY' in process.env;
  const savedKeyEnv = process.env.TYPESAFE_API_KEY;

  let capturedBody = null;
  let stdout = '';
  process.env.CAREER_OPS_PROFILE = tmpProfile;
  process.env.TYPESAFE_API_KEY = 'test-key';
  global.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ answers: { ready_to_submit: { noul: 0.95 } } }) };
  };
  process.stdout.write = (chunk) => { stdout += chunk; return true; };

  try {
    await main(['ready', '--input', JSON.stringify({
      fields: [{ label: 'Email', required: true, value: 'jordan.rivera@example.com' }],
    })]);
  } finally {
    global.fetch = originalFetch;
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
    if (hadProfileEnv) process.env.CAREER_OPS_PROFILE = savedProfileEnv; else delete process.env.CAREER_OPS_PROFILE;
    if (hadKeyEnv) process.env.TYPESAFE_API_KEY = savedKeyEnv; else delete process.env.TYPESAFE_API_KEY;
    fs.rmSync(tmpProfile, { force: true });
  }

  assert.ok(capturedBody, 'expected the ready gate to call Jev');
  const state = JSON.parse(capturedBody.state);
  const profileFacts = state?.form_state?.profileFacts;
  assert.equal(profileFacts?.candidate?.email, 'jordan.rivera@example.com');

  const json = JSON.parse(stdout.trim());
  assert.equal(json.ready, true);
  assert.equal(json.abstained, false);
});
