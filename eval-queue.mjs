#!/usr/bin/env node
/**
 * eval-queue.mjs — build the long A-G evaluation queue from `data/pipeline.md`
 * through the cal-v1 forwarding gate.
 *
 * `rank-pipeline.mjs` only annotates: it never drops, reorders, or hides a row.
 * The decision of what goes on to the expensive evaluation lives here, in the
 * command that builds the queue. Every pending (`- [ ]`) row ends up in one of
 * two lists, each with its reason:
 *
 *   forwarded  `rank: cal-v1 {score}/5` at or above the cutoff, or named by
 *              --force (which overrides the cutoff for a ranked posting).
 *   held       already evaluated (URL in a report's `**URL:**` header or in the
 *              tracker), already queued in batch-input.tsv, a duplicate of an
 *              equivalent pending row with an equal or higher rank, no cal-v1
 *              rank yet (waits for the daily rank run), or ranked below the
 *              cutoff.
 *
 * URLs compare on `normalizeUrlForDedup`, the scanners' key, so a LinkedIn
 * posting matches on its job id whatever tracking URL it arrived under.
 *
 * The cutoff is `rank_forward_threshold` in config/profile.yml (cal-v1 scale,
 * 0-5), default 2.5.
 *
 * Forwarded rows are appended to batch/batch-input.tsv (what batch-runner.sh
 * reads) with fresh ids above every id in the input and state files.
 * pipeline.md is read, never written.
 *
 * Usage:
 *   node eval-queue.mjs                    # list both sides, append the forwarded rows
 *   node eval-queue.mjs --dry-run          # list both sides, write nothing
 *   node eval-queue.mjs --force <url>      # repeatable
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { DEFAULT_FORWARD_THRESHOLD } from './lib/rank-calibration.mjs';
import { RANK_CALIBRATION_VERSION, readRankScore } from './rank-pipeline.mjs';
import { collectSeenUrls, normalizeUrlForDedup } from './scan.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const DEFAULT_BATCH_INPUT = join(CODE_ROOT, 'batch', 'batch-input.tsv');
const BATCH_INPUT_HEADER = 'id\turl\tsource\tnotes';
const REPORT_URL = /^\*\*URL:\*\*\s*(\S+)/m;

const USAGE = `
  eval-queue.mjs — build the long-evaluation queue through the cal-v1 forwarding gate

  node eval-queue.mjs [--force <url>]... [--dry-run]

    cutoff              rank_forward_threshold in config/profile.yml,
                         else ${DEFAULT_FORWARD_THRESHOLD}
    --force <url>        forward this ranked pending row even below the cutoff;
                         repeatable
    --dry-run            print the plan, write nothing
`;

/**
 * A cutoff on the cal-v1 scale. Blank means "not configured".
 * @param {unknown} raw
 * @param {string} source - where the value came from, for the error message.
 * @returns {number | null}
 */
export function parseForwardThreshold(raw, source) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value) || value < 0 || value > 5) {
    throw new Error(`${source}: forwarding cutoff must be a number from 0 to 5 on the ${RANK_CALIBRATION_VERSION} scale, got "${raw}"`);
  }
  return value;
}

/**
 * The configured cutoff: `rank_forward_threshold` in config/profile.yml, or the default.
 * @param {string} profilePath
 * @returns {number}
 */
export function loadForwardThreshold(profilePath) {
  if (!existsSync(profilePath)) return DEFAULT_FORWARD_THRESHOLD;
  const profile = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  return parseForwardThreshold(profile.rank_forward_threshold, `${profilePath} rank_forward_threshold`)
    ?? DEFAULT_FORWARD_THRESHOLD;
}

/**
 * Keys of every posting already evaluated, each mapped to where it was found.
 * @param {{ applicationsText?: string, reports?: { name: string, text: string }[] }} sources
 * @returns {Map<string, string>}
 */
