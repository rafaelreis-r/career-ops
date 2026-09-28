// tests/providers/jobs-search.test.mjs — Jobs Search MCP provider.
//
// The real @modelcontextprotocol/sdk client runs against an in-process fake of
// the MCP server and the OAuth token endpoint, injected as `fetchFn`: no live
// network. Tool payloads are recorded fixtures (tests/fixtures/jobs-search/),
// fictionalized (Acme/ExampleCo), with the field layout the live server
// returned on 2026-09-28.
import { pass, fail, ROOT, rmSync } from '../helpers.mjs';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — jobs-search');

const mod = await import(pathToFileURL(join(ROOT, 'providers/jobs-search.mjs')).href);
const auth = await import(pathToFileURL(join(ROOT, 'providers/_jobs-search-auth.mjs')).href);
const { formatCompensation } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
const { createJobsSearchProvider, normalizeJobsSearchJob, resolveJobsSearchConfig } = mod;

const FIXTURES = join(ROOT, 'tests/fixtures/jobs-search');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'));
const ENDPOINT = 'https://mcp.jobs.bridglabs.com/mcp';
const TOKEN_URL = 'https://conta.jobs.bridglabs.com/oauth/token';
const AS_METADATA = {
  issuer: 'https://conta.jobs.bridglabs.com',
  authorization_endpoint: 'https://conta.jobs.bridglabs.com/oauth/authorize',
  token_endpoint: TOKEN_URL,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
  code_challenge_methods_supported: ['S256'],
  client_id_metadata_document_supported: true,
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * Fake MCP server + authorization server. `tools` maps a tool name to
 * (args, n) => payload | { isError, text }. Every request is logged.
 */
function fakeServer({ tools, validTokens = ['access-live'], refresh } = {}) {
  const log = [];
  const toolCalls = [];
  const fetchFn = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    log.push({ url, method, redirect: init.redirect, authorization: headers.get('authorization') });
    if (url.startsWith('https://conta.jobs.bridglabs.com/.well-known/')) return json(AS_METADATA);
    if (url === TOKEN_URL) {
      const params = new URLSearchParams(String(init.body));
      return refresh ? refresh(params) : json({ error: 'invalid_grant' }, 400);
    }
    if (url !== ENDPOINT) throw new Error(`unexpected fetch ${url}`);
    if (method === 'GET') return new Response(null, { status: 405 });
    if (method === 'DELETE') return new Response(null, { status: 200 });
    const token = (headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!validTokens.includes(token)) return json({ error: 'invalid_token' }, 401);
    const msg = JSON.parse(String(init.body));
    if (msg.method === 'initialize') {
      return json(
        { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } },
        200,
        { 'mcp-session-id': 'session-1' },
      );
    }
    if (!('id' in msg)) return new Response(null, { status: 202 });
    if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params;
      toolCalls.push({ name, args });
      const handler = tools?.[name];
      if (!handler) return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no tool ${name}` } });
      const out = handler(args, toolCalls.filter((c) => c.name === name).length);
      const result = out?.isError
        ? { isError: true, content: [{ type: 'text', text: out.text }] }
        : { content: [{ type: 'text', text: JSON.stringify(out) }] };
      return json({ jsonrpc: '2.0', id: msg.id, result });
    }
    return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: msg.method } });
  };
  return { fetchFn, log, toolCalls };
}

const START = Date.parse('2026-09-28T10:30:00Z');

function clock(start = START) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    sleeps,
    ctx: { transport: 'http', sleep: async (ms) => { sleeps.push(ms); t += ms; } },
  };
}

function sandbox({ expiresInMs = 3_600_000, now = START, refreshToken = 'refresh-1', accessToken = 'access-live' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-search-test-'));
  const credentialsFile = join(dir, 'cred', 'credentials.json');
  auth.saveCredentials(credentialsFile, auth.normalizeCredentials({
    client_id: auth.CODEX_CLIENT_ID,
    token_response: { access_token: accessToken, token_type: 'bearer', refresh_token: refreshToken, scope: 'jobs:read' },
    expires_at: now + expiresInMs,
  }, 'test'));
  const entry = { name: 'Jobs Search', provider: 'jobs-search', jobs_search: { credentials_file: credentialsFile, cache_dir: join(dir, 'cache') } };
  return { dir, credentialsFile, entry, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const pagedTools = (overrides = {}) => ({
  get_usage: () => fixture('get-usage.json'),
  get_new_jobs: (args) => fixture(args.cursor ? `get-new-jobs-${args.cursor}.json` : 'get-new-jobs-page1.json'),
  ...overrides,
});

async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

// --- identity & config -------------------------------------------------------

const provider = mod.default;
if (provider.id === 'jobs-search' && provider.detect === undefined) pass('id is "jobs-search" and there is no detect() (explicit provider: only)');
else fail(`id/detect = ${JSON.stringify({ id: provider.id, detect: typeof provider.detect })}`);

{
  const cfg = resolveJobsSearchConfig({ provider: 'jobs-search' }, { XDG_CONFIG_HOME: '/x/config', XDG_CACHE_HOME: '/x/cache' });
  if (
    cfg.period === 'day' && cfg.endpoint === ENDPOINT && cfg.maxPages === 30 &&
    cfg.credentialsFile === '/x/config/career-ops/jobs-search/credentials.json' &&
    cfg.cacheDir === '/x/cache/career-ops/jobs-search'
  ) pass('config defaults: period day, the Bridg endpoint, XDG credential and cache paths');
  else fail(`config defaults = ${JSON.stringify(cfg)}`);

  const env = { CAREER_OPS_JOBS_SEARCH_CREDENTIALS: '/e/cred.json', CAREER_OPS_JOBS_SEARCH_CACHE_DIR: '/e/cache' };
  const fromEnv = resolveJobsSearchConfig({}, env);
  const fromEntry = resolveJobsSearchConfig({ jobs_search: { credentials_file: '/p/cred.json', cache_dir: '/p/cache', period: 'week', max_pages: 9999 } }, env);
  if (
    fromEnv.credentialsFile === '/e/cred.json' && fromEnv.cacheDir === '/e/cache' &&
    fromEntry.credentialsFile === '/p/cred.json' && fromEntry.cacheDir === '/p/cache' &&
    fromEntry.period === 'week' && fromEntry.maxPages === 150
  ) pass('entry keys override env, env overrides the default; max_pages capped at 150');
  else fail(`config precedence = ${JSON.stringify({ fromEnv, fromEntry })}`);

  const bad = [
    () => resolveJobsSearchConfig({ jobs_search: { period: 'year' } }),
    () => resolveJobsSearchConfig({ jobs_search: { endpoint: 'https://evil.example/mcp' } }),
    () => resolveJobsSearchConfig({ jobs_search: { endpoint: 'http://mcp.jobs.bridglabs.com/mcp' } }),
    () => resolveJobsSearchConfig({ jobs_search: { endpoint: 'not a url' } }),
  ].map((f) => { try { f(); return null; } catch (e) { return e.message; } });
  if (bad.every((m) => typeof m === 'string' && m.startsWith('jobs-search:'))) pass('rejects an unknown period, a foreign host, plain http and a malformed endpoint');
  else fail(`config rejections = ${JSON.stringify(bad)}`);
}

if (auth.codexKeychainAccount('jobs-search', ENDPOINT) === 'jobs-search|a37461d2ddee6282') {
  pass('codexKeychainAccount reproduces the account Codex filed the live grant under');
} else fail(`codexKeychainAccount = ${auth.codexKeychainAccount('jobs-search', ENDPOINT)}`);

// --- normalization -------------------------------------------------------------

{
  const [first, noSource, httpSource, yearly] = fixture('get-new-jobs-page1.json').jobs;
  const job = normalizeJobsSearchJob(first);
  if (
    job?.url === first.sourceUrl && job.company === 'Acme' && job.title === 'Senior Backend Engineer' &&
    job.location === 'Brazil / São Paulo, SP, Brazil' && job.postedAt === Date.parse(first.publishedAt) &&
    formatCompensation(job.salary) === '96000-144000 USD' &&
    formatCompensation(normalizeJobsSearchJob(yearly)?.salary) === '240000 BRL'
  ) pass('maps sourceUrl, real company/title, locations, publishedAt; salary minimum/maximum annualized for formatCompensation');
  else fail(`normalized job = ${JSON.stringify(job)} / comp ${formatCompensation(job?.salary)}`);

  const fallbacks = [normalizeJobsSearchJob(noSource)?.url, normalizeJobsSearchJob(httpSource)?.url];
  if (fallbacks[0] === noSource.url && fallbacks[1] === httpSource.url) pass('falls back to the Bridg url when sourceUrl is absent or not https:');
  else fail(`url fallbacks = ${JSON.stringify(fallbacks)}`);

  const drops = [
    normalizeJobsSearchJob({ ...first, title: '' }),
    normalizeJobsSearchJob({ ...first, company: undefined }),
    normalizeJobsSearchJob({ ...first, sourceUrl: undefined, url: 'javascript:alert(1)' }),
    normalizeJobsSearchJob(null),
  ];
  const noDate = normalizeJobsSearchJob({ ...first, publishedAt: 'soon', salary: { currency: 'BRL', interval: 'year', minimum: null, maximum: null } });
  const oddUnit = normalizeJobsSearchJob({ ...first, salary: { currency: 'BRL', interval: 'fortnight', minimum: 5000, maximum: 6000 } });
  if (drops.every((d) => d === null) && noDate && !('postedAt' in noDate) && !('salary' in noDate) && oddUnit && !('salary' in oddUnit)) {
    pass('drops rows without title/company/usable url; a bad date, a bound-less salary or an unknown interval is omitted, not coerced');
  } else fail(`drops = ${JSON.stringify({ drops, noDate, oddUnit })}`);
}

// --- fetch: pagination, quota check, pacing, cache ----------------------------

{
  const box = sandbox({ expiresInMs: 24 * 3_600_000 });
  const c = clock();
  const srv = fakeServer({ tools: pagedTools() });
  const p = createJobsSearchProvider({ fetchFn: srv.fetchFn, now: c.now });
  const jobs = await p.fetch(box.entry, c.ctx);
  const names = srv.toolCalls.map((t) => t.name);
  const pageArgs = srv.toolCalls.filter((t) => t.name === 'get_new_jobs').map((t) => t.args);
  const expected = [...fixture('get-new-jobs-page1.json').jobs, ...fixture('get-new-jobs-cursor-2.json').jobs, ...fixture('get-new-jobs-cursor-3.json').jobs]
    .filter((row, i, all) => all.findIndex((r) => r.id === row.id) === i)
    .map(normalizeJobsSearchJob).filter(Boolean);
  if (
    names.join(',') === 'get_usage,get_new_jobs,get_new_jobs,get_new_jobs' &&
    pageArgs.every((a) => a.period === 'day' && a.limit === 20) &&
    pageArgs[0].cursor === undefined && pageArgs[1].cursor === 'cursor-2' && pageArgs[2].cursor === 'cursor-3' &&
    jobs.length === expected.length && jobs.every((j, i) => j.url === expected[i].url)
  ) pass('reads get_usage first, then follows nextCursor to the end with period/limit 20, deduping repeated ids');
  else fail(`paging = ${JSON.stringify({ names, pageArgs, got: jobs.length, want: expected.length })}`);

  if (srv.log.every((r) => r.redirect === 'error')) pass('every MCP and OAuth request is sent with redirect: "error"');
  else fail(`redirects = ${JSON.stringify(srv.log.map((r) => r.redirect))}`);

  if (c.sleeps.length === 3 && c.sleeps.every((ms) => ms >= 6_000)) pass('spaces tool calls ≥ 6 s apart (under 10 queries/minute)');
  else fail(`sleeps = ${JSON.stringify(c.sleeps)}`);

  // A second lane right after: served from the cache, no network at all.
  const before = srv.log.length;
  c.advance(10 * 60_000);
  const again = await p.fetch({ ...box.entry, name: 'Jobs Search (lane 2)' }, c.ctx);
  if (srv.log.length === before && again.length === jobs.length) pass('a later scan inside cache_ttl_minutes reuses the pull: zero requests');
  else fail(`cache reuse = ${JSON.stringify({ requests: srv.log.length - before, jobs: again.length })}`);

  // Past the TTL: pulls again.
  c.advance(4 * 60 * 60_000);
  await p.fetch(box.entry, c.ctx);
  if (srv.toolCalls.length === 8) pass('a stale cache is refreshed with a new pull');
  else fail(`stale cache tool calls = ${srv.toolCalls.length}`);
  box.cleanup();
}

{
  const box = sandbox();
  const c = clock();
  const srv = fakeServer({ tools: pagedTools() });
  await createJobsSearchProvider({ fetchFn: srv.fetchFn, now: c.now }).fetch(box.entry, { ...c.ctx, maxPages: 1 });
  const pages = srv.toolCalls.filter((t) => t.name === 'get_new_jobs').length;
  if (pages === 1 && !existsSync(join(box.entry.jobs_search.cache_dir, 'new-jobs-day.json'))) pass('ctx.maxPages: 1 (health probe) reads one page and caches nothing');
  else fail(`probe = ${JSON.stringify({ pages })}`);
  box.cleanup();
}

{
  const box = sandbox();
  const c = clock();
  const srv = fakeServer({ tools: pagedTools({ get_usage: () => fixture('get-usage-exhausted.json') }) });
  const err = await rejects(createJobsSearchProvider({ fetchFn: srv.fetchFn, now: c.now }).fetch(box.entry, c.ctx));
  if (err && /0 queries left this day/.test(err.message) && !srv.toolCalls.some((t) => t.name === 'get_new_jobs')) {
    pass('an exhausted allowance stops before any get_new_jobs call');
  } else fail(`exhausted = ${JSON.stringify({ err: err?.message, calls: srv.toolCalls.map((t) => t.name) })}`);
  box.cleanup();
}

{
  // The last complete pull took 3 pages; 2 queries left → skip before paging.
  const box = sandbox({ expiresInMs: 48 * 3_600_000 });
  const c = clock();
  const usage = fixture('get-usage.json');
  usage.usage.queryDay = 118;
  const srv = fakeServer({ tools: pagedTools({ get_usage: () => usage }) });
  const p = createJobsSearchProvider({ fetchFn: srv.fetchFn, now: c.now });
  const cacheFile = join(box.entry.jobs_search.cache_dir, 'new-jobs-day.json');
  await createJobsSearchProvider({ fetchFn: fakeServer({ tools: pagedTools() }).fetchFn, now: c.now }).fetch(box.entry, c.ctx);
  c.advance(24 * 3_600_000);
  const stale = readFileSync(cacheFile, 'utf-8');
  const err = await rejects(p.fetch(box.entry, c.ctx));
  const pages = srv.toolCalls.filter((t) => t.name === 'get_new_jobs').length;
  if (err && /2 queries left this day, the pull needs about 3/.test(err.message) && pages === 0 && readFileSync(cacheFile, 'utf-8') === stale) {
    pass('an allowance smaller than the last pull\'s page count stops before paging, cache untouched');
  } else fail(`short allowance = ${JSON.stringify({ err: err?.message, pages })}`);
  box.cleanup();
}

{
  // No history (estimate 1 page) but the day needs 3 and only 2 are left.
  const box = sandbox();
  const c = clock();
  const usage = fixture('get-usage.json');
  usage.usage.queryDay = 118;
  const srv = fakeServer({ tools: pagedTools({ get_usage: () => usage }) });
  const err = await rejects(createJobsSearchProvider({ fetchFn: srv.fetchFn, now: c.now }).fetch(box.entry, c.ctx));
  const pages = srv.toolCalls.filter((t) => t.name === 'get_new_jobs').length;
  if (err && /ran out after 2 page/.test(err.message) && pages === 2 && !existsSync(join(box.entry.jobs_search.cache_dir, 'new-jobs-day.json'))) {
    pass('running out mid-pull stops at the allowance with a named error and caches nothing');
  } else fail(`ran out = ${JSON.stringify({ err: err?.message, pages })}`);
  box.cleanup();
}

{
  // Another client used the whole minute: wait for the reset before paging.
  const box = sandbox();
  const c = clock();
  const usage = fixture('get-usage.json');
  usage.usage.queryMinute = 10;
  usage.usage.resets.minute = new Date(START + 40_000).toISOString();
  const srv = fakeServer({ tools: pagedTools({ get_usage: () => usage }) });
  await createJobsSearchProvider({ fetchFn: srv.fetchFn, now: c.now }).fetch(box.entry, c.ctx);
  if (c.sleeps[0] === 40_000) pass('a spent per-minute allowance waits for its reset before the first page');
  else fail(`minute wait = ${JSON.stringify(c.sleeps)}`);
  box.cleanup();
}

// --- fetch: payload errors ----------------------------------------------------

{
  const box = sandbox();
  const c = clock();
  const cases = [
    [{ get_new_jobs: () => ({ isError: true, text: 'Limite de consultas por minuto atingido' }) }, /get_new_jobs failed: Limite/],
    [{ get_new_jobs: () => ({ results: [] }) }, /unexpected shape — keys: \[results\]/],
    [{ get_usage: () => ({ plan: 'x' }) }, /get_usage returned an unexpected shape/],
  ];
  const outcomes = [];
  for (const [tools, re] of cases) {
    rmSync(join(box.dir, 'cache'), { recursive: true, force: true });
    const srv = fakeServer({ tools: pagedTools(tools) });
    const err = await rejects(createJobsSearchProvider({ fetchFn: srv.fetchFn, now: c.now }).fetch(box.entry, c.ctx));
    outcomes.push(Boolean(err && re.test(err.message)));
  }
  if (outcomes.every(Boolean)) pass('a tool error, a changed page shape and a changed usage shape each throw a descriptive error');
  else fail(`payload errors = ${JSON.stringify(outcomes)}`);

  rmSync(join(box.dir, 'cache'), { recursive: true, force: true });
  const srv = fakeServer({ tools: pagedTools({ get_new_jobs: () => ({ jobs: [], nextCursor: null }) }) });
  const empty = await createJobsSearchProvider({ fetchFn: srv.fetchFn, now: c.now }).fetch(box.entry, c.ctx);
  if (Array.isArray(empty) && empty.length === 0) pass('a day with no new jobs returns []');
  else fail(`empty day = ${JSON.stringify(empty)}`);
  box.cleanup();
}

// --- auth ---------------------------------------------------------------------

{
  const box = sandbox({ expiresInMs: 60_000, accessToken: 'access-old', refreshToken: 'refresh-1' });
  const c = clock();
  const grants = [];
  const srv = fakeServer({
    tools: pagedTools(),
    validTokens: ['access-new'],
    refresh: (params) => {
      grants.push(Object.fromEntries(params));
      return json({ access_token: 'access-new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-2', scope: 'jobs:read' });
    },
  });
  const jobs = await createJobsSearchProvider({ fetchFn: srv.fetchFn, now: c.now }).fetch(box.entry, c.ctx);
  const stored = JSON.parse(readFileSync(box.credentialsFile, 'utf-8'));
  const mode = statSync(box.credentialsFile).mode & 0o777;
  const g = grants[0] || {};
  if (
    jobs.length > 0 && grants.length === 1 &&
    g.grant_type === 'refresh_token' && g.refresh_token === 'refresh-1' && g.client_id === auth.CODEX_CLIENT_ID && g.resource === ENDPOINT &&
    stored.tokens.access_token === 'access-new' && stored.tokens.refresh_token === 'refresh-2' &&
    stored.expires_at === START + 3_600_000 &&
    (process.platform === 'win32' || mode === 0o600)
  ) pass('an access token near expiry is renewed with the refresh_token grant; the rotated token is persisted 0600');
  else fail(`refresh = ${JSON.stringify({ jobs: jobs.length, grants, stored: { ...stored.tokens, expires_at: stored.expires_at }, mode: mode.toString(8) })}`);
  box.cleanup();
}

{
  const box = sandbox({ accessToken: 'access-revoked' });
  const c = clock();
  const srv = fakeServer({
    tools: pagedTools(),
    validTokens: ['access-new'],
    refresh: () => json({ access_token: 'access-new', token_type: 'Bearer', expires_in: 3600 }),
  });
  const jobs = await createJobsSearchProvider({ fetchFn: srv.fetchFn, now: c.now }).fetch(box.entry, c.ctx);
  const stored = JSON.parse(readFileSync(box.credentialsFile, 'utf-8'));
  if (jobs.length > 0 && stored.tokens.access_token === 'access-new' && stored.tokens.refresh_token === 'refresh-1') {
    pass('a 401 on a token dated as valid triggers one renewal; an unrotated refresh token is kept');
  } else fail(`401 renewal = ${JSON.stringify({ jobs: jobs.length, access: stored.tokens.access_token })}`);
  box.cleanup();
}

{
  const box = sandbox({ expiresInMs: -1, accessToken: 'access-secret-a', refreshToken: 'refresh-secret-b' });
  const c = clock();
  const srv = fakeServer({ tools: pagedTools(), refresh: () => json({ error: 'invalid_grant', error_description: 'refresh token already used' }, 400) });
  const err = await rejects(createJobsSearchProvider({ fetchFn: srv.fetchFn, now: c.now }).fetch(box.entry, c.ctx));
  if (
    err && /token renewal failed/.test(err.message) && /codex mcp login jobs-search/.test(err.message) &&
    !/secret/.test(err.message) && !srv.log.some((r) => r.url === ENDPOINT)
  ) pass('a rejected refresh names the re-login command, leaks no token, and never reaches the MCP server');
  else fail(`refresh failure = ${JSON.stringify({ err: err?.message, mcp: srv.log.filter((r) => r.url === ENDPOINT).length })}`);
  box.cleanup();
}

{
  const dir = mkdtempSync(join(tmpdir(), 'jobs-search-test-'));
  const srv = fakeServer({ tools: pagedTools() });
  const entry = { jobs_search: { credentials_file: join(dir, 'missing.json'), cache_dir: join(dir, 'cache') } };
  const err = await rejects(createJobsSearchProvider({ fetchFn: srv.fetchFn }).fetch(entry, { transport: 'http', sleep: async () => {} }));
  if (err && /seed-from-codex/.test(err.message) && srv.log.length === 0) pass('a missing credential file fails with the seed command before any request');
  else fail(`missing credentials = ${JSON.stringify({ err: err?.message, requests: srv.log.length })}`);

  writeFileSync(join(dir, 'codex.json'), JSON.stringify({ token_response: { refresh_token: 'r' }, expires_at: 1 }));
  const shape = await rejects(Promise.resolve().then(() => auth.loadCredentials(join(dir, 'codex.json'))));
  if (shape && /has no access_token/.test(shape.message)) pass('a credential without an access_token is rejected by field name');
  else fail(`credential shape = ${shape?.message}`);
  rmSync(dir, { recursive: true, force: true });
}
