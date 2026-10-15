// tests/liveness-api-linkedin-aside.test.mjs — LinkedIn read through the
// candidate's Aside session.
//
// A worker that opened linkedin.com/jobs/view/{id} in a tab and read its text
// got no description for most Brazilian postings, so they were never evaluated.
// Aside ships `linkedin.getJob(id)` inside `aside repl`, which answers from the
// user's own session with the posting's state and full description. The
// session rung runs first for every LinkedIn URL, for liveness and for JD text:
//
//   jobState LISTED + description -> active, JD text
//   any other jobState            -> expired (JD text still readable)
//   Aside missing / logged out    -> uncertain with the reason; the guest
//   / failing                        endpoint (liveness) or the caller's
//                                    fallback (fetch-jd exit 1) runs as before
//
// `aside` is replaced through ASIDE_BIN by a stub that evaluates the generated
// repl script against a recorded getJob payload, so the script's field mapping
// is exercised, not just the parser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkLivenessViaApi, checkLinkedInViaAside, classifyLinkedInAsideJob,
  parseAsideLinkedInJob, asideLinkedInJobScript,
} from '../liveness-api.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LISTED = join(ROOT, 'tests', 'fixtures', 'linkedin-aside-getjob-listed.json');
const CLOSED = join(ROOT, 'tests', 'fixtures', 'linkedin-aside-getjob-closed.json');
const GUEST_LIVE = readFileSync(join(ROOT, 'tests', 'fixtures', 'linkedin-guest-live-onsite.html'), 'utf-8');
// A shebang stub cannot be spawned by execFile on Windows; Aside is not a
// Windows CLI either. The missing-binary cases still run there.
const POSIX = process.platform !== 'win32';

const work = mkdtempSync(join(tmpdir(), 'linkedin-aside-'));
const STUB = join(work, 'aside');
const TRACE = join(work, 'trace.jsonl');
writeFileSync(STUB, `#!/usr/bin/env node
const fs = require('fs');
const [cmd, script] = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_TRACE, JSON.stringify({ at: Date.now(), cmd }) + '\\n');
const mode = process.env.STUB_MODE;
if (cmd !== 'repl' || mode === 'crash') {
  console.error(cmd !== 'repl' ? 'unexpected command ' + cmd : 'Aside daemon is not running');
  process.exitCode = 1;
} else {
  const payload = mode === 'logged-out' ? null : JSON.parse(fs.readFileSync(process.env.STUB_FIXTURE, 'utf8'));
  const linkedin = {
    async getJob(id) {
      if (!payload) {
        const e = new Error('LinkedIn Voyager request failed (401): jobs/jobPostings/' + id);
        e.name = 'LinkedInVoyagerError';
        throw e;
      }
      if (id !== String(payload.jobPostingId)) throw new Error('getJob called with ' + id);
      return payload;
    },
  };
  const AsyncFunction = (async () => {}).constructor;
  new AsyncFunction('linkedin', script)(linkedin).then(() => console.log('[ok | 1ms]'));
}
`);
if (POSIX) chmodSync(STUB, 0o755);

after(() => rmSync(work, { recursive: true, force: true }));

function withStub(mode, fixture) {
  process.env.ASIDE_BIN = STUB;
  process.env.STUB_TRACE = TRACE;
  process.env.STUB_MODE = mode;
  process.env.STUB_FIXTURE = fixture ?? '';
}

async function withGuestFetch(run) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(GUEST_LIVE, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try { return { verdict: await run(), calls }; } finally { globalThis.fetch = previous; }
}

const traceTimes = () => readFileSync(TRACE, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).at);

test('a listed posting is live through Aside and the guest endpoint is never asked', { skip: !POSIX }, async () => {
  withStub('listed', LISTED);
  const { verdict, calls } = await withGuestFetch(() =>
    checkLivenessViaApi('https://br.linkedin.com/jobs/view/head-de-operacoes-at-acme-brasil-4479715297/?refId=x&trk=public_jobs'));
  assert.deepEqual(verdict, {
    result: 'active',
    code: 'linkedin_aside_listed',
    reason: 'LinkedIn (via Aside) lists the posting with its description (live)',
  });
  assert.deepEqual(calls, []);
});

test('a closed posting is expired through Aside, spaced from the previous read', { skip: !POSIX }, async () => {
  withStub('closed', CLOSED);
  const { verdict, calls } = await withGuestFetch(() =>
    checkLivenessViaApi('https://www.linkedin.com/jobs/view/4011223344'));
  assert.equal(verdict.result, 'expired');
  assert.equal(verdict.code, 'linkedin_aside_closed');
  assert.match(verdict.reason, /CLOSED/);
  assert.deepEqual(calls, []);
  // The throttle spaces spawns 3 s apart; each stub stamps the trace after its
  // own Node startup, which jitters by a few hundred ms.
  const [first, second] = traceTimes();
  assert.ok(second - first >= 2_000, `reads ${second - first} ms apart`);
});

