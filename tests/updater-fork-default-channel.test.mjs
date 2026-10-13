import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NODE, ROOT } from './helpers.mjs';

// The fork publishes no GitHub releases: /releases/latest answers 404. On
// upstream's default 'release' channel (#3845) every track's `check` would
// report `offline` and every `apply` would throw from the second update on.
// The fork defaults to 'main' instead. DEFAULT_CHANNEL is read when
// update-system.mjs loads, so each case runs in a child process whose env is
// controlled here (test-all.mjs exports CAREER_OPS_UPDATE_DEFAULT_CHANNEL=release
// for upstream's own release-channel suites).
const UPDATER = pathToFileURL(join(ROOT, 'update-system.mjs')).href;

function probe(script, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (!('CAREER_OPS_UPDATE_DEFAULT_CHANNEL' in extraEnv)) delete env.CAREER_OPS_UPDATE_DEFAULT_CHANNEL;
  delete env.CAREER_OPS_UPDATE_CHANNEL;
  const run = spawnSync(NODE, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').pop());
}

// Only main's VERSION answers; the releases API and the ref API are "offline",
// which is what a release-less fork looks like from the release channel.
const PRELUDE = `
const { resolveTargetRef, checkStatus } = await import(${JSON.stringify(UPDATER)});
const urls = [];
const curlGet = async (url) => { urls.push(url); return url.endsWith('/main/VERSION') ? '1.36.0\\n' : null; };
`;

test('without a channel, apply resolves main with no release lookup', () => {
  const out = probe(`${PRELUDE}
const ref = await resolveTargetRef(['apply', '--confirm'], {}, { curlGet });
console.log(JSON.stringify({ ref, urls }));`);
  assert.equal(out.ref, 'main');
  assert.deepEqual(out.urls, []);
});

test('without a channel, check follows main instead of reporting offline', () => {
  const out = probe(`${PRELUDE}
const res = await checkStatus(['check'], {}, { curlGet, localVersion: () => '1.36.0', localShortSha: () => '', readMarker: () => null });
console.log(JSON.stringify({ res, urls }));`);
  assert.equal(out.res.status, 'up-to-date', JSON.stringify(out.res));
  assert.equal(out.res.remote, '1.36.0');
  assert.ok(out.urls.some((u) => u.endsWith('/main/VERSION')), `main's VERSION was not read: ${out.urls.join(', ')}`);
});

test('--channel release and CAREER_OPS_UPDATE_DEFAULT_CHANNEL=release still reach the release tag', () => {
  const script = `${PRELUDE}
const release = async () => JSON.stringify({ tag_name: 'career-ops-v1.36.0' });
const flagged = await resolveTargetRef(['apply', '--channel', 'release'], {}, { curlGet: release });
const byDefault = await resolveTargetRef(['apply'], {}, { curlGet: release });
console.log(JSON.stringify({ flagged, byDefault }));`;
  assert.deepEqual(probe(script), { flagged: 'career-ops-v1.36.0', byDefault: 'main' });
  assert.deepEqual(probe(script, { CAREER_OPS_UPDATE_DEFAULT_CHANNEL: 'release' }), { flagged: 'career-ops-v1.36.0', byDefault: 'career-ops-v1.36.0' });
});
