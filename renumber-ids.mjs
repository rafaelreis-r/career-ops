#!/usr/bin/env node

/**
 * renumber-ids.mjs — move one track's application and report numbers into the
 * track's 100,000-number block, and back.
 *
 * Every number n of a track becomes `base + n` (track A: 25 -> 100025, B: 1037
 * -> 201037). The tracker `#` and the report number share one number space, so
 * both get the same function and every row-to-report link survives. The
 * reverse is `novo - base`, driven by the id-map the forward plan writes.
 *
 * Usage:
 *   node renumber-ids.mjs plan --root <track> --track A --base 100000 --out <dir>
 *        [--ledger-assign 3244@2026-10-11=103255 ...]
 *   node renumber-ids.mjs plan --root <track> --reverse --id-map <id-map.tsv> --out <dir>
 *   node renumber-ids.mjs shared --shared-dir <dir> --track A=<root>:100000 [...] --out <dir>
 *        [--owner contacts.tsv:12=B ...]
 *   node renumber-ids.mjs shared --shared-dir <dir> --reverse --id-map <file> [...] --out <dir>
 *   node renumber-ids.mjs apply --plan <dir>/plan.json
 *
 * `plan` and `shared` only read: they write plan.json, id-map.tsv and
 * changes.tsv into --out. `apply` executes a plan after checking that nothing
 * changed since it was written. See docs/FORK.md for the migration procedure.
 */

import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { extname, join, posix, relative, resolve, sep } from 'path';
import {
  extractTrackerReportNumbers, isGluedRow, isSeparatorRow, parseTrackerRow, resolveColumns,
} from './tracker-parse.mjs';
import {
  acquireTrackerLock, canonicalizeTrackerPath, normalizeCompany, renameSyncWithRetry,
  trackerLockDirFor, writeFileAtomic,
} from './tracker-utils.mjs';
import { acquirePipelineLock } from './pipeline-lock.mjs';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { isNestedCheckout } from './lib/mjs-files.mjs';

/** Size of one track's number block. A=100000-199999, B=200000-299999, ... */
export const BLOCK = 100_000;
const PLAN_VERSION = 1;
const ID_MAP_HEADER = ['trilha', 'antigo', 'novo', 'tipo', 'detalhe'].join('\t');

const TEXT_EXTS = new Set(['.md', '.markdown', '.tsv', '.csv', '.txt', '.json', '.yml', '.yaml', '.html', '.htm']);
const DATE_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g;
const ANCHOR_RE = /^\d+-faixa-inicial\.md$/;
const RESERVED_RE = /^\d+-RESERVED\.md$/;
const BARE_DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/** Directories included in a track snapshot. */
const SCOPE_DIRS = [
  { rel: 'reports', recursive: true },
  { rel: 'jds', recursive: true },
  { rel: 'covers', recursive: true },
  { rel: 'output', recursive: true },
  { rel: 'data', recursive: true },
];
// Path anchors inside text. Single-level kinds only rename the entry directly
// below the anchor; token kinds rename every segment below it.
const ROOT_ANCHORS = { reports: 'reports', jds: 'prefix-dash', covers: 'prefix-dash', output: 'tokens' };
const DATA_ANCHORS = {
  outcomes: 'prefix-underscore',
  'followup-drafts': 'prefix-dash',
  'application-packets': 'tokens-skip-first',
};
const SINGLE_LEVEL = new Set(['reports', 'prefix-dash', 'prefix-underscore']);

const LEDGER_REL = 'data/status-log.tsv';
const PIPELINE_REL = 'data/pipeline.md';
const FOLLOWUPS_REL = 'data/follow-ups.md';
const PDF_INDEX_REL = 'data/pdf-index.tsv';

const SHARED_FILES = [
  { name: 'contacts.tsv', numCol: 7, companyCol: 1, notesCol: 8, space: 'tracker' },
  { name: 'salary-observations.tsv', numCol: 0, companyCol: null, notesCol: null, space: 'tracker' },
  { name: 'assessments.tsv', numCol: 2, companyCol: 1, notesCol: null, space: 'report' },
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const pad3 = (n) => String(n).padStart(3, '0');
const isBackupName = (name) => /\.bak[^/]*$|\.(?:backup|orig)(?:[-._]|$)/i.test(name) || name.endsWith('~');
const isTextName = (name) => TEXT_EXTS.has(extname(name).toLowerCase());
const startsWithDate = (name) => /^\d{4}-\d{2}-\d{2}(?!\d)/.test(name);

class PlanError extends Error {}

// ---------------------------------------------------------------------------
// Tree snapshots. Planning works on an in-memory snapshot so the same code can
// plan against the disk and against the virtual result of a plan (the
// round-trip self-check).
// ---------------------------------------------------------------------------

function trackerRelFor(root) {
  return existsSync(join(root, 'data', 'applications.md')) ? 'data/applications.md' : 'applications.md';
}

function readEntry(abs, name) {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return { type: 'symlink' };
  if (st.isDirectory()) return { type: 'dir' };
  if (!st.isFile()) return { type: 'other' };
  const entry = { type: 'file', mode: st.mode & 0o7777, text: null, sha: null };
  if (isTextName(name)) {
    const buf = readFileSync(abs);
    entry.sha = sha256(buf);
    const text = buf.toString('utf8');
    // Only valid UTF-8 is rewritten; anything else would not round-trip.
    if (Buffer.from(text, 'utf8').equals(buf)) entry.text = text;
  }
  return entry;
}

/** Snapshot the files a renumbering reads or renames under one track root. */
export function snapshotTrack(root) {
  const entries = new Map();
  const add = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs) && !isDanglingLink(abs)) return null;
    const entry = readEntry(abs, posix.basename(rel));
    entries.set(rel, entry);
    return entry;
  };
  const walk = (dir, recursive) => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === join(root, 'data') && /^pipeline\.md\.lock(?:\.recover)?$/.test(name)) continue;
      const full = join(dir, name);
      const entry = add(relative(root, full).split(sep).join('/'));
      if (recursive && entry?.type === 'dir' && !isNestedCheckout(full)) walk(full, true);
    }
  };
  if (trackerRelFor(root) === 'applications.md') add('applications.md');
  for (const { rel, recursive } of SCOPE_DIRS) {
    const entry = add(rel);
    if (entry?.type === 'dir') walk(join(root, rel), recursive);
  }
  return { entries };
}

function isDanglingLink(abs) {
  try { return lstatSync(abs).isSymbolicLink(); } catch { return false; }
}

function fingerprintOf(snapshot) {
  const lines = [...snapshot.entries.keys()].sort().map((rel) => {
    const e = snapshot.entries.get(rel);
    return `${rel}\t${e.type}\t${e.sha ?? ''}`;
  });
  return sha256(lines.join('\n'));
}

function cloneSnapshot(snapshot) {
  return { entries: new Map([...snapshot.entries].map(([k, v]) => [k, { ...v }])) };
}

const depthOf = (rel) => rel.split('/').length;

/** Apply plan operations to a snapshot in memory. */
function applyVirtual(snapshot, ops, texts) {
  const next = cloneSnapshot(snapshot);
  for (const op of ops) {
    if (op.op !== 'write') continue;
    const e = next.entries.get(op.path);
    e.text = texts.get(op.path);
    e.sha = sha256(Buffer.from(e.text, 'utf8'));
  }
  for (const op of ops.filter((o) => o.op === 'rename')) {
    const moved = [];
    for (const [rel, e] of next.entries) {
      if (rel === op.from || rel.startsWith(`${op.from}/`)) moved.push([rel, e]);
    }
    for (const [rel] of moved) next.entries.delete(rel);
    for (const [rel, e] of moved) next.entries.set(op.to + rel.slice(op.from.length), e);
  }
  for (const op of ops) {
    if (op.op === 'delete') next.entries.delete(op.path);
    if (op.op === 'create') {
      next.entries.set(op.path, { type: 'file', mode: 0o644, text: op.content, sha: sha256(Buffer.from(op.content, 'utf8')) });
    }
  }
  return next;
}

