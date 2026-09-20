// @ts-check
// Pure, side-effect-free Gmail helpers. Ported from the gmail-helpers
// contributed by @SparshGarg999 in #1203 (with thanks). Files prefixed with _
// are never discovered as plugins.
//
// Local deviation from the upstream port (security/compat fix): isCleanUrl below
// filters LinkedIn CDN hosts and notification-only routes, and stops the keyword
// scan from discarding real job URLs whose query string carries tracking params.

/**
 * Extract all http/https URLs from a string (plain text or HTML). Normalizes
 * &amp; and strips trailing punctuation. Dedups.
 * @param {string} body
 * @returns {string[]}
 */
export function extractUrls(body) {
  if (!body) return [];
  const urls = [];
  const regex = /https?:\/\/[^\s"'<>\(\)]+/gi;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const url = match[0].replace(/[.,;:!?]+$/, '').replace(/&amp;/g, '&');
    urls.push(url);
  }
  return [...new Set(urls)];
}

/** LinkedIn's CDN: images, JS, tracking pixels — never a job posting. */
const LICDN_HOST = /(^|\.)licdn\.com$/;

/** Static-asset hosts that only ever serve logos and pixels, never a posting. */
const ASSET_HOSTS = [/(^|\.)cloudinary\.com$/, /\.blob\.core\.windows\.net$/, /(^|\.)cloudfront\.net$/];
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;

/**
 * LinkedIn routes that only ever carry navigation or telemetry, never a posting.
 * Matched as path prefixes so a query string cannot smuggle one past the gate.
 */
const LINKEDIN_NAV_ROUTES = [
  '/feed/', '/messaging/', '/mynetwork/', '/notifications/',
  '/emimp/', '/widgets/', '/jobs/alerts', '/jobs/search-results', '/jobs/jam/',
];

/** Canonical posting route, e.g. /jobs/view/4123456789. Regional hosts included. */
const LINKEDIN_JOB_ROUTE = /^\/jobs\/view\/[^/]+/;

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isLinkedInHost(hostname) {
  return hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com');
}

/**
 * Is a URL clean and relevant (not a click tracker, unsubscribe link, or pixel)?
 * @param {string} url
 * @returns {boolean}
 */
export function isCleanUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const hostname = u.hostname.toLowerCase();

    if (LICDN_HOST.test(hostname)) return false;
    if (ASSET_HOSTS.some(re => re.test(hostname)) || IMAGE_EXT.test(u.pathname)) return false;

    if (isLinkedInHost(hostname)) {
      let path = u.pathname.toLowerCase();
      // Notification mail mirrors every link under /comm/<real path>; the prefix
      // itself holds no posting, so judge the route underneath it.
      if (path === '/comm' || path === '/comm/') return false;
      if (path.startsWith('/comm/')) path = path.slice('/comm'.length);
      if (LINKEDIN_NAV_ROUTES.some(route => path.startsWith(route))) return false;
      // A real posting is exempt from the keyword scan below: digest links carry
      // trackingId/refId query params that would otherwise match 'track'.
      if (LINKEDIN_JOB_ROUTE.test(path)) return true;
    }

    const lowerUrl = url.toLowerCase();
    const badKeywords = [
      'click', 'track', 'openpixel', 'sendgrid', 'unsubscribe', 'optout',
      'newsletter', 'subscribe', 'w3.org', 'doubleclick', 'googlesyndication',
      'googleadservices', 'mailgun', 'mandrill', 'mjml', 'github.com/login',
      'linkedin.com/legal', 'linkedin.com/help', 'linkedin.com/settings',
    ];
    if (badKeywords.some(kw => lowerUrl.includes(kw))) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Anti-spoof gate, fail-closed. Trusted when Authentication-Results reports
 * dmarc=pass, or — when Gmail records no DMARC verdict at all, as happens for
 * senders whose policy is p=none — when a dkim=pass signing domain aligns with
 * the From: domain (DMARC's own relaxed alignment rule, applied by hand).
 * @param {Array<{ name: string, value: string }>} headers
 * @returns {boolean}
 */
export function isAuthenticEmail(headers) {
  if (!Array.isArray(headers)) return false;
  const header = (name) => headers
    .filter(h => h.name?.toLowerCase() === name)
    .map(h => h.value || '')
    .join('; ');
  const auth = header('authentication-results');
  if (!auth) return false;
  if (/dmarc=pass/i.test(auth)) return true;
  if (/dmarc=/i.test(auth)) return false;

  const fromDomain = header('from').match(/@([a-z0-9.-]+)/i)?.[1]?.toLowerCase();
  if (!fromDomain) return false;
  const aligned = (d) => d === fromDomain || fromDomain.endsWith(`.${d}`);
  for (const m of auth.matchAll(/dkim=pass[^;]*?header\.(?:i=@|d=)([a-z0-9.-]+)/gi)) {
    if (aligned(m[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * Parse "{Role} at {Company}" from a subject line.
 * @param {string} subject
 * @returns {{ role: string, company: string } | null}
 */
export function parseRoleAtCompany(subject) {
  if (!subject) return null;
  let clean = subject.replace(/^(re|fwd|new match|job alert|alert|match|notification|alert for|daily alert for):\s*/i, '').trim();
  clean = clean.split(/\s+[-|]\s+/)[0].trim();
  const match = clean.match(/^(.+?)\s+at\s+(.+)$/i);
  if (match) {
    const role = match[1].trim();
    const company = match[2].trim();
    if (role && company && role.length < 100 && company.length < 100) {
      return { role, company };
    }
  }
  return null;
}

/**
 * Recursively decode a Gmail message payload's base64url body parts to text.
 * @param {any} payload
 * @returns {string}
 */
export function getMessageBody(payload) {
  if (!payload) return '';
  let body = '';
  if (payload.body && payload.body.data) {
    const base64 = payload.body.data.replace(/-/g, '+').replace(/_/g, '/');
    body += Buffer.from(base64, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) body += getMessageBody(part);
  }
  return body;
}

/**
 * Best-effort company name from a known ATS URL (greenhouse/lever slug).
 * @param {string} url
 * @returns {string}
 */
export function companyFromUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname === 'boards.greenhouse.io' || hostname.endsWith('.greenhouse.io') ||
        hostname === 'jobs.lever.co' || hostname.endsWith('.lever.co')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length > 0) return parts[0];
    }
  } catch { /* malformed → no company */ }
  return '';
}