export function collectEvaluated({ applicationsText = '', reports = [] }) {
  const evaluated = new Map();
  for (const { name, text } of reports) {
    const url = REPORT_URL.exec(text)?.[1];
    if (!url) continue;
    const key = normalizeUrlForDedup(url);
    if (!evaluated.has(key)) evaluated.set(key, `reports/${name}`);
  }
  for (const key of collectSeenUrls({ applicationsText }).seen) {
    if (!evaluated.has(key)) evaluated.set(key, 'the tracker');
  }
  return evaluated;
}

/**
 * Rows of a batch-input.tsv (or batch-state.tsv, whose first two columns are the
 * same id/url pair), keyed by normalized URL, plus the highest numeric id seen.
 * @param {string} text
 * @returns {{ byKey: Map<string, string>, maxId: number }}
 */
export function parseBatchRows(text) {
  const byKey = new Map();
  let maxId = 0;
  for (const line of String(text ?? '').split('\n').slice(1)) {
    const [id = '', url = ''] = line.split('\t');
    if (!id.trim() || !url.trim()) continue;
    const n = Number(id);
    if (Number.isInteger(n) && n > maxId) maxId = n;
    const key = normalizeUrlForDedup(url.trim());
    if (!byKey.has(key)) byKey.set(key, id.trim());
  }
  return { byKey, maxId };
}

/**
 * Pending `- [ ]` rows of pipeline.md, in file order.
 * @param {string} text
 */
export function parsePendingRows(text) {
  const rows = [];
  String(text ?? '').split('\n').forEach((raw, index) => {
    if (!raw.startsWith('- [ ] ')) return;
    const cells = raw.slice(6).split('|').map(cell => cell.trim());
    if (!cells[0]) return;
    rows.push({
      line: index + 1,
      url: cells[0],
      company: cells[1] ?? '',
      title: cells[2] ?? '',
      rank: readRankScore(raw),
    });
  });
  return rows;
}

const fmt = score => score.toFixed(1);

/**
 * Split the pending rows into forwarded and held, each with its reason.
 * Forwarded rows come out highest rank first; held rows keep file order.
 *
 * @param {object} input
 * @param {ReturnType<typeof parsePendingRows>} input.rows
 * @param {number} input.threshold
 * @param {Map<string, string>} input.evaluated - from collectEvaluated.
 * @param {Map<string, string>} input.queued - normalized URL -> batch id.
 * @param {string[]} [input.force] - ranked URLs to forward regardless of cutoff.
 */
export function planQueue({ rows, threshold, evaluated, queued, force = [] }) {
  const forced = new Set(force.map(normalizeUrlForDedup));
  const representative = new Map();
  for (const row of rows) {
    const key = normalizeUrlForDedup(row.url);
    const previous = representative.get(key);
    if (!previous || (row.rank ?? -1) > (previous.rank ?? -1)) representative.set(key, row);
  }
  const forwarded = [];
  const held = [];
  for (const row of rows) {
    const key = normalizeUrlForDedup(row.url);
    const hold = reason => held.push({ ...row, reason });
    const forward = reason => forwarded.push({ ...row, reason });
    if (representative.get(key) !== row) { hold(`duplicate of pipeline.md line ${representative.get(key).line}`); continue; }
    if (evaluated.has(key)) { hold(`already evaluated (${evaluated.get(key)})`); continue; }
    if (queued.has(key)) { hold(`already queued (batch-input id ${queued.get(key)})`); continue; }
    if (row.rank === null) {
      hold(`no ${RANK_CALIBRATION_VERSION} rank yet, waits for the daily rank run${forced.has(key) ? '; --force requires a cal-v1 rank' : ''}`);
      continue;
    }
    if (forced.has(key)) {
      forward(`forced: ${RANK_CALIBRATION_VERSION} ${fmt(row.rank)}${row.rank < threshold ? ` below cutoff ${fmt(threshold)}` : ''}`);
      continue;
    }
    if (row.rank < threshold) { hold(`${RANK_CALIBRATION_VERSION} ${fmt(row.rank)} below cutoff ${fmt(threshold)}`); continue; }
    forward(`${RANK_CALIBRATION_VERSION} ${fmt(row.rank)} at or above cutoff ${fmt(threshold)}`);
  }
  forwarded.sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1));
  const pendingKeys = new Set(representative.keys());
  const unknownForce = force.filter(url => !pendingKeys.has(normalizeUrlForDedup(url)));
  return { threshold, forwarded, held, unknownForce };
}

