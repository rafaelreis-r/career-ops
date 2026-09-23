// tracker-row.mjs — a posting the tracker marks as already applied never enters
// the round. On 2026-09-22 three postings the captain had already submitted
// (tracker status Applied, confirmed by e-mail) were queued for a new round.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTrackerPath } from '../../../../../path-resolver.mjs';
import { extractTrackerReportNumbers, isHeaderRow, isSeparatorRow, parseTrackerRow, resolveColumns } from '../../../../../tracker-parse.mjs';
import { loadCanonicalStates, resolveCanonicalState } from '../../../../../tracker-utils.mjs';

const FORK_STATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../templates/states.yml');

/** Canonical states that mean the application was already sent. */
export const SENT_STATES = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Hired']);

/**
 * The tracker row of this report, and whether its status says the application
 * was already sent. A report with no tracker row is not blocked.
 *
 * @returns {{row: number|null, status: string|null, canonical: string|null, sent: boolean, tracker: string}}
 */
export function trackerStanding(root, reportNumber) {
  const tracker = resolveTrackerPath(root);
  const none = { row: null, status: null, canonical: null, sent: false, tracker };
  const num = Number(reportNumber);
  if (!Number.isInteger(num) || num <= 0 || !fs.existsSync(tracker)) return none;
  const lines = fs.readFileSync(tracker, 'utf8').split('\n');
  const colmap = resolveColumns(lines);
  const own = path.join(root, 'templates', 'states.yml');
  const states = loadCanonicalStates(fs.existsSync(own) ? own : FORK_STATES);
  for (const line of lines) {
    if (isHeaderRow(line) || isSeparatorRow(line)) continue;
    const row = parseTrackerRow(line, colmap);
    if (!row || !extractTrackerReportNumbers(row.report, row.notes).includes(num)) continue;
    const canonical = resolveCanonicalState(row.status, states);
    return { row: row.num, status: row.status, canonical, sent: SENT_STATES.has(canonical), tracker };
  }
  return none;
}
