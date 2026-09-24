// tests/gmail-digest-dedupe.test.mjs — one LinkedIn posting is one pipeline row.
//
// Measured on 2026-09-21: of 200 unranked rows in one install, 148 were
// `linkedin.com/comm/jobs/view/<id>?trackingId=…&trk=…` links from the LinkedIn
// alert digest, the same id repeated 4.8 times on average (31 real postings),
// plus 18 beehiiv newsletter redirects with no posting behind them. The digest
// links each card several times (title, logo, body), each with its own tracking
// params, and ingestion wrote every spelling as a new row.
//
// Pinned here: ingestion writes the canonical /jobs/view/<id> once, the dedupe
// key treats every spelling of the id as the same posting (so a job already in
// the queue, scan history or tracker is not written again), and an opaque
// newsletter redirect is never written at all.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\ngmail digest — one LinkedIn posting, one row');

const check = (label, cond) => (cond ? pass(label) : fail(label));
const ID = '4460239794';
const CANONICAL = `https://www.linkedin.com/jobs/view/${ID}`;
const digestLink = (trk) => `https://www.linkedin.com/comm/jobs/view/${ID}/?trackingId=laJEKudJIOwdpLWZinjWug%3D%3D&refId=RrbYrkNvtyeqch8a%2BfOWkA%3D%3D&lipi=urn%3Ali%3Apage%3Aemail_email_job_alert_digest_01&midToken=AQFWT-OWlzgiXg&trk=eml-email_job_alert_digest_01-primary_job_list-0-${trk}_jobid_${ID}`;
const BEEHIIV = 'https://link.mail.beehiiv.com/v2/c/8fb149e9f36ccba7fab60b0eb65a5954af8b19f2220270c1faf0a3b5c0c409d2/e2d94cd11fbdbb45';

try {
  const { linkedInJobId, canonicalLinkedInJobUrl } = await import(pathToFileURL(join(ROOT, 'url-key.mjs')).href);
  const { isCleanUrl } = await import(pathToFileURL(join(ROOT, 'plugins', 'gmail', '_helpers.mjs')).href);
  const { normalizeUrlForDedup, collectSeenUrls } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  const { default: gmail } = await import(pathToFileURL(join(ROOT, 'plugins', 'gmail', 'index.mjs')).href);

  // ── the id is the identity ──
  check('a digest /comm/ tracking link resolves to its job id', linkedInJobId(digestLink('jobcard_body_text_0')) === ID);
  check('a regional host with a title slug resolves to the same id',
    linkedInJobId(`https://br.linkedin.com/jobs/view/staff-sre-at-pismo-${ID}?trk=public_jobs_topcard-title`) === ID);
  check('a ?currentJobId= search page resolves to the posting',
    linkedInJobId(`https://www.linkedin.com/jobs/search/?currentJobId=${ID}&keywords=sre`) === ID);
  check('a LinkedIn page that is not a posting has no id',
    linkedInJobId('https://www.linkedin.com/comm/jobs/search-results/?keywords=sre') === null);
  check('a non-LinkedIn host has no id, even with the same path',
    linkedInJobId(`https://evil-linkedin.com/jobs/view/${ID}`) === null);
  check('the canonical URL is www.linkedin.com/jobs/view/<id>', canonicalLinkedInJobUrl(digestLink('company_logo_0')) === CANONICAL);
  check('the dedupe key collapses every spelling of the id',
    new Set([digestLink('jobcard_body_text_0'), digestLink('company_logo_0'), `${CANONICAL}/`,
      `https://br.linkedin.com/jobs/view/sre-${ID}`].map(normalizeUrlForDedup)).size === 1);

  // ── a known job is not new, wherever it is known from ──
  const known = (sources) => collectSeenUrls(sources).seen.has(normalizeUrlForDedup(CANONICAL));
  check('a job queued under its tracking URL is seen', known({ pipelineText: `- [ ] ${digestLink('jobcard_body_text_1')} |  | Job lead (email)\n` }));
  check('a job in the scan history is seen',
    known({ scanHistoryText: `url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n${CANONICAL}?trk=x\t2026-09-20\tlinkedin\tSRE\tPismo\tadded\n` }));
  check('a job linked from the tracker is seen',
    known({ applicationsText: `| 1 | 2026-09-23 | Pismo | SRE | 3.7/5 | Evaluated | ✅ | — | https://br.linkedin.com/jobs/view/staff-sre-at-pismo-${ID} |\n` }));

  // ── newsletter redirects carry no posting ──
  check('a beehiiv click redirect is not a lead', !isCleanUrl(BEEHIIV));
  check('the digest tracking link itself is still a lead', isCleanUrl(digestLink('jobcard_body_text_0')));

  // ── ingestion end to end ──
  const html = [
    digestLink('jobcard_body_text_0'), digestLink('company_logo_0'), digestLink('job_posting_0'),
    BEEHIIV, 'https://boards.greenhouse.io/acme/jobs/4384681009',
  ].map(u => `<a href="${u.replace(/&/g, '&amp;')}">x</a>`).join('\n');
  const ctx = {
    dryRun: true,
    env: { GMAIL_CLIENT_ID: 'x', GMAIL_CLIENT_SECRET: 'y', GMAIL_REFRESH_TOKEN: 'z' },
    settings: {},
    log: () => {},
    fetch: async (url) => {
      if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 't' }) };
      if (url.includes('messages?')) return { ok: true, json: async () => ({ messages: [{ id: 'digest-1' }] }) };
      return {
        ok: true,
        json: async () => ({
          payload: {
            headers: [
              { name: 'From', value: 'jobalerts-noreply@linkedin.com' },
              { name: 'Subject', value: 'Site Reliability Engineer at Pismo' },
              { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass' },
            ],
            body: { data: Buffer.from(html).toString('base64url') },
          },
        }),
      };
    },
  };
  const jobs = await gmail.ingest(ctx);
  const urls = jobs.map(j => j.url);
  check('three links to one posting become one canonical row', urls.filter(u => u.includes('linkedin')).join() === CANONICAL);
  check('the newsletter redirect is not written', !urls.some(u => u.includes('beehiiv')));
  check('a non-LinkedIn posting passes through unchanged', urls.includes('https://boards.greenhouse.io/acme/jobs/4384681009'));
  check('nothing else is written', jobs.length === 2);
} catch (err) {
  fail(`gmail digest dedupe suite threw: ${err?.stack ?? err}`);
}