test('a logged-out session is uncertain and says why', { skip: !POSIX }, async () => {
  withStub('logged-out');
  const direct = await checkLinkedInViaAside('4479715297');
  assert.equal(direct.result, 'uncertain');
  assert.equal(direct.code, 'linkedin_aside_error');
  assert.match(direct.reason, /logged out or expired.*401/);
  assert.equal(direct.job, undefined);
});

test('a missing Aside binary is uncertain, and liveness falls back to the guest endpoint', async () => {
  process.env.ASIDE_BIN = join(work, 'no-such-aside');
  const direct = await checkLinkedInViaAside('4479715297');
  assert.equal(direct.result, 'uncertain');
  assert.equal(direct.code, 'linkedin_aside_unavailable');
  assert.match(direct.reason, /no-such-aside/);

  const { verdict, calls } = await withGuestFetch(() =>
    checkLivenessViaApi('https://www.linkedin.com/jobs/view/4479715297'));
  assert.equal(verdict.result, 'active');
  assert.equal(verdict.code, 'linkedin_apply_control');
  assert.deepEqual(calls, ['https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4479715297']);
});

function fetchJd(url, env) {
  return spawnSync(process.execPath, [join(ROOT, 'fetch-jd.mjs'), url], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, STUB_TRACE: TRACE, ...env },
  });
}

test('fetch-jd prints the LinkedIn JD with company, location and work model', { skip: !POSIX }, () => {
  const run = fetchJd('https://www.linkedin.com/jobs/view/4479715297', { ASIDE_BIN: STUB, STUB_MODE: 'listed', STUB_FIXTURE: LISTED });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, [
    'Head de Operações',
    '',
    'Company: Acme Brasil',
    'Location: São Paulo, São Paulo, Brazil',
    'Work model: Hybrid',
    'Remote allowed: no',
    '',
    'Head de Operações',
    '',
    'Jornada de trabalho: Modelo Híbrido - São Paulo',
    '',
    'Responsabilidades',
    'Liderar a operação de ponta a ponta e o time de 40 pessoas.',
  ].join('\n'));
});

test('fetch-jd keeps a closed LinkedIn JD and labels its status', { skip: !POSIX }, () => {
  const run = fetchJd('https://www.linkedin.com/jobs/view/4011223344', { ASIDE_BIN: STUB, STUB_MODE: 'closed', STUB_FIXTURE: CLOSED });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^LinkedIn status: CLOSED \(no longer accepting applications\)$/m);
  assert.match(run.stdout, /Fully remote role supporting litigation teams\./);
});

test('fetch-jd misses (exit 1, empty stdout) when Aside crashes or is absent', () => {
  const absent = fetchJd('https://www.linkedin.com/jobs/view/4479715297', { ASIDE_BIN: join(work, 'no-such-aside') });
  assert.equal(absent.status, 1);
  assert.equal(absent.stdout, '');
  if (!POSIX) return;
  const crash = fetchJd('https://www.linkedin.com/jobs/view/4479715297', { ASIDE_BIN: STUB, STUB_MODE: 'crash' });
  assert.equal(crash.status, 1);
  assert.equal(crash.stdout, '');
});

test('a crashing aside repl names the failure', { skip: !POSIX }, async () => {
  withStub('crash');
  const verdict = await checkLinkedInViaAside('4479715297');
  assert.equal(verdict.result, 'uncertain');
  assert.equal(verdict.code, 'linkedin_aside_failed');
  assert.match(verdict.reason, /Aside daemon is not running/);
});

test('jobState decides: LISTED with text is live, anything else is closed, no state is uncertain', () => {
  assert.equal(classifyLinkedInAsideJob({ jobState: 'LISTED', description: 'x' }).result, 'active');
  assert.equal(classifyLinkedInAsideJob({ jobState: 'SUSPENDED', description: 'x' }).result, 'expired');
  assert.equal(classifyLinkedInAsideJob({ jobState: 'LISTED', description: '  ' }).result, 'uncertain');
  assert.equal(classifyLinkedInAsideJob({ description: 'x' }).result, 'uncertain');
});

test('the repl script only ever embeds a numeric id', () => {
  assert.throws(() => asideLinkedInJobScript('1"); globalThis.injected = true; ("'));
  assert.match(asideLinkedInJobScript('4479715297'), /linkedin\.getJob\("4479715297"\)/);
});

test('output without the marker line, or with a broken one, carries no job', () => {
  assert.equal(parseAsideLinkedInJob('[ok | 3ms]'), null);
  assert.equal(parseAsideLinkedInJob('CAREER_OPS_LINKEDIN_JOB {broken'), null);
  assert.deepEqual(parseAsideLinkedInJob('noise\nCAREER_OPS_LINKEDIN_JOB {"jobState":"LISTED"}\n[ok | 3ms]'), { jobState: 'LISTED' });
});

