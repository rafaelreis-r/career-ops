// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
/** @typedef {import('./_types.js').Job} Job */

// Jobs Search provider — jobs.bridglabs.com, a paid catalogue of jobs with
// confirmed Brazil hiring eligibility, read through its MCP server over
// Streamable HTTP (https://mcp.jobs.bridglabs.com/mcp) with the official
// @modelcontextprotocol/sdk client.
//
// Fork-local and authenticated, unlike the upstream providers: the source
// needs an OAuth bearer token (see providers/_jobs-search-auth.mjs for how the
// credential file is seeded from Codex and renewed without it).
//
// Wire in via a `job_boards:` entry — no detect(), only an explicit provider:
//
//   - name: Jobs Search (Brazil-eligible)
//     provider: jobs-search
//     jobs_search:
//       period: day          # day | week | month — jobs first seen in that window
//     enabled: true
//
// --- Design notes -----------------------------------------------------------
//
// Fetch. `get_new_jobs` (period by firstSeenAt, 20 per page, `nextCursor`
// until absent). `Job.url` is the employer's ATS link (`sourceUrl`, Source
// Indexing Policy rule 2); the Bridg page (`url`) is the fallback when it is
// absent or not https:. Company and title are the real employer's, so the
// scanner's company+role dedup meets the same role found through the
// employer's own ATS provider. All job text is third-party data.
//
// Quota. The account allows 10 queries/minute, 120/day and 3,000/month,
// shared by every connection; each get_new_jobs page is one query, get_usage
// is free. The catalogue is rebuilt once a day (`catalogVersion`
// "2026-09-28T03-00-27-460Z-daily", built ~03:10 UTC), and `period: day` is a
// rolling 24 h window on firstSeenAt. Several lanes scanning back to back must
// not each pay for the same pull, so a pull is cached per period in a cache
// directory and served to every later scan until it goes stale
// (`cache_ttl_minutes`). Tool calls are spaced CALL_INTERVAL_MS apart (the
// last call's time is kept in the cache directory, so a second lane starting
// right after the first still respects the per-minute window). `get_usage` is
// read before paging: get_new_jobs reports no total, so when fewer queries
// are left than the last pull's page count the run stops with a named error
// instead of burning the rest, and running out mid-pull caches nothing.
//
// Failures (auth, quota, network, a changed payload) throw, so scan.mjs
// records them as this board's error and carries on with the other targets.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sleep } from './_http.mjs';
import {
  DEFAULT_ENDPOINT,
  defaultCredentialsPath,
  getAccessToken,
  loadCredentials,
  refreshCredentials,
  resolveUserPath,
} from './_jobs-search-auth.mjs';

const ALLOWED_ENDPOINT_HOSTS = new Set(['mcp.jobs.bridglabs.com']);
const PERIODS = new Set(['day', 'week', 'month']);
const PAGE_SIZE = 20; // server maximum for get_new_jobs
// ~1,780 jobs in the whole catalogue on 2026-09-27 (89 pages); `day` is a
// small fraction of that. The default bounds a runaway cursor, the cap bounds
// a user override — neither comes from what the server reports.
const DEFAULT_MAX_PAGES = 30;
const MAX_PAGES_CAP = 150;
// 10 queries/minute: 7 s apart keeps any 60 s window at 9 calls or fewer.
const CALL_INTERVAL_MS = 7_000;
const DEFAULT_CACHE_TTL_MINUTES = 180;
const REQUEST_TIMEOUT_MS = 30_000;
const CACHE_VERSION = 1;