const tsvCell = value => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/**
 * batch-input.tsv lines for the forwarded rows, numbered from `firstId`.
 * A `local:` JD reference is passed on as `jd=<path>`, which batch-runner.sh
 * seeds into the worker's JD file.
 * @param {{ url: string, company: string, title: string, reason: string }[]} forwarded
 * @param {number} firstId
 * @returns {string[]}
 */
export function formatBatchRows(forwarded, firstId) {
  return forwarded.map((row, i) => {
    const jd = row.url.startsWith('local:') ? `jd=${row.url.slice('local:'.length)} ` : '';
    const notes = `${jd}${row.reason} | ${row.company} | ${row.title}`;
    return [firstId + i, row.url, 'eval-queue', notes].map(tsvCell).join('\t');
  });
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function readReports(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .map(name => ({ name, text: readFileSync(join(dir, name), 'utf-8') }));
}

function printPlan(plan, write) {
  const line = row => `  ${row.url} | ${row.company} | ${row.title}\n      ${row.reason}`;
  console.log(`Forwarding cutoff: ${RANK_CALIBRATION_VERSION} >= ${fmt(plan.threshold)}`);
  console.log(`\nForwarded to the long evaluation (${plan.forwarded.length}):`);
  plan.forwarded.forEach(row => console.log(line(row)));
  console.log(`\nHeld (${plan.held.length}):`);
  plan.held.forEach(row => console.log(line(row)));
  if (write) console.log(`\n${write}`);
}

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        force: { type: 'string', multiple: true, default: [] },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (values.help) { console.log(USAGE); return 0; }

  let threshold;
  try {
    threshold = loadForwardThreshold(join(DATA_ROOT, 'config', 'profile.yml'));
  } catch (err) {
    console.error(err.message);
    return 2;
  }

  const batchInput = DEFAULT_BATCH_INPUT;
  const result = await withPipelineLock(batchInput, () => {
    const existing = readIfExists(batchInput);
    const inputRows = parseBatchRows(existing);
    const stateRows = parseBatchRows(readIfExists(join(dirname(batchInput), 'batch-state.tsv')));
    const plan = planQueue({
      rows: parsePendingRows(readIfExists(join(DATA_ROOT, 'data', 'pipeline.md'))),
      threshold,
      evaluated: collectEvaluated({
        applicationsText: readIfExists(resolveTrackerPath(DATA_ROOT)),
        reports: readReports(join(DATA_ROOT, 'reports')),
      }),
      queued: inputRows.byKey,
      force: values.force,
    });
    if (plan.unknownForce.length) return { plan, written: '' };

    let written = '';
    if (!values['dry-run'] && plan.forwarded.length) {
      const firstId = Math.max(inputRows.maxId, stateRows.maxId) + 1;
      const base = existing.trim() ? existing.replace(/\n*$/, '\n') : `${BATCH_INPUT_HEADER}\n`;
      writeFileSync(batchInput, `${base}${formatBatchRows(plan.forwarded, firstId).join('\n')}\n`);
      written = `Appended ${plan.forwarded.length} row(s) to ${batchInput} (ids ${firstId}-${firstId + plan.forwarded.length - 1}).`;
    } else if (values['dry-run']) {
      written = '--dry-run: nothing written.';
    }
    return { plan, written };
  });
  if (result.plan.unknownForce.length) {
    console.error(`--force names no pending row in data/pipeline.md: ${result.plan.unknownForce.join(', ')}`);
    return 2;
  }
  printPlan(result.plan, result.written);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