function diffSnapshots(a, b) {
  const diffs = [];
  for (const [rel, e] of a.entries) {
    const o = b.entries.get(rel);
    if (!o) diffs.push(`missing after round trip: ${rel}`);
    else if (o.type !== e.type) diffs.push(`type changed: ${rel}`);
    else if ((e.text ?? null) !== (o.text ?? null)) diffs.push(`content differs after round trip: ${rel}`);
  }
  for (const rel of b.entries.keys()) if (!a.entries.has(rel)) diffs.push(`unexpected after round trip: ${rel}`);
  return diffs;
}

// ---------------------------------------------------------------------------
// Number mapping. One mapper per (track, direction). Spellings: the forward
// output is always the plain integer; the reverse writes the canonical
// spelling of its context (3-digit minimum in file names and pdf-index, plain
// elsewhere) unless the id-map recorded the original spelling of that exact
// occurrence. Occurrences are keyed by file, kind, value and ordinal.
// ---------------------------------------------------------------------------

function createMapper({ direction, track, base, numbers, trackerRev = new Map(), spellings = new Map() }) {
  const counts = {};
  const spellingRows = [];
  const inBlock = (n) => n > base && n < base + BLOCK;
  const mapper = {
    direction, track, base, numbers, counts, spellingRows,
    count(category, by = 1) { counts[category] = (counts[category] || 0) + by; },
    /** Fields whose meaning is "this track's number": map any number in range. */
    structural(n, space) {
      if (direction === 'forward') return n >= 1 && n < BLOCK ? base + n : null;
      if (!inBlock(n)) return null;
      return space === 'tracker' && trackerRev.has(n) ? trackerRev.get(n) : n - base;
    },
    /** Free text and middle-of-name tokens: map only numbers in this track's map. */
    member(n) {
      if (direction === 'forward') return n >= 1 && n < BLOCK && numbers.has(n) ? base + n : null;
      return inBlock(n) && numbers.has(n - base) ? n - base : null;
    },
    /**
     * Spell a mapped occurrence. `ctx` scopes ordinals to one file or name.
     * Forward: `value` is the old number and `original` its spelling.
     * Reverse: `value` is the new number and `mapped` the old one.
     */
    spell(ctx, original, value, mapped, style) {
      const novo = direction === 'forward' ? mapped : value;
      const ordinal = (ctx.counts.get(novo) || 0) + 1;
      ctx.counts.set(novo, ordinal);
      if (direction === 'forward') {
        const canonical = style === 'pad3' ? pad3(value) : String(value);
        if (original !== canonical) spellingRows.push({ ctx, novo, ordinal, spelling: original });
        return String(mapped);
      }
      const recorded = spellings.get(spellingKey(ctx.key, ctx.kind, novo, ordinal));
      if (recorded !== undefined) return recorded;
      return style === 'pad3' ? pad3(mapped) : String(mapped);
    },
  };
  return mapper;
}

const spellingKey = (path, kind, novo, ordinal) => `${path}\u0000${kind}\u0000${novo}\u0000${ordinal}`;
const newCtx = (key, kind) => ({ key, kind, counts: new Map() });

/** Rewrite the numbers in one directory-entry name. */
function mapName(name, kind, mapper, ctx, category) {
  if (kind === 'reports' && (ANCHOR_RE.test(name) || BARE_DATE_FILE_RE.test(name))) return name;
  if (kind === 'reports' || kind === 'prefix-dash' || kind === 'prefix-underscore') {
    if (startsWithDate(name)) return name;
    const sep = kind === 'prefix-underscore' ? '_' : '-';
    const m = name.match(new RegExp(`^(\\d+)(?=${sep})`));
    if (!m) return name;
    const mapped = mapper.structural(parseInt(m[1], 10), 'report');
    if (mapped == null) return name;
    mapper.count(category);
    return mapper.spell(ctx, m[1], parseInt(m[1], 10), mapped, 'pad3') + name.slice(m[1].length);
  }
  // Token kinds: every all-digit token between -, _ or . that is not part of
  // a date. Tokens after the first need three digits, which keeps version
  // suffixes and ordinals such as `top-10` out.
  const dates = [...name.matchAll(DATE_RE)].map((d) => [d.index, d.index + d[0].length]);
  let changed = false;
  const out = name.replace(/(?<![^-_.])(\d+)(?![^-_.])/g, (tok, digits, offset) => {
    if (dates.some(([s, e]) => offset < e && offset + tok.length > s)) return tok;
    if (offset === 0 && kind === 'tokens-skip-first') return tok;
    if (offset !== 0 && digits.length < 3) return tok;
    const value = parseInt(digits, 10);
    const mapped = mapper.member(value);
    if (mapped == null) return tok;
    changed = true;
    return mapper.spell(ctx, digits, value, mapped, 'pad3');
  });
  if (changed) mapper.count(category);
  return out;
}

// ---------------------------------------------------------------------------
// Text rewriting: markdown links, path tokens and `#NNN` tokens.
// ---------------------------------------------------------------------------

// Free-text `#NNN` needs three digits or more: `#1`, `#4` in prose are ranks
// and story numbers, while vacancy references are written `#025` or `#3244`.
const SEGMENT_RE = new RegExp([
  String.raw`\[([^\]\n]*)\]\(([^)\s]*)\)`,
  String.raw`(?<=^|[\s(\[{,;:|*_"'>~]|#\d+\/)#(\d{3,})(?!\w)`,
  String.raw`(?<![\w.~@%+\/-])[\w.~@%+-]*\/[\w.~@%+\/-]*`,
].join('|'), 'g');

function prefixIsRoot(prefix, env) {
  if (prefix.length === 0) return true;
  if (prefix.every((s) => s === '.' || s === '..')) return true;
  let abs;
  if (prefix[0] === '~') abs = join(homedir(), ...prefix.slice(1));
  else if (prefix[0] === '' && prefix.length > 1 && prefix[1] !== '') abs = resolve('/', ...prefix.slice(1));
  else return false;
  return env.rootAliases.has(abs);
}

/**
 * Rewrite one path-like token. Returns the new text and the anchor kind when
 * the path points into this track (`null` for foreign or unrelated paths).
 */
function rewritePathToken(tok, env, ctx, { linkDest = false } = {}) {
  const segs = tok.split('/');
  let at = -1;
  let kind = null;
  let width = 0;
  for (let i = 0; i < segs.length; i++) {
    if (ROOT_ANCHORS[segs[i]]) { at = i; kind = ROOT_ANCHORS[segs[i]]; width = 1; break; }
    if (segs[i] === 'data' && DATA_ANCHORS[segs[i + 1]]) { at = i; kind = DATA_ANCHORS[segs[i + 1]]; width = 2; break; }
  }
  if (at === -1) {
    // A report body links its siblings by bare file name.
    const sibling = linkDest && env.fileDir === 'reports'
      && (segs.length === 1 || (segs.length === 2 && segs[0] === '.'));
    if (!sibling || !/^\d+-.*\.md$/.test(segs.at(-1))) return { text: tok, ours: null };
    segs[segs.length - 1] = mapName(segs.at(-1), 'reports', env.mapper, ctx, `${env.label}.path`);
    return { text: segs.join('/'), ours: 'reports' };
  }
  if (!prefixIsRoot(segs.slice(0, at), env)) return { text: tok, ours: null };
  const start = at + width;
  if (start >= segs.length) return { text: tok, ours: kind };
  const last = SINGLE_LEVEL.has(kind) ? start : segs.length - 1;
  for (let i = start; i <= last; i++) {
    if (segs[i] === '') continue;
    segs[i] = mapName(segs[i], kind, env.mapper, ctx, `${env.label}.path`);
  }
  return { text: segs.join('/'), ours: segs[at] === 'reports' || segs[at] === 'jds' ? 'reports' : kind };
}