/** @param {unknown} url */
export function assertJobsSearchEndpoint(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`jobs-search: invalid endpoint URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`jobs-search: endpoint must use HTTPS: ${url}`);
  if (!ALLOWED_ENDPOINT_HOSTS.has(parsed.hostname)) {
    throw new Error(`jobs-search: untrusted endpoint host "${parsed.hostname}" — must be ${[...ALLOWED_ENDPOINT_HOSTS].join(', ')}`);
  }
  return parsed.href;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function defaultCacheDir(env = process.env) {
  const explicit = env.CAREER_OPS_JOBS_SEARCH_CACHE_DIR?.trim();
  if (explicit) return resolveUserPath(explicit);
  const cacheHome = env.XDG_CACHE_HOME?.trim() || path.join(homedir(), '.cache');
  return path.join(cacheHome, 'career-ops', 'jobs-search');
}

/** @param {unknown} v @param {number} fallback @param {number} cap */
function positiveInt(v, fallback, cap) {
  return Number.isInteger(v) && /** @type {number} */ (v) > 0 ? Math.min(/** @type {number} */ (v), cap) : fallback;
}

/**
 * Resolve the entry's `jobs_search:` block (all keys optional).
 * @param {any} entry
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveJobsSearchConfig(entry, env = process.env) {
  const cfg = entry?.jobs_search && typeof entry.jobs_search === 'object' ? entry.jobs_search : {};
  const period = cfg.period ?? 'day';
  if (!PERIODS.has(period)) throw new Error(`jobs-search: jobs_search.period must be day, week or month, got ${JSON.stringify(period)}`);
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  return {
    endpoint: assertJobsSearchEndpoint(str(cfg.endpoint) || DEFAULT_ENDPOINT),
    period,
    credentialsFile: str(cfg.credentials_file) ? resolveUserPath(str(cfg.credentials_file)) : defaultCredentialsPath(env),
    cacheDir: str(cfg.cache_dir) ? resolveUserPath(str(cfg.cache_dir)) : defaultCacheDir(env),
    maxPages: positiveInt(cfg.max_pages ?? entry?.max_pages, DEFAULT_MAX_PAGES, MAX_PAGES_CAP),
    cacheTtlMs: positiveInt(cfg.cache_ttl_minutes, DEFAULT_CACHE_TTL_MINUTES, 24 * 60) * 60_000,
  };
}

/** @param {unknown} value */
function toEpochMs(value) {
  if (!value || typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** @param {unknown} v */
function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {unknown} v */
function httpsUrl(v) {
  const s = text(v);
  if (!s) return '';
  try {
    return new URL(s).protocol === 'https:' ? s : '';
  } catch {
    return '';
  }
}

// `salary.interval` → annual multiplier (Job.salary is annualized). The live
// payload sends `year`; an interval not listed here drops the salary rather
// than guess its unit.
const INTERVAL_MULTIPLIERS = { hour: 2080, day: 260, week: 52, month: 12, year: 1 };

/**
 * `{currency, interval, minimum, maximum}` → annualized `{min, max, currency}`,
 * or null when neither bound is a positive number.
 * @param {any} j
 */
export function normalizeJobsSearchSalary(j) {
  const s = j?.salary && typeof j.salary === 'object' ? j.salary : null;
  if (!s) return null;
  const interval = text(s.interval).toLowerCase() || 'year';
  const multiplier = INTERVAL_MULTIPLIERS[/** @type {keyof typeof INTERVAL_MULTIPLIERS} */ (interval)];
  if (!multiplier) return null;
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * multiplier : undefined);
  const min = num(s.minimum);
  const max = num(s.maximum);
  if (min === undefined && max === undefined) return null;
  /** @type {{min?: number, max?: number, currency?: string}} */
  const salary = {};
  if (min !== undefined) salary.min = min;
  if (max !== undefined) salary.max = max;
  const currency = text(s.currency).toUpperCase();
  if (currency) salary.currency = currency;
  return salary;
}

/**
 * One `get_new_jobs` item → Job, or null when title/company/url is missing.
 * @param {any} j
 * @returns {Job | null}
 */
export function normalizeJobsSearchJob(j) {
  if (!j || typeof j !== 'object') return null;
  const title = text(j.title);
  const company = text(j.company);
  const url = httpsUrl(j.sourceUrl) || httpsUrl(j.url);
  if (!title || !company || !url) return null;
  const locations = Array.isArray(j.locations) ? j.locations.map(text).filter(Boolean) : [];
  /** @type {Job} */
  const job = { title, url, company, location: [...new Set(locations)].join(' / ') };
  const postedAt = toEpochMs(j.publishedAt);
  if (postedAt !== undefined) job.postedAt = postedAt;
  const salary = normalizeJobsSearchSalary(j);
  if (salary) job.salary = salary;
  return job;
}

/**
 * The JSON payload of a tool result: `structuredContent` when present, else
 * the first text block parsed as JSON. A tool-level error throws with the
 * server's message.
 * @param {string} tool
 * @param {any} result
 */
export function toolPayload(tool, result) {
  const first = Array.isArray(result?.content) ? result.content.find((/** @type {any} */ c) => c?.type === 'text') : null;
  if (result?.isError) {
    throw new Error(`jobs-search: ${tool} failed: ${text(first?.text).slice(0, 300) || 'no message'}`);
  }
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  if (first && typeof first.text === 'string') {
    try {
      return JSON.parse(first.text);
    } catch {
      throw new Error(`jobs-search: ${tool} returned non-JSON text`);
    }
  }
  throw new Error(`jobs-search: ${tool} returned no content`);
}

/**
 * `get_usage` → queries left in the tightest of the day/month windows, plus
 * the per-minute headroom and when that minute resets. Live shape:
 * `{ usage: { queryMinute, queryDay, queryMonth, limits: {minute, day, month},
 * resets: {minute, day, month} } }`. `get_usage` itself is not a query (the
 * counters did not move for it on 2026-09-28).
 * @param {any} payload
 */
export function parseUsage(payload) {
  const u = payload?.usage;
  const limits = u?.limits;
  /** @param {string} used @param {string} limit */
  const left = (used, limit) => {
    const n = Number(limits?.[limit]) - Number(u?.[used]);
    return Number.isFinite(n) ? Math.max(0, n) : NaN;
  };
  const day = left('queryDay', 'day');
  const month = left('queryMonth', 'month');
  const minute = left('queryMinute', 'minute');
  if (!u || typeof u !== 'object' || [day, month, minute].some(Number.isNaN)) {
    throw new Error(`jobs-search: get_usage returned an unexpected shape — keys: [${payload && typeof payload === 'object' ? Object.keys(payload).join(', ') : typeof payload}]`);
  }
  return {
    remaining: Math.min(day, month),
    window: day <= month ? 'day' : 'month',
    minuteLeft: minute,
    minuteResetAt: toEpochMs(u.resets?.minute),
  };
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/** @param {string} file @param {unknown} value */
function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * @typedef {object} ProviderDeps
 * @property {typeof fetch} [fetchFn]  Transport for the MCP server and the token endpoint.
 * @property {() => number} [now]
 */

/** @param {typeof fetch} base */
function guardedFetch(base) {
  /** @type {typeof fetch} */
  const f = (input, init = {}) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, redirect: 'error', signal });
  };
  return f;
}

/**
 * @param {ProviderDeps} [deps]
 * @returns {Provider}
 */
export function createJobsSearchProvider(deps = {}) {
  const now = deps.now ?? Date.now;
  const baseFetch = guardedFetch(deps.fetchFn ?? globalThis.fetch);

  return {
    id: 'jobs-search',

    async fetch(entry, ctx) {
      const cfg = resolveJobsSearchConfig(entry);
      const probe = Number(ctx?.maxPages) > 0;
      const pageLimit = probe ? Math.min(cfg.maxPages, Number(ctx.maxPages)) : cfg.maxPages;
      const cacheFile = path.join(cfg.cacheDir, `new-jobs-${cfg.period}.json`);
      const throttleFile = path.join(cfg.cacheDir, 'last-call.json');

      const cached = readJson(cacheFile);
      if (
        cached?.version === CACHE_VERSION &&
        cached.endpoint === cfg.endpoint &&
        Array.isArray(cached.items) &&
        typeof cached.fetchedAt === 'number' &&
        now() - cached.fetchedAt < cfg.cacheTtlMs
      ) {
        return cached.items.map(normalizeJobsSearchJob).filter(Boolean);
      }

      const authDeps = { fetchFn: baseFetch, now, endpoint: cfg.endpoint };
      let lastCallAt = Number(readJson(throttleFile)?.at) || 0;
      /** @type {Client | null} */
      let client = null;

      const connect = async (/** @type {string} */ token) => {
        const c = new Client({ name: 'career-ops-jobs-search', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(cfg.endpoint), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
          fetch: baseFetch,
        });
        await c.connect(transport);
        return c;
      };

      const call = async (/** @type {string} */ name, /** @type {Record<string, unknown>} */ args) => {
        const wait = lastCallAt + CALL_INTERVAL_MS - now();
        if (wait > 0) await sleep(wait, ctx);
        lastCallAt = now();
        try {
          writeJsonAtomic(throttleFile, { at: lastCallAt });
        } catch {
          // Pacing still holds within this run; only cross-lane pacing is lost.
        }
        return toolPayload(name, await /** @type {Client} */ (client).callTool({ name, arguments: args }));
      };

      try {
        try {
          client = await connect(await getAccessToken(cfg.credentialsFile, authDeps));
        } catch (err) {
          // A token the file still dates as valid can be revoked early; renew once.
          if (!(err instanceof StreamableHTTPError && err.code === 401)) throw err;
          const { cred } = await refreshCredentials(cfg.credentialsFile, loadCredentials(cfg.credentialsFile), authDeps);
          client = await connect(cred.tokens.access_token);
        }

        const usage = parseUsage(await call('get_usage', {}));
        // get_new_jobs reports no total, so the size of the last complete pull
        // for this period (kept past the TTL) is the estimate of what this one
        // needs; a first run assumes one page.
        const estimate = Math.min(pageLimit, Math.max(1, Number.isInteger(cached?.pages) ? cached.pages : 1));
        if (usage.remaining < estimate) {
          throw new Error(`jobs-search: ${usage.remaining} queries left this ${usage.window}, the pull needs about ${estimate} (${Number.isInteger(cached?.pages) ? "the last pull's page count" : 'at least one page'}) — skipped it rather than stop halfway`);
        }
        if (usage.minuteLeft < 1 && usage.minuteResetAt !== undefined) {
          const wait = Math.min(usage.minuteResetAt - now(), 61_000);
          if (wait > 0) await sleep(wait, ctx);
        }
        let remaining = usage.remaining;

        /** @type {any[]} */
        const items = [];
        const seen = new Set();
        /** @type {string | undefined} */
        let cursor;
        let catalogVersion = '';
        let pages = 0;
        let truncated = false;
        for (;;) {
          if (remaining < 1) {
            throw new Error(`jobs-search: query allowance ran out after ${pages} page(s) of get_new_jobs (${usage.window} limit) — pull incomplete, nothing cached`);
          }
          const page = await call('get_new_jobs', { period: cfg.period, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
          remaining--;
          pages++;
          if (!page || typeof page !== 'object' || !Array.isArray(page.jobs)) {
            throw new Error(`jobs-search: get_new_jobs returned an unexpected shape — keys: [${page && typeof page === 'object' ? Object.keys(page).join(', ') : typeof page}]`);
          }
          if (!catalogVersion) catalogVersion = text(page.catalogVersion);
          for (const item of page.jobs) {
            const key = item?.id ?? item?.sourceUrl ?? item?.url;
            if (key != null && seen.has(key)) continue;
            if (key != null) seen.add(key);
            items.push(item);
          }
          cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
          if (!cursor) break;
          if (pages >= pageLimit) {
            truncated = true;
            break;
          }
        }

        if (!probe) {
          if (truncated) console.warn(`jobs-search: stopped at ${pageLimit} pages with more available — raise jobs_search.max_pages on this entry`);
          // A truncated pull is cached too: every lane would hit the same cap.
          writeJsonAtomic(cacheFile, { version: CACHE_VERSION, endpoint: cfg.endpoint, period: cfg.period, catalogVersion, fetchedAt: now(), pages, truncated, items });
        }
        return items.map(normalizeJobsSearchJob).filter(Boolean);
      } finally {
        await client?.close().catch(() => {});
      }
    },
  };
}

/** @type {Provider} */
export default createJobsSearchProvider();
