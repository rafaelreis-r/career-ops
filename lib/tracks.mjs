// tracks.mjs — the installs (tracks) that share one job search, and their trackers.
//
// One person can run several installs of this code, one per career track, each
// with its own data/applications.md. Tools that must see every track (the
// submission limit of apply-hybrid, the e-mail reconciliation) read the list
// from the shared registry `trilhas.yml`:
//
//   trilhas:
//     - id: A
//       dir: ~/dev/career-ops
//
// The shared directory is $CAREER_OPS_SHARED_DIR, or ~/dev/career-ops-shared
// (docs/FORK.md). Without a registry only the current install is read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { resolveTrackerPath } from '../path-resolver.mjs';
import { canonicalStatesFromDocument, extractTrackerReportNumbers, isHeaderRow, isSeparatorRow, parseTrackerRow, resolveCanonicalState, resolveColumns } from '../tracker-parse.mjs';

const FORK_STATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates/states.yml');

/** Canonical states of an install: its own templates/states.yml, else this checkout's. */
export function statesFor(root) {
  const own = path.join(root, 'templates', 'states.yml');
  const statesPath = fs.existsSync(own) ? own : FORK_STATES;
  return canonicalStatesFromDocument(yaml.load(fs.readFileSync(statesPath, 'utf8')), statesPath);
}

/**
 * Data rows of an install's tracker, each with its canonical state label and
 * the report numbers it links. A missing tracker reads as no rows.
 *
 * @returns {{tracker: string, rows: object[]}}
 */
export function readTrackerRows(root) {
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

/** The shared directory (registry, shared data), or null when absent. */
export function sharedDir() {
  const dir = process.env.CAREER_OPS_SHARED_DIR?.trim() || path.join(os.homedir(), 'dev', 'career-ops-shared');
  return fs.existsSync(dir) ? dir : null;
}

const realOf = (dir) => (fs.existsSync(dir) ? fs.realpathSync(dir) : dir);

/**
 * `root` first, then every track the registry lists; each install once. A
 * track keeps its registry id; `root` outside the registry is `local`.
 *
 * @returns {{id: string, root: string}[]}
 */
export function trackList(root, shared = sharedDir()) {
  const registered = [];
  const registry = shared && path.join(shared, 'trilhas.yml');
  if (registry && fs.existsSync(registry)) {
    const doc = yaml.load(fs.readFileSync(registry, 'utf8'));
    for (const t of doc?.trilhas || []) {
      if (t?.dir) registered.push({ id: String(t.id ?? t.dir), root: path.resolve(String(t.dir).replace(/^~(?=$|\/)/, os.homedir())) });
    }
  }
  const self = path.resolve(root);
  const selfEntry = registered.find((t) => realOf(t.root) === realOf(self));
  const seen = new Set();
  return [{ id: selfEntry?.id ?? 'local', root: self }, ...registered].filter((t) => {
    const real = realOf(t.root);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/** Every track root the registry lists, plus `root`; each once. */
export function trackRoots(root, shared = sharedDir()) {
  return trackList(root, shared).map((t) => t.root);
}
