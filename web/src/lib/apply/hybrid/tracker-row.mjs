// tracker-row.mjs — which postings may enter the round, read from the trackers.
//
// Never entered: a posting whose own tracker row is already sent (2026-09-22:
// three postings the captain had submitted were queued for a new round), a
// company on the do-not-apply list (data/blacklist.md), and a company whose
// recorded submission limit is used up across ALL tracks (2026-09-22: Camunda
// refused a track-A submission, "We limit submissions to 2 per person within
// a 30-day period"; the two counted were track B's 1068 and 1087, which a
// track-A run cannot see in its own tracker).
//
// Tracks come from the shared registry `trilhas.yml`; limits from
// `data/submission-limits.tsv` beside the shared `data/blacklist.md`. The
// shared directory is $CAREER_OPS_SHARED_DIR, or ~/dev/career-ops-shared
// (docs/FORK.md). Without a registry only the current track is read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { resolveTrackerPath } from '../../../../../path-resolver.mjs';
import { extractTrackerReportNumbers, isHeaderRow, isSeparatorRow, parseTrackerRow, resolveColumns } from '../../../../../tracker-parse.mjs';
import { loadCanonicalStates, normalizeCompany, resolveCanonicalState } from '../../../../../tracker-utils.mjs';
import { parseBlacklist } from '../../../../../scan.mjs';

const FORK_STATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../templates/states.yml');

/** Canonical states that mean the application was already sent. */
export const SENT_STATES = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Hired']);

const statesFor = (root) => {
  const own = path.join(root, 'templates', 'states.yml');
  return loadCanonicalStates(fs.existsSync(own) ? own : FORK_STATES);
};

function trackerRows(root) {
  const tracker = resolveTrackerPath(root);
  if (!fs.existsSync(tracker)) return { tracker, rows: [] };
  const lines = fs.readFileSync(tracker, 'utf8').split('\n');
  const colmap = resolveColumns(lines);
  const states = statesFor(root);
  const rows = [];
  for (const line of lines) {
    if (isHeaderRow(line) || isSeparatorRow(line)) continue;
    const row = parseTrackerRow(line, colmap);
    if (row) rows.push({ ...row, canonical: resolveCanonicalState(row.status, states), reports: extractTrackerReportNumbers(row.report, row.notes) });
  }
  return { tracker, rows };
}

/**
 * The tracker row of this report, and whether its status says the application
 * was already sent. A report with no tracker row is not blocked.
 *
 * @returns {{row: number|null, company: string|null, status: string|null, canonical: string|null, sent: boolean, tracker: string}}
 */
export function trackerStanding(root, reportNumber) {
  const { tracker, rows } = trackerRows(root);
  const num = Number(reportNumber);
  const hit = Number.isInteger(num) && num > 0 ? rows.find((r) => r.reports.includes(num)) : null;
  if (!hit) return { row: null, company: null, status: null, canonical: null, sent: false, tracker };
  return { row: hit.num, company: hit.company, status: hit.status, canonical: hit.canonical, sent: SENT_STATES.has(hit.canonical), tracker };
}

/** The shared directory (registry, shared data), or null when absent. */
export function sharedDir() {
  const dir = process.env.CAREER_OPS_SHARED_DIR?.trim() || path.join(os.homedir(), 'dev', 'career-ops-shared');
  return fs.existsSync(dir) ? dir : null;
}