/** Rewrite links, paths and (when `hash`) free-text `#NNN` tokens. */
function rewriteSegment(text, env, ctx, { hash }) {
  return text.replace(SEGMENT_RE, (match, label, dest, hashDigits) => {
    if (dest !== undefined) {
      const target = rewritePathToken(dest, env, ctx, { linkDest: true });
      let newLabel;
      if (/^\d+$/.test(label) && target.ours === 'reports') {
        newLabel = mapField(label, 'report', 'plain', env, ctx, `${env.label}.link`);
      } else {
        newLabel = rewriteSegment(label, env, ctx, { hash });
      }
      return `[${newLabel}](${target.text})`;
    }
    if (hashDigits !== undefined) {
      if (!hash) return match;
      const value = parseInt(hashDigits, 10);
      const mapped = env.mapper.member(value);
      if (mapped == null) return match;
      env.mapper.count(`${env.label}.hash`);
      return `#${env.mapper.spell(ctx, hashDigits, value, mapped, 'plain')}`;
    }
    return rewritePathToken(match, env, ctx).text;
  });
}

/** Map one structural numeric field (whole cell or captured digits). */
function mapField(digits, space, style, env, ctx, category, override = null) {
  const value = parseInt(digits, 10);
  const mapped = override ?? env.mapper.structural(value, space);
  if (mapped == null) return digits;
  env.mapper.count(category);
  return env.mapper.spell(ctx, digits, value, mapped, style);
}

function rewriteLines(text, fn) {
  return text.split('\n').map(fn).join('\n');
}

// ---------------------------------------------------------------------------
// Per-file processors.
// ---------------------------------------------------------------------------

function processTracker(text, env, ctx) {
  const lines = text.split('\n');
  const colmap = resolveColumns(lines);
  return lines.map((line, idx) => {
    const row = parseTrackerRow(line, colmap);
    if (!row) return rewriteSegment(line, env, ctx, { hash: true });
    const parts = line.split('|');
    parts[colmap.num] = parts[colmap.num].replace(/\d+/, (digits) => {
      const override = env.mapper.direction === 'forward' ? env.rowExceptions.get(idx)?.novo ?? null : null;
      return mapField(digits, 'tracker', 'plain', env, ctx, 'tracker.num', override);
    });
    for (let i = 1; i < parts.length; i++) {
      if (i === colmap.num) continue;
      parts[i] = rewriteSegment(parts[i], env, ctx, { hash: true });
    }
    return parts.join('|');
  }).join('\n');
}

