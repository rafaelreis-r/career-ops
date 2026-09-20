/**
 * apply-route.mjs — the deterministic fork/route decision for one job
 * application, decided BEFORE anything is opened.
 *
 * The captain's direction is "LLM owning, Jev helping". Two apply paths exist:
 *
 *   - 'fast' — the existing Jev-root browser driver
 *     (web/scripts/arm1-jev-agentbrowser.mjs). Cheap and fully autonomous, but
 *     it only fills plain HTML forms; it fails on React SPA forms, dropdown-heavy
 *     ATS forms and LinkedIn.
 *   - 'llm'  — an LLM owns the real logged-in browser and calls the typed Jev
 *     helpers (lib/jev-apply-helpers.mjs) per decision. Unbounded, expensive,
 *     handles everything the fast path cannot.
 *
 * The route MUST be a pure function of the job URL and a static allowlist,
 * decided once, up front, with NO probing and NO switching mid-application. A
 * host on the list takes the fast path; every other host takes the LLM path. A
 * fast-path failure never falls back to the LLM path in the moment — it reports
 * blocked and stops, and the correction is to REMOVE that host from the list.
 *
 * FAST_HOSTS entry rule: a host enters this list ONLY after a complete fill
 * plus a real submit has been proven on that ATS.
 * FAST_HOSTS exit rule: ANY fast-path failure on a host removes it from this
 * list — the fix is always here, never a runtime fallback to the LLM path.
 *
 * Initial list: only applytojob.com (the one ATS proven end-to-end,
 * applytojob 12/12 fields).
 */

/** @type {string[]} Registrable hosts proven end-to-end on the fast path. See the entry/exit rules above before editing. */
export const FAST_HOSTS = ['applytojob.com'];

/**
 * Lowercased hostname of a URL, or null when it cannot be parsed. Path, query
 * and fragment are irrelevant to the route by construction — only the host
 * decides.
 *
 * @param {string} url
 * @returns {string|null}
 */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Does `host` match `fastHost` as a registrable host, including subdomains?
 * `applytojob.com` matches `applytojob.com` and `careers.applytojob.com`, but
 * never `notapplytojob.com` (the dot boundary prevents the suffix trick).
 *
 * @param {string} host - Already lowercased.
 * @param {string} fastHost - Already lowercased allowlist entry.
 * @returns {boolean}
 */
function matchesFastHost(host, fastHost) {
  return host === fastHost || host.endsWith(`.${fastHost}`);
}

/**
 * Route one application URL. Pure: same URL always yields the same route, with
 * no I/O and no browser. Anything not on FAST_HOSTS — including an unparseable
 * URL — takes the LLM-owned path, the safe default.
 *
 * @param {string} url - The job application URL.
 * @param {string[]} [fastHosts] - Injection seam for tests; defaults to FAST_HOSTS.
 * @returns {'fast'|'llm'}
 */
export function applyRoute(url, fastHosts = FAST_HOSTS) {
  const host = hostOf(url);
  if (host === null) return 'llm';
  for (const fastHost of fastHosts) {
    if (matchesFastHost(host, fastHost.toLowerCase())) return 'fast';
  }
  return 'llm';
}