/** Every track root the registry lists, plus `root`; each once. */
export function trackRoots(root, shared = sharedDir()) {
  const roots = [path.resolve(root)];
  const registry = shared && path.join(shared, 'trilhas.yml');
  if (registry && fs.existsSync(registry)) {
    const doc = yaml.load(fs.readFileSync(registry, 'utf8'));
    for (const t of doc?.trilhas || []) {
      if (t?.dir) roots.push(path.resolve(String(t.dir).replace(/^~(?=$|\/)/, os.homedir())));
    }
  }
  const seen = new Set();
  return roots.filter((r) => {
    const real = fs.existsSync(r) ? fs.realpathSync(r) : r;
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/** `data/submission-limits.tsv`: company, max_submissions, window_days, ... (header row, tab-separated). */
export function parseSubmissionLimits(text) {
  const limits = new Map();
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const [company, max, days] = line.split('\t').map((s) => s.trim());
    if (!company || company.startsWith('#') || /^company$/i.test(company)) continue;
    const m = Number(max);
    const d = Number(days);
    if (Number.isInteger(m) && m > 0 && Number.isInteger(d) && d > 0) limits.set(normalizeCompany(company), { company, max: m, days: d });
  }
  return limits;
}

/** Date a row's application was sent: its first status-log transition into a
 *  sent state, else the tracker's date column. */
function sentDate(root, tracker, row) {
  const log = path.join(path.dirname(tracker), 'status-log.tsv');
  if (fs.existsSync(log)) {
    const states = statesFor(root);
    for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
      const [num, date, , to] = line.split('\t');
      if (Number(num) === row.num && /^\d{4}-\d{2}-\d{2}$/.test(date || '') && SENT_STATES.has(resolveCanonicalState(to, states))) return { date, source: 'status-log' };
    }
  }
  return { date: row.date, source: 'tracker date' };
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * May this posting enter the round? Checks its own tracker row, the
 * blacklist, and the company's submission limit across every track.
 *
 * @param {{root: string, reportNumber?: string|number|null, company?: string|null, today?: string, shared?: string|null}} opts
 * @returns {{eligible: boolean, reasons: string[], standing: object, company: string|null, limit: object|null}}
 */
export function postingEligibility({ root, reportNumber = null, company = null, today = new Date().toISOString().slice(0, 10), shared = sharedDir() }) {
  const standing = trackerStanding(root, reportNumber);
  const name = standing.company || company;
  const key = name ? normalizeCompany(name) : '';
  const reasons = [];
  if (standing.sent) reasons.push(`tracker row ${standing.row} is "${standing.status}" (${standing.canonical}): the application was already sent`);

  const blacklistFile = [path.join(root, 'data', 'blacklist.md'), shared && path.join(shared, 'data', 'blacklist.md')].find((f) => f && fs.existsSync(f));
  const listed = key && blacklistFile ? parseBlacklist(fs.readFileSync(blacklistFile, 'utf8')).get(key) : null;
  if (listed) reasons.push(`${listed.company} is on the blacklist (since ${listed.since || '?'}): ${listed.reason || 'no reason recorded'}`);

  let limit = null;
  const limitsFile = [shared && path.join(shared, 'data', 'submission-limits.tsv'), path.join(root, 'data', 'submission-limits.tsv')].find((f) => f && fs.existsSync(f));
  const rule = key && limitsFile ? parseSubmissionLimits(fs.readFileSync(limitsFile, 'utf8')).get(key) : null;
  if (rule) {
    const since = addDays(today, -rule.days);
    const submissions = [];
    for (const r of trackRoots(root, shared)) {
      const { tracker, rows } = trackerRows(r);
      for (const row of rows) {
        if (normalizeCompany(row.company) !== key || !SENT_STATES.has(row.canonical)) continue;
        const sent = sentDate(r, tracker, row);
        if (sent.date > since) submissions.push({ track: r, row: row.num, role: row.role, date: sent.date, dateSource: sent.source });
      }
    }
    submissions.sort((a, b) => a.date.localeCompare(b.date));
    const reached = submissions.length >= rule.max;
    // The window reopens the day the oldest counted submission falls out of it.
    const reopensOn = reached ? addDays(submissions[submissions.length - rule.max].date, rule.days) : null;
    limit = { ...rule, count: submissions.length, submissions, reached, reopensOn };
    if (reached) reasons.push(`${rule.company} allows ${rule.max} submissions per ${rule.days} days and ${submissions.length} were sent since ${since} (${submissions.map((s) => `#${s.row} on ${s.date}`).join(', ')}); the window reopens on ${reopensOn}`);
  }
  return { eligible: reasons.length === 0, reasons, standing, company: name, limit };
}