function processLedger(text, env, ctx) {
  return rewriteLines(text, (line) => {
    if (/^\s*#/.test(line)) return line;
    const cols = line.split('\t');
    if (!/^\d+$/.test(cols[0])) return line;
    let override = null;
    if (env.mapper.direction === 'forward') {
      const n = parseInt(cols[0], 10);
      if (env.dupNums.has(n)) override = env.ledgerAssign.get(`${n}@${cols[1]}`)?.novo ?? null;
    }
    cols[0] = mapField(cols[0], 'tracker', 'plain', env, ctx, 'ledger.num', override);
    for (let i = 1; i < cols.length; i++) cols[i] = rewriteSegment(cols[i], env, ctx, { hash: true });
    return cols.join('\t');
  });
}

function processPdfIndex(text, env, ctx) {
  return rewriteLines(text, (line) => {
    if (/^\s*#/.test(line)) return line;
    const cols = line.split('\t');
    if (/^\d+$/.test(cols[0])) cols[0] = mapField(cols[0], 'report', 'pad3', env, ctx, 'pdf-index.num');
    for (let i = 1; i < cols.length; i++) cols[i] = rewriteSegment(cols[i], env, ctx, { hash: true });
    return cols.join('\t');
  });
}

const PIPELINE_ITEM_RE = /^(\s*-\s+\[[ xX]\]\s+#)(\d+)(?!\d)/;

function processPipeline(text, env, ctx) {
  return rewriteLines(text, (line) => {
    const m = line.match(PIPELINE_ITEM_RE);
    if (!m) return rewriteSegment(line, env, ctx, { hash: true });
    const head = m[1] + mapField(m[2], 'report', 'plain', env, ctx, 'pipeline.num');
    return head + rewriteSegment(line.slice(m[0].length), env, ctx, { hash: true });
  });
}

// `- next #<appNum> <date> (set <date>)` (followup-seed.mjs) and
// `- <date> · #<appNum> ...` (followup-cadence.mjs) carry the tracker #.
const FOLLOWUP_PIN_RE = /^(\s*-\s+next\s+#|\s*-\s+\d{4}-\d{2}-\d{2}\s+·\s+#)(\d+)(?!\d)/;

function processFollowups(text, env, ctx) {
  let appCol = -1;
  return rewriteLines(text, (line) => {
    if (line.startsWith('|')) {
      const parts = line.split('|');
      const header = parts.findIndex((p) => p.trim().toLowerCase() === 'appnum');
      if (header !== -1) { appCol = header; return line; }
      if (isSeparatorRow(line)) return line;
      for (let i = 1; i < parts.length; i++) {
        if (i === appCol && /^\s*\d+\s*$/.test(parts[i])) {
          parts[i] = parts[i].replace(/\d+/, (d) => mapField(d, 'tracker', 'plain', env, ctx, 'follow-ups.appnum'));
        } else {
          parts[i] = rewriteSegment(parts[i], env, ctx, { hash: true });
        }
      }
      return parts.join('|');
    }
    const m = line.match(FOLLOWUP_PIN_RE);
    if (!m) return rewriteSegment(line, env, ctx, { hash: true });
    const head = m[1] + mapField(m[2], 'tracker', 'plain', env, ctx, 'follow-ups.pin');
    return head + rewriteSegment(line.slice(m[0].length), env, ctx, { hash: true });
  });
}

function processorFor(rel, trackerRel) {
  if (rel === trackerRel) return { fn: processTracker, label: 'tracker' };
  if (rel === LEDGER_REL) return { fn: processLedger, label: 'ledger' };
  if (rel === PDF_INDEX_REL) return { fn: processPdfIndex, label: 'pdf-index' };
  if (rel === PIPELINE_REL) return { fn: processPipeline, label: 'pipeline' };
  if (rel === FOLLOWUPS_REL) return { fn: processFollowups, label: 'follow-ups' };
  const name = posix.basename(rel);
  // Backups and hidden scratch copies (`output/.x-applications-before-...md`)
  // are history: renamed with their directory, never rewritten.
  if (rel.split('/').some((part) => isBackupName(part) || part.startsWith('.')) || !isTextName(name)) return null;
  if (posix.dirname(rel) === 'reports') {
    if (ANCHOR_RE.test(name)) return null;
    if (extname(name) === '.md') return { fn: (t, env, ctx) => rewriteLines(t, (l) => rewriteSegment(l, env, ctx, { hash: true })), label: 'report' };
  }
  if (!SCOPE_DIRS.some(({ rel: dir }) => rel.startsWith(`${dir}/`))) return null;
  return { fn: (t, env, ctx) => rewriteLines(t, (l) => rewriteSegment(l, env, ctx, { hash: true })), label: 'paths' };
}

/** How the entry name at `rel` carries a number, or null when it does not. */
function nameKindFor(rel) {
  const segs = rel.split('/');
  const top = segs[0];
  if (top === 'reports' || top === 'jds' || top === 'covers') {
    return segs.length === 2 ? (top === 'reports' ? 'reports' : 'prefix-dash') : null;
  }
  if (top === 'output') return segs.length >= 2 ? 'tokens' : null;
  if (top === 'data' && segs.length >= 3) {
    const kind = DATA_ANCHORS[segs[1]];
    if (!kind) return null;
    if (SINGLE_LEVEL.has(kind)) return segs.length === 3 ? kind : null;
    return kind;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Track analysis: which numbers belong to the track, and the tracker rows
// whose duplicated `#` needs a row-specific new number (exception E1).
// ---------------------------------------------------------------------------

function trackerRowsOf(snapshot, trackerRel) {
  const text = snapshot.entries.get(trackerRel)?.text;
  if (text == null) throw new PlanError(`tracker not found or not UTF-8: ${trackerRel}`);
  const lines = text.split('\n');
  const colmap = resolveColumns(lines);
  const rows = [];
  lines.forEach((line, idx) => {
    if (isGluedRow(line)) throw new PlanError(`${trackerRel}:${idx + 1} carries two tracker rows on one line; split it first`);
    const row = parseTrackerRow(line, colmap);
    if (row) rows.push({ idx, num: row.num, company: row.company, reports: extractTrackerReportNumbers(row.report, row.notes) });
  });
  return rows;
}

function collectNumbers(snapshot, rows) {
  const tracker = new Set();
  const report = new Set();
  const reference = new Set();
  const inRange = (n) => n >= 1 && n < BLOCK;
  const addTo = (set, n) => { if (inRange(n)) set.add(n); };
  for (const r of rows) {
    addTo(tracker, r.num);
    for (const n of r.reports) addTo(report, n);
  }
  for (const [rel, e] of snapshot.entries) {
    const kind = nameKindFor(rel);
    const name = posix.basename(rel);
    if (kind === 'reports') {
      if (ANCHOR_RE.test(name) || BARE_DATE_FILE_RE.test(name)) continue;
      const m = name.match(/^(\d+)-/);
      if (m) addTo(report, parseInt(m[1], 10));
    } else if (kind === 'prefix-dash' || kind === 'prefix-underscore' || (kind === 'tokens' && rel.split('/').length >= 2)) {
      if (startsWithDate(name)) continue;
      const m = name.match(kind === 'prefix-underscore' ? /^(\d+)_/ : /^(\d+)[-_.]/);
      if (m) addTo(reference, parseInt(m[1], 10));
    }
    if (e.text == null) continue;
    if (rel === LEDGER_REL || rel === PDF_INDEX_REL) {
      for (const line of e.text.split('\n')) {
        const m = line.match(/^(\d+)\t/);
        if (m) addTo(reference, parseInt(m[1], 10));
      }
    } else if (rel === PIPELINE_REL || rel === FOLLOWUPS_REL) {
      for (const line of e.text.split('\n')) {
        const m = line.match(rel === PIPELINE_REL ? PIPELINE_ITEM_RE : FOLLOWUP_PIN_RE);
        if (m) addTo(reference, parseInt(m[2], 10));
      }
      if (rel === FOLLOWUPS_REL) {
        let appCol = -1;
        for (const line of e.text.split('\n')) {
          if (!line.startsWith('|')) continue;
          const parts = line.split('|');
          const header = parts.findIndex((p) => p.trim().toLowerCase() === 'appnum');
          if (header !== -1) { appCol = header; continue; }
          if (appCol !== -1 && /^\s*\d+\s*$/.test(parts[appCol] ?? '')) addTo(reference, parseInt(parts[appCol], 10));
        }
      }
    }
  }
  const all = new Set([...tracker, ...report, ...reference]);
  return { tracker, report, reference, all };
}

function trackerExceptions(rows, base) {
  const byNum = new Map();
  for (const r of rows) {
    if (r.num < 1 || r.num >= BLOCK) continue;
    if (!byNum.has(r.num)) byNum.set(r.num, []);
    byNum.get(r.num).push(r);
  }
  const usedNums = new Set(byNum.keys());
  const rowExceptions = new Map();
  const dupNums = new Set();
  const errors = [];
  const claimed = new Map();
  for (const [num, group] of byNum) {
    if (group.length < 2) continue;
    dupNums.add(num);
    for (const r of group) {
      if (r.reports.includes(num)) continue;
      const own = r.reports.length === 1 ? r.reports[0] : null;
      if (own == null || own >= BLOCK || usedNums.has(own) || claimed.has(own)) {
        errors.push(`tracker #${num} repeats on line ${r.idx + 1} (${r.company}) and its report number cannot replace it`);
        continue;
      }
      claimed.set(own, r.idx);
      rowExceptions.set(r.idx, { old: num, novo: base + own, report: own, company: r.company });
    }
  }
  return { rowExceptions, dupNums, errors };
}

// ---------------------------------------------------------------------------
// id-map rows.
// ---------------------------------------------------------------------------

function idRow(track, antigo, novo, tipo, detalhe = '') {
  return { trilha: track, antigo: String(antigo), novo: String(novo), tipo, detalhe };
}

export function formatIdMap(rows) {
  return `${[ID_MAP_HEADER, ...rows.map((r) => [r.trilha, r.antigo, r.novo, r.tipo, r.detalhe].join('\t'))].join('\n')}\n`;
}

export function parseIdMap(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines[0] !== ID_MAP_HEADER) throw new PlanError(`id-map header must be: ${ID_MAP_HEADER.replaceAll('\t', ' | ')}`);
  return lines.slice(1).map((line) => {
    const [trilha, antigo, novo, tipo, detalhe = ''] = line.split('\t');
    return { trilha, antigo, novo, tipo, detalhe };
  });
}

/** Reverse-direction inputs for one track, rebuilt from its id-map rows. */
function reverseContext(rows, track) {
  const mine = rows.filter((r) => r.trilha === track);
  const blockRow = mine.find((r) => r.tipo === 'block');
  if (!blockRow) throw new PlanError(`id-map has no block row for track ${track}`);
  const base = Number(blockRow.novo);
  const numbers = new Set();
  const trackerRev = new Map();
  const spellings = new Map();
  const anchors = [];
  for (const r of mine) {
    if (['tracker', 'report', 'tracker+report', 'reference'].includes(r.tipo)) numbers.add(Number(r.antigo));
    else if (r.tipo === 'tracker-exception') trackerRev.set(Number(r.novo), Number(r.antigo));
    else if (r.tipo === 'spelling') {
      const d = JSON.parse(r.detalhe);
      spellings.set(spellingKey(d.path, d.kind, Number(r.novo), d.ordinal), r.antigo);
    } else if (r.tipo === 'anchor') anchors.push(JSON.parse(r.detalhe));
  }
  return { base, numbers, trackerRev, spellings, anchors };
}

// ---------------------------------------------------------------------------
// Track planning.
// ---------------------------------------------------------------------------

function parseLedgerAssign(values) {
  const map = new Map();
  for (const raw of values) {
    const m = String(raw).match(/^(\d+)@(\d{4}-\d{2}-\d{2})=(\d+)$/);
    if (!m) throw new PlanError(`--ledger-assign must look like 3244@2026-10-11=103255, got ${raw}`);
    map.set(`${parseInt(m[1], 10)}@${m[2]}`, { old: parseInt(m[1], 10), date: m[2], novo: parseInt(m[3], 10), used: false, raw });
  }
  return map;
}

/**
 * Plan one direction over a snapshot. Pure: returns operations, the new text
 * of every rewritten file (keyed by its current path) and the id-map rows.
 */
function planTrackCore(snapshot, root, opts) {
  const { direction, track } = opts;
  const trackerRel = trackerRelFor(root);
  const errors = [];
  const warnings = [];
  const rootAliases = new Set([resolve(root)]);
  try { rootAliases.add(realpathSync(root)); } catch { /* root checked by caller */ }

  let base;
  let numbersInfo = null;
  let rows = [];
  let exc = { rowExceptions: new Map(), dupNums: new Set(), errors: [] };
  let ledgerAssign = new Map();
  let mapper;
  let anchorsToCreate = [];
  if (direction === 'forward') {
    base = opts.base;
    rows = trackerRowsOf(snapshot, trackerRel);
    numbersInfo = collectNumbers(snapshot, rows);
    exc = trackerExceptions(rows, base);
    errors.push(...exc.errors);
    ledgerAssign = parseLedgerAssign(opts.ledgerAssign || []);
    mapper = createMapper({ direction, track, base, numbers: numbersInfo.all });
  } else {
    const rc = reverseContext(opts.idMapRows, track);
    base = rc.base;
    anchorsToCreate = rc.anchors;
    mapper = createMapper({ direction, track, base, numbers: rc.numbers, trackerRev: rc.trackerRev, spellings: rc.spellings });
  }

  // Ledger events of a duplicated `#` cannot be attributed by number alone.
  if (direction === 'forward') {
    const ledger = snapshot.entries.get(LEDGER_REL)?.text ?? '';
    ledger.split('\n').forEach((line, i) => {
      const cols = line.split('\t');
      if (!/^\d+$/.test(cols[0])) return;
      const n = parseInt(cols[0], 10);
      if (!exc.dupNums.has(n)) return;
      const assign = ledgerAssign.get(`${n}@${cols[1]}`);
      if (!assign) {
        errors.push(`${LEDGER_REL}:${i + 1} records #${n} on ${cols[1]}, but #${n} names more than one tracker row; pass --ledger-assign ${n}@${cols[1]}=<new number>`);
        return;
      }
      const candidates = new Set([base + n, ...[...exc.rowExceptions.values()].filter((x) => x.old === n).map((x) => x.novo)]);
      if (!candidates.has(assign.novo)) errors.push(`--ledger-assign ${assign.raw}: ${assign.novo} is not a new number of tracker #${n} (${[...candidates].join(', ')})`);
      assign.used = true;
    });
    for (const a of ledgerAssign.values()) if (!a.used) errors.push(`--ledger-assign ${a.raw} matches no ledger event of a repeated tracker #`);
    for (const rel of [FOLLOWUPS_REL]) {
      const text = snapshot.entries.get(rel)?.text ?? '';
      for (const n of exc.dupNums) {
        if (new RegExp(`#${n}(?!\\d)`).test(text)) warnings.push(`${rel} cites #${n}, which names more than one tracker row; it maps to ${base + n}`);
      }
    }
  }

  const env = {
    mapper, rootAliases, fileDir: '', label: '',
    rowExceptions: exc.rowExceptions, dupNums: exc.dupNums, ledgerAssign,
  };

  // Entry renames. Each prefix is mapped once so a directory's spelling is
  // recorded once and reused by every entry below it.
  const relMap = new Map();
  const mapRel = (rel) => {
    if (relMap.has(rel)) return relMap.get(rel);
    const parent = posix.dirname(rel);
    const newParent = parent === '.' ? '' : mapRel(parent);
    const name = posix.basename(rel);
    const kind = snapshot.entries.get(rel)?.type === 'symlink' ? null : nameKindFor(rel);
    let newName = name;
    if (kind) {
      const ctx = newCtx(direction === 'forward' ? null : rel, 'name');
      newName = mapName(name, kind, mapper, ctx, `rename.${rel.split('/')[0] === 'data' ? rel.split('/')[1] : rel.split('/')[0]}`);
      if (direction === 'forward') ctx.key = newParent ? `${newParent}/${newName}` : newName;
    }
    const out = newParent ? `${newParent}/${newName}` : newName;
    relMap.set(rel, out);
    return out;
  };

  const ops = [];
  const texts = new Map();
  const finals = new Map();
  const deleted = new Set();
  for (const [rel, e] of snapshot.entries) {
    if (direction === 'forward' && nameKindFor(rel) === 'reports' && ANCHOR_RE.test(posix.basename(rel))) {
      if (e.text == null) { errors.push(`${rel} is not a UTF-8 text file`); continue; }
      ops.push({ op: 'delete', path: rel, before: e.sha });
      deleted.add(rel);
      mapper.count('delete.anchor');
      continue;
    }
    if (direction === 'forward' && nameKindFor(rel) === 'reports' && RESERVED_RE.test(posix.basename(rel))) {
      warnings.push(`${rel} is a live reservation; apply refuses until it is released`);
    }
    finals.set(rel, mapRel(rel));
  }

  for (const [rel, e] of snapshot.entries) {
    if (e.type !== 'file' || e.text == null) continue;
    if (deleted.has(rel)) continue;
    const proc = processorFor(rel, trackerRel);
    if (!proc) continue;
    env.fileDir = posix.dirname(rel);
    env.label = proc.label;
    const ctx = newCtx(direction === 'forward' ? finals.get(rel) : rel, 'content');
    const next = proc.fn(e.text, env, ctx);
    if (next !== e.text) {
      texts.set(rel, next);
      ops.push({ op: 'write', path: rel, before: e.sha, after: sha256(Buffer.from(next, 'utf8')) });
    }
  }

  // `finals` maps every entry, unchanged ones included, so two entries
  // landing on one path is a collision whether or not one of them moved.
  const finalSet = new Map();
  for (const [rel, out] of finals) {
    if (finalSet.has(out)) errors.push(`${rel} and ${finalSet.get(out)} would both become ${out}`);
    finalSet.set(out, rel);
    if (posix.basename(out) !== posix.basename(rel)) {
      ops.push({ op: 'rename', from: rel, to: `${posix.dirname(rel)}/${posix.basename(out)}`, final: out });
    }
  }
  if (direction === 'reverse') {
    for (const a of anchorsToCreate) {
      if (snapshot.entries.has(a.path) || finalSet.has(a.path)) errors.push(`cannot restore ${a.path}: the path exists`);
      ops.push({ op: 'create', path: a.path, content: a.content, after: sha256(Buffer.from(a.content, 'utf8')) });
      mapper.count('create.anchor');
    }
  }
  ops.sort(opOrder);

  const idMapRows = [];
  if (direction === 'forward') {
    idMapRows.push(idRow(track, '-', base, 'block'));
    for (const n of [...numbersInfo.all].sort((a, b) => a - b)) {
      const t = numbersInfo.tracker.has(n);
      const r = numbersInfo.report.has(n);
      idMapRows.push(idRow(track, n, base + n, t && r ? 'tracker+report' : t ? 'tracker' : r ? 'report' : 'reference'));
    }
    for (const [idx, x] of exc.rowExceptions) {
      idMapRows.push(idRow(track, x.old, x.novo, 'tracker-exception', JSON.stringify({ line: idx + 1, report: x.report, company: x.company })));
    }
    for (const a of ledgerAssign.values()) {
      idMapRows.push(idRow(track, a.old, a.novo, 'ledger', JSON.stringify({ date: a.date })));
    }
    for (const s of mapper.spellingRows) {
      idMapRows.push(idRow(track, s.spelling, s.novo, 'spelling', JSON.stringify({ path: s.ctx.key, kind: s.ctx.kind, ordinal: s.ordinal })));
    }
    for (const op of ops.filter((o) => o.op === 'delete')) {
      const n = posix.basename(op.path).match(/^(\d+)/)[1];
      idMapRows.push(idRow(track, n, '-', 'anchor', JSON.stringify({ path: op.path, content: snapshot.entries.get(op.path).text })));
    }
  }
  return {
    ops, texts, idMapRows, counts: mapper.counts, errors, warnings, base, trackerRel,
    analysis: { rows, exc },
  };
}

function opOrder(a, b) {
  const rank = { write: 0, rename: 1, delete: 2, create: 3 };
  if (rank[a.op] !== rank[b.op]) return rank[a.op] - rank[b.op];
  if (a.op === 'rename') return depthOf(b.from) - depthOf(a.from) || a.from.localeCompare(b.from);
  return (a.path ?? '').localeCompare(b.path ?? '');
}

/** Plan a track renumbering (forward or reverse) against the disk. */
export function planTrack(options) {
  const root = resolve(options.root);
  if (!existsSync(join(root, trackerRelFor(root)))) throw new PlanError(`no tracker under ${root}`);
  const direction = options.reverse ? 'reverse' : 'forward';
  let track = options.track;
  let idMapRows = options.idMapRows ?? null;
  if (direction === 'reverse') {
    const tracks = [...new Set(idMapRows.filter((r) => r.tipo === 'block').map((r) => r.trilha))];
    if (!track) {
      if (tracks.length !== 1) throw new PlanError(`id-map covers tracks ${tracks.join(', ') || '(none)'}; pass --track`);
      track = tracks[0];
    }
  } else {
    validateTrackBase(track, options.base);
  }
  const snapshot = snapshotTrack(root);
  const result = planTrackCore(snapshot, root, {
    direction, track, base: options.base, ledgerAssign: options.ledgerAssign, idMapRows,
  });
  if (direction === 'forward' && result.errors.length === 0) {
    // Round trip in memory: the reverse of the forward result must give back
    // every byte. This proves the id-map is enough to undo the migration.
    const after = applyVirtual(snapshot, result.ops, result.texts);
    const back = planTrackCore(after, root, { direction: 'reverse', track, idMapRows: result.idMapRows });
    const restored = applyVirtual(after, back.ops, back.texts);
    const diffs = [...back.errors, ...diffSnapshots(snapshot, restored)];
    if (diffs.length) result.errors.push(...diffs.slice(0, 20).map((d) => `round-trip check: ${d}`));
  }
  return {
    mode: 'track', direction, track, root, base: result.base,
    inputs: { root, track, base: options.base ?? null, reverse: direction === 'reverse', ledgerAssign: options.ledgerAssign || [], idMapRows },
    fingerprint: fingerprintOf(snapshot), ...result,
  };
}

function validateTrackBase(track, base) {
  if (!/^[A-Z]$/.test(track ?? '')) throw new PlanError('--track must be one uppercase letter (A, B, C, ...)');
  if (!Number.isSafeInteger(base) || base < BLOCK || base % BLOCK !== 0 || base >= 10 * BLOCK) {
    throw new PlanError(`--base must be a multiple of ${BLOCK} between ${BLOCK} and ${9 * BLOCK}`);
  }
}

// ---------------------------------------------------------------------------
// Shared TSVs (symlinked into every track). Each row is migrated with the base
// of the track that owns its number.
// ---------------------------------------------------------------------------

function sharedRowOwner(file, cols, n, tracks, overrides, where) {
  const forced = overrides.get(where);
  if (forced) {
    const t = tracks.find((x) => x.track === forced);
    if (!t) throw new PlanError(`--owner ${where}=${forced}: unknown track`);
    return t;
  }
  let cands = tracks.filter((t) => file.space === 'tracker' ? t.rowsByNum.has(n) : t.reportNumbers.has(n));
  if (cands.length > 1 && file.companyCol != null) {
    const company = normalizeCompany(cols[file.companyCol] ?? '');
    cands = cands.filter((t) => [...t.rowsByNum.values()].flat().some((r) =>
      (file.space === 'tracker' ? r.num === n : r.reports.includes(n)) && normalizeCompany(r.company) === company));
  }
  return cands.length === 1 ? cands[0] : null;
}

function planSharedCore(texts, opts) {
  const errors = [];
  const warnings = [];
  const out = new Map();
  const idMapRows = [];
  const counts = {};
  const mappers = new Map();
  const mapperFor = (t) => {
    if (!mappers.has(t.track)) {
      mappers.set(t.track, createMapper({
        direction: opts.direction, track: t.track, base: t.base, numbers: t.numbers,
        trackerRev: t.trackerRev, spellings: opts.spellings,
      }));
    }
    return mappers.get(t.track);
  };
  for (const file of SHARED_FILES) {
    const text = texts.get(file.name);
    if (text == null) continue;
    const ctx = newCtx(`shared/${file.name}`, 'content');
    const lines = text.split('\n').map((line, i) => {
      if (line.trim() === '' || line.startsWith('#')) return line;
      const cols = line.split('\t');
      const raw = cols[file.numCol] ?? '';
      if (!/^\d+$/.test(raw)) return line;
      const n = parseInt(raw, 10);
      const where = `${file.name}:${i + 1}`;
      let owner;
      if (opts.direction === 'forward') {
        if (n >= BLOCK) return line;
        owner = sharedRowOwner(file, cols, n, opts.tracks, opts.overrides, where);
        if (!owner) { errors.push(`${where}: cannot tell which track owns #${n}; pass --owner ${where}=<track>`); return line; }
      } else {
        owner = opts.tracks.find((t) => n > t.base && n < t.base + BLOCK);
        if (!owner) return line;
      }
      const mapper = mapperFor(owner);
      let override = null;
      if (opts.direction === 'forward' && file.space === 'tracker' && owner.dupNums.has(n)) {
        const company = normalizeCompany(cols[file.companyCol] ?? '');
        const hits = owner.rowsByNum.get(n).filter((r) => normalizeCompany(r.company) === company);
        if (hits.length === 1) override = owner.rowExceptions.get(hits[0].idx)?.novo ?? null;
        else warnings.push(`${where}: #${n} names more than one ${owner.track} row; it maps to ${owner.base + n}`);
      }
      const env = { mapper, rootAliases: new Set(), fileDir: '', label: `shared.${file.name}` };
      cols[file.numCol] = mapField(raw, file.space, 'plain', env, ctx, `shared.${file.name}`, override);
      if (opts.direction === 'forward') {
        idMapRows.push(idRow(owner.track, n, cols[file.numCol], 'shared', JSON.stringify({ file: file.name, line: i + 1 })));
      }
      if (file.notesCol != null && cols[file.notesCol] != null) {
        cols[file.notesCol] = rewriteSegment(cols[file.notesCol], env, ctx, { hash: true });
      }
      return cols.join('\t');
    });
    const next = lines.join('\n');
    if (next !== text) out.set(file.name, next);
  }
  for (const m of mappers.values()) {
    for (const [k, v] of Object.entries(m.counts)) counts[k] = (counts[k] || 0) + v;
    for (const s of m.spellingRows) {
      idMapRows.push(idRow(m.track, s.spelling, s.novo, 'spelling', JSON.stringify({ path: s.ctx.key, kind: s.ctx.kind, ordinal: s.ordinal })));
    }
  }
  return { out, idMapRows, counts, errors, warnings };
}

function readSharedTexts(sharedDir) {
  const texts = new Map();
  const shas = {};
  for (const file of SHARED_FILES) {
    const abs = join(sharedDir, file.name);
    if (!existsSync(abs)) continue;
    if (lstatSync(abs).isSymbolicLink()) throw new PlanError(`${abs} is a symlink; point --shared-dir at the directory that holds the real files`);
    const buf = readFileSync(abs);
    texts.set(file.name, buf.toString('utf8'));
    shas[file.name] = sha256(buf);
  }
  return { texts, shas };
}

/** Plan the shared TSVs. Forward resolves owners from the (unmigrated) tracks. */
export function planShared(options) {
  const sharedDir = resolve(options.sharedDir);
  const direction = options.reverse ? 'reverse' : 'forward';
  const { texts, shas } = readSharedTexts(sharedDir);
  let tracks;
  const spellings = new Map();
  const trackIdRows = [];
  if (direction === 'forward') {
    tracks = options.tracks.map(({ track, root, base }) => {
      validateTrackBase(track, base);
      const plan = planTrack({ root, track, base, ledgerAssign: options.ledgerAssign?.[track] });
      if (plan.errors.length) throw new PlanError(`track ${track} has plan errors; run plan for it first:\n  ${plan.errors.join('\n  ')}`);
      const { rows, exc } = plan.analysis;
      if (rows.some((r) => r.num >= BLOCK)) throw new PlanError(`track ${track} already has six-digit tracker numbers; plan the shared files before migrating any track`);
      const rowsByNum = new Map();
      for (const r of rows) {
        if (!rowsByNum.has(r.num)) rowsByNum.set(r.num, []);
        rowsByNum.get(r.num).push(r);
      }
      trackIdRows.push(...plan.idMapRows);
      const numbers = new Set(plan.idMapRows.filter((r) => ['tracker', 'report', 'tracker+report', 'reference'].includes(r.tipo)).map((r) => Number(r.antigo)));
      const reportNumbers = new Set(plan.idMapRows.filter((r) => ['report', 'tracker+report'].includes(r.tipo)).map((r) => Number(r.antigo)));
      return { track, base, numbers, reportNumbers, rowsByNum, rowExceptions: exc.rowExceptions, dupNums: exc.dupNums, trackerRev: new Map() };
    });
  } else {
    const rows = options.idMapRows;
    const letters = [...new Set(rows.filter((r) => r.tipo === 'block').map((r) => r.trilha))];
    tracks = letters.map((track) => {
      const rc = reverseContext(rows, track);
      return { track, base: rc.base, numbers: rc.numbers, trackerRev: rc.trackerRev };
    });
    for (const r of rows) {
      if (r.tipo !== 'spelling') continue;
      const d = JSON.parse(r.detalhe);
      spellings.set(spellingKey(d.path, d.kind, Number(r.novo), d.ordinal), r.antigo);
    }
  }
  const overrides = new Map();
  for (const raw of options.owners || []) {
    const m = String(raw).match(/^([\w.-]+:\d+)=([A-Z])$/);
    if (!m) throw new PlanError(`--owner must look like contacts.tsv:12=B, got ${raw}`);
    overrides.set(m[1], m[2]);
  }
  const result = planSharedCore(texts, { direction, tracks, overrides, spellings });
  if (direction === 'forward' && result.errors.length === 0) {
    const allRows = [...trackIdRows, ...result.idMapRows];
    const revTracks = tracks.map((t) => {
      const rc = reverseContext(allRows, t.track);
      return { track: t.track, base: rc.base, numbers: rc.numbers, trackerRev: rc.trackerRev };
    });
    const revSpell = new Map();
    for (const r of result.idMapRows.filter((x) => x.tipo === 'spelling')) {
      const d = JSON.parse(r.detalhe);
      revSpell.set(spellingKey(d.path, d.kind, Number(r.novo), d.ordinal), r.antigo);
    }
    const migrated = new Map([...texts].map(([k, v]) => [k, result.out.get(k) ?? v]));
    const back = planSharedCore(migrated, { direction: 'reverse', tracks: revTracks, overrides: new Map(), spellings: revSpell });
    for (const [name, text] of texts) {
      if ((back.out.get(name) ?? migrated.get(name)) !== text) result.errors.push(`round-trip check: shared ${name} differs after reverse`);
    }
  }
  const ops = [...result.out].map(([name, text]) => ({
    op: 'write', path: name, before: shas[name], after: sha256(Buffer.from(text, 'utf8')),
  }));
  return {
    mode: 'shared', direction, sharedDir,
    inputs: { sharedDir, reverse: direction === 'reverse' },
    fingerprint: sha256(JSON.stringify(shas)),
    ops, texts: result.out, idMapRows: result.idMapRows, counts: result.counts,
    errors: result.errors, warnings: result.warnings,
  };
}

// ---------------------------------------------------------------------------
// Plan files and apply.
// ---------------------------------------------------------------------------

function digestOf(plan) {
  return sha256(JSON.stringify({ fingerprint: plan.fingerprint, ops: plan.ops }));
}

/** Write plan.json, id-map.tsv and changes.tsv into `outDir`. */
export function writePlan(plan, outDir) {
  mkdirSync(outDir, { recursive: true });
  const doc = {
    tool: 'renumber-ids', version: PLAN_VERSION, mode: plan.mode, direction: plan.direction,
    track: plan.track ?? null, created: new Date().toISOString(),
    inputs: plan.inputs, fingerprint: plan.fingerprint, digest: digestOf(plan),
    counts: plan.counts, warnings: plan.warnings, ops: plan.ops,
  };
  if (plan.mode === 'shared') doc.payload = Object.fromEntries(plan.texts);
  writeFileSync(join(outDir, 'plan.json'), `${JSON.stringify(doc, null, 2)}\n`);
  writeFileSync(join(outDir, 'id-map.tsv'), formatIdMap(plan.idMapRows));
  const changes = ['tipo\tacao\tcaminho\tdestino'];
  for (const op of plan.ops) {
    if (op.op === 'rename') changes.push(`${op.from.split('/')[0]}\trename\t${op.from}\t${op.final}`);
    else changes.push(`${op.path.split('/')[0]}\t${op.op}\t${op.path}\t`);
  }
  writeFileSync(join(outDir, 'changes.tsv'), `${changes.join('\n')}\n`);
}

function trackApplyBlockers(root, trackerRel) {
  const reasons = [];
  const reportsDir = join(root, 'reports');
  if (existsSync(reportsDir)) {
    const live = readdirSync(reportsDir).filter((n) => RESERVED_RE.test(n));
    if (live.length) reasons.push(`report reservations are live: ${live.join(', ')}`);
  }
  const lockDir = trackerLockDirFor(canonicalizeTrackerPath(join(root, trackerRel)));
  if (existsSync(lockDir)) reasons.push(`the tracker lock is held: ${lockDir}`);
  const batchDir = join(root, 'batch');
  if (existsSync(batchDir)) {
    for (const name of readdirSync(batchDir).filter((n) => /^batch-state.*\.tsv$/.test(n))) {
      const lines = readFileSync(join(batchDir, name), 'utf8').split('\n');
      const statusCol = (lines[0] ?? '').split('\t').indexOf('status');
      if (statusCol === -1) continue;
      if (lines.slice(1).some((l) => l.split('\t')[statusCol] === 'processing')) {
        reasons.push(`batch/${name} has a row in processing`);
      }
    }
  }
  return { reasons, lockDir };
}

/** Execute a plan written by writePlan(). Returns a summary. */
export async function applyPlan(planPath) {
  const doc = JSON.parse(readFileSync(planPath, 'utf8'));
  if (doc.tool !== 'renumber-ids' || doc.version !== PLAN_VERSION) throw new PlanError(`${planPath} is not a renumber-ids plan`);
  if (doc.mode === 'shared') return applyShared(doc);
  const root = resolve(doc.inputs.root);
  const trackerRel = trackerRelFor(root);
  const { reasons, lockDir } = trackApplyBlockers(root, trackerRel);
  if (reasons.length) throw new PlanError(`refusing to apply:\n  ${reasons.join('\n  ')}`);
  const trackerLock = await acquireTrackerLock(lockDir, { timeoutMs: 2000, tracker: join(root, trackerRel) });
  let pipelineLock = null;
  try {
    pipelineLock = await acquirePipelineLock(join(root, PIPELINE_REL), { timeoutMs: 2000 });
    const plan = planTrack({ ...doc.inputs, reverse: doc.inputs.reverse });
    if (plan.errors.length) throw new PlanError(`plan no longer valid:\n  ${plan.errors.join('\n  ')}`);
    if (digestOf(plan) !== doc.digest) throw new PlanError('the track changed since the plan was written; plan again');
    for (const op of plan.ops) {
      const abs = join(root, op.path ?? op.from);
      if (op.op === 'write') {
        const mode = statSync(abs).mode & 0o7777;
        writeFileAtomic(abs, plan.texts.get(op.path));
        chmodSync(abs, mode);
      } else if (op.op === 'rename') {
        const target = join(root, op.to);
        if (existsSync(target)) throw new PlanError(`refusing to overwrite ${op.to}`);
        renameSyncWithRetry(abs, target);
      } else if (op.op === 'delete') {
        unlinkSync(abs);
      } else if (op.op === 'create') {
        if (existsSync(abs)) throw new PlanError(`refusing to overwrite ${op.path}`);
        writeFileAtomic(abs, op.content);
      }
    }
    return { mode: 'track', root, ops: plan.ops.length, counts: plan.counts };
  } finally {
    pipelineLock?.release();
    trackerLock.release();
  }
}

function applyShared(doc) {
  const sharedDir = resolve(doc.inputs.sharedDir);
  const { shas } = readSharedTexts(sharedDir);
  for (const op of doc.ops) {
    if (shas[op.path] !== op.before) throw new PlanError(`${op.path} changed since the plan was written; plan again`);
  }
  for (const op of doc.ops) {
    const abs = join(sharedDir, op.path);
    const mode = statSync(abs).mode & 0o7777;
    writeFileAtomic(abs, doc.payload[op.path]);
    chmodSync(abs, mode);
  }
  return { mode: 'shared', root: sharedDir, ops: doc.ops.length, counts: doc.counts };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  node renumber-ids.mjs plan --root <track> --track A --base 100000 --out <dir> [--ledger-assign N@YYYY-MM-DD=NEW ...]
  node renumber-ids.mjs plan --root <track> --reverse --id-map <id-map.tsv> [--track A] --out <dir>
  node renumber-ids.mjs shared --shared-dir <dir> --track A=<root>:100000 [...] --out <dir> [--owner FILE:LINE=TRACK ...] [--ledger-assign A:N@YYYY-MM-DD=NEW ...]
  node renumber-ids.mjs shared --shared-dir <dir> --reverse --id-map <file> [...] --out <dir>
  node renumber-ids.mjs apply --plan <dir>/plan.json`;

function flagValues(args, flag) {
  const out = [];
  args.forEach((a, i) => {
    if (a === flag && args[i + 1] !== undefined) out.push(args[i + 1]);
    else if (a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1));
  });
  return out;
}

const KNOWN_FLAGS = {
  plan: ['--root', '--track', '--base', '--out', '--ledger-assign', '--reverse', '--id-map'],
  shared: ['--shared-dir', '--track', '--out', '--owner', '--ledger-assign', '--reverse', '--id-map'],
  apply: ['--plan'],
};
const VALUE_FLAGS = new Set(['--root', '--track', '--base', '--out', '--ledger-assign', '--id-map', '--shared-dir', '--owner', '--plan']);

function checkFlags(cmd, args) {
  for (let i = 0; i < args.length; i++) {
    const name = args[i].split('=')[0];
    if (!KNOWN_FLAGS[cmd].includes(name)) throw new PlanError(`unknown option for ${cmd}: ${args[i]}\n${USAGE}`);
    if (VALUE_FLAGS.has(name) && !args[i].includes('=')) {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new PlanError(`${name} needs a value`);
      i++;
    }
  }
}

function printPlan(plan, outDir) {
  const byOp = {};
  for (const op of plan.ops) byOp[op.op] = (byOp[op.op] || 0) + 1;
  console.log(`renumber-ids ${plan.mode} ${plan.direction}${plan.track ? ` track ${plan.track}` : ''}: ${plan.ops.length} operations ${JSON.stringify(byOp)}`);
  for (const [k, v] of Object.entries(plan.counts).sort()) console.log(`  ${k}\t${v}`);
  for (const w of plan.warnings) console.log(`  warning: ${w}`);
  if (outDir) console.log(`plan written to ${outDir} (plan.json, id-map.tsv, changes.tsv)`);
}

async function runCli(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || !KNOWN_FLAGS[cmd]) {
    console.log(USAGE);
    return cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0;
  }
  checkFlags(cmd, args);
  if (cmd === 'apply') {
    const planPath = flagValue(args, '--plan');
    if (!planPath) throw new PlanError('apply needs --plan <plan.json>');
    const summary = await applyPlan(planPath);
    console.log(`applied ${summary.ops} operations to ${summary.root}`);
    for (const [k, v] of Object.entries(summary.counts).sort()) console.log(`  ${k}\t${v}`);
    if (summary.mode === 'track') console.log('data/applications.db is rebuilt from the tracker on the next tracker.mjs run.');
    return 0;
  }
  const outDir = flagValue(args, '--out');
  if (!outDir) throw new PlanError(`${cmd} needs --out <dir>`);
  const reverse = hasFlag(args, '--reverse');
  const idMapRows = reverse
    ? flagValues(args, '--id-map').flatMap((p) => parseIdMap(readFileSync(p, 'utf8')))
    : null;
  if (reverse && !idMapRows.length) throw new PlanError('--reverse needs --id-map <id-map.tsv>');
  let plan;
  if (cmd === 'plan') {
    const root = flagValue(args, '--root');
    if (!root) throw new PlanError('plan needs --root <track>');
    plan = planTrack({
      root, track: flagValue(args, '--track'), base: reverse ? null : Number(flagValue(args, '--base')),
      reverse, idMapRows, ledgerAssign: flagValues(args, '--ledger-assign'),
    });
  } else {
    const sharedDir = flagValue(args, '--shared-dir');
    if (!sharedDir) throw new PlanError('shared needs --shared-dir <dir>');
    const tracks = reverse ? null : flagValues(args, '--track').map((raw) => {
      const m = raw.match(/^([A-Z])=(.+):(\d+)$/);
      if (!m) throw new PlanError(`--track must look like A=~/dev/career-ops:100000, got ${raw}`);
      return { track: m[1], root: m[2].replace(/^~(?=\/|$)/, homedir()), base: Number(m[3]) };
    });
    if (!reverse && !tracks.length) throw new PlanError('shared needs one --track per installation');
    const ledgerAssign = {};
    for (const raw of flagValues(args, '--ledger-assign')) {
      const m = raw.match(/^([A-Z]):(.+)$/);
      if (!m) throw new PlanError(`shared --ledger-assign must be prefixed by the track, e.g. A:3244@2026-10-11=103255, got ${raw}`);
      (ledgerAssign[m[1]] ||= []).push(m[2]);
    }
    plan = planShared({ sharedDir, tracks, reverse, idMapRows, owners: flagValues(args, '--owner'), ledgerAssign });
  }
  if (plan.errors.length) {
    console.error(`renumber-ids: the plan has ${plan.errors.length} error(s); nothing was written`);
    for (const e of plan.errors) console.error(`  ${e}`);
    return 2;
  }
  writePlan(plan, resolve(outDir));
  printPlan(plan, resolve(outDir));
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof PlanError)) throw err;
    console.error(`renumber-ids: ${err.message}`);
    process.exitCode = 2;
  }
}
