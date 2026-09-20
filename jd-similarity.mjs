#!/usr/bin/env node
/**
 * jd-similarity.mjs — deterministic CV reuse recommendation for similar JDs.
 *
 * This is deliberately a recommendation layer. It never evaluates a JD and
 * never deletes or overwrites an existing CV.
 *
 * Usage:
 *   node jd-similarity.mjs new-jd.txt previous-jd-or-cv.txt
 */

import { readFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import { isJevEnabled, jevChoice } from './lib/jev-client.mjs';

const STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'that', 'this', 'have', 'will', 'you',
  'your', 'our', 'are', 'not', 'to', 'of', 'in', 'on', 'or', 'a', 'an',
  '负责', '岗位', '工作', '相关', '具备', '以及', '能够', '进行', '通过', '需要',
]);

const LEVELS = [
  ['intern', '实习', '实习生', '应届'],
  ['junior', '初级'],
  ['mid', '中级'],
  ['senior', '高级', '资深'],
  ['staff', 'principal', 'lead', '负责人'],
];

/** Tokenize JD/CV text into normalized, stop-word-filtered terms. */
export function tokenize(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .match(/[\p{L}\p{N}+#./-]+/gu)
      ?.map(token => token.replace(/^[./-]+|[./-]+$/g, ''))
      .filter(token => token && (token.length > 1 || /\d/.test(token)) && !STOP_WORDS.has(token)) || [],
  );
}

/** Calculate Jaccard similarity between two texts or token sets. */
export function jaccardSimilarity(left, right) {
  const a = left instanceof Set ? left : tokenize(left);
  const b = right instanceof Set ? right : tokenize(right);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Level words that are also ordinary English, mapped to the words that follow
 * them in their NON-seniority sense. JD boilerplate is full of these: "Principal
 * responsibilities" means "main duties", "mid-market" is a customer segment, and
 * "lead" is usually a verb. Matching them as job levels made the gate below fire
 * on postings of identical seniority.
 *
 * Only the trailing word is inspected: "Principal Engineer" and "Lead Engineer"
 * stay levels because `engineer` is not in any of these lists.
 */
const NON_LEVEL_FOLLOWERS = {
  principal: ['responsibilities', 'responsibility', 'duties', 'accountabilities', 'objectives', 'purpose', 'tasks', 'activities'],
  lead: ['to', 'the', 'a', 'an', 'our', 'and', 'or', 'by', 'on', 'in', 'for', 'with', 'from', 'mentoring', 'projects'],
  mid: ['market', 'size', 'sized', 'cap', 'tier', 'funnel', 'term', 'sized-company'],
};

/** Whether a level word at `index` reads as a job level rather than plain English. */
function readsAsLevel(word, normalized, index) {
  const followers = NON_LEVEL_FOLLOWERS[word];
  if (!followers) return true;
  const after = normalized.slice(index + word.length).match(/^[^a-z0-9]*([a-z0-9-]+)/);
  return !after || !followers.includes(after[1]);
}

/**
 * Every distinct seniority level named in the text, as LEVELS indices.
 *
 * Returns ALL of them rather than the first: a document may name several (a CV
 * showing career progression names each rank it held), and `findIndex` used to
 * collapse that to whichever appeared earliest in the LEVELS table — reading a
 * junior-to-senior CV as junior.
 */
function levelsIn(text) {
  const normalized = String(text ?? '').toLowerCase();
  const found = new Set();
  LEVELS.forEach((words, level) => {
    for (const word of words) {
      if (/^[\p{Script=Han}]+$/u.test(word)) {
        if (normalized.includes(word)) { found.add(level); break; }
        continue;
      }
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?:^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`, 'gi');
      let match;
      while ((match = pattern.exec(normalized)) !== null) {
        if (readsAsLevel(word, normalized, match.index + match[0].length - word.length)) {
          found.add(level);
          break;
        }
      }
      if (found.has(level)) break;
    }
  });
  return found;
}

/**
 * Detect the seniority level of a document, or -1 when it has no single
 * unambiguous one. Naming several levels counts as ambiguous, NOT as the lowest
 * one: the gate below exists to catch a clear level difference, and a guess is
 * worse than standing down and letting the similarity score decide.
 */
function levelOf(text) {
  const levels = levelsIn(text);
  return levels.size === 1 ? [...levels][0] : -1;
}

/** Return whether the new JD and previous document have different seniority levels. */
export function hardMismatch(newJd, previousText) {
  const newLevel = levelOf(newJd);
  const previousLevel = levelOf(previousText);
  return newLevel >= 0 && previousLevel >= 0 && newLevel !== previousLevel;
}

/** Recommend CV reuse, reuse with edits, or regeneration for a new JD. */
export function recommendCvReuse(newJd, previousText, options = {}) {
  const score = jaccardSimilarity(newJd, previousText);
  const high = Number(options.highThreshold ?? 0.72);
  const medium = Number(options.mediumThreshold ?? 0.45);
  if (hardMismatch(newJd, previousText)) {
    return { decision: 'regenerate', score, reason: 'level-mismatch' };
  }
  if (score >= high) return { decision: 'reuse', score, reason: 'high-similarity' };
  if (score >= medium) return { decision: 'reuse-with-edits', score, reason: 'medium-similarity' };
  return { decision: 'regenerate', score, reason: 'low-similarity' };
}

// ── Jev-backed reuse recommendation (opt-in via TYPESAFE_API_KEY) ────
//
// recommendCvReuse() above is unchanged and stays the only path used when
// TYPESAFE_API_KEY is unset: Jaccard similarity, the LEVELS detector, and
// the hard-mismatch gate all keep deciding on their own.

const DEFAULT_JEV_CONFIDENCE_THRESHOLD = 0.6;

function resolveConfidenceThreshold(raw) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_JEV_CONFIDENCE_THRESHOLD;
}

const JEV_REUSE_OPTIONS = {
  reuse: 'The two documents describe close enough roles, at the same seniority, that the previous CV/resume can be reused as-is.',
  'reuse-with-edits': 'The previous CV/resume overlaps enough to reuse as a base, but the new JD needs some tailoring first.',
  regenerate: 'The two documents are different enough — including describing different seniority levels — that a fresh CV/resume should be generated instead of reused.',
};

const JEV_REUSE_INSTRUCTIONS = 'Whether the candidate should reuse their previous CV/resume as-is (reuse), reuse it ' +
  'with edits, or regenerate a fresh one, for the NEW JD given the PREVIOUS JD/CV also given in state. A seniority-' +
  'level mismatch between the two always means regenerate, per the option descriptions.';

/**
 * Jev-aware CV reuse recommendation. The hard seniority-mismatch gate always
 * wins (mirrors #4289's rule that a real level difference is never
 * overridden): when recommendCvReuse() already reports 'level-mismatch',
 * that decision stands unconditionally. Otherwise Jev gets a second opinion
 * on the Jaccard-based decision, applied only when its confidence clears the
 * threshold. With TYPESAFE_API_KEY unset, on any error, or below threshold,
 * this resolves to exactly what recommendCvReuse(newJd, previousText,
 * options) returns.
 *
 * @param {string} newJd
 * @param {string} previousText
 * @param {{ highThreshold?: number, mediumThreshold?: number, confidenceThreshold?: number }} [options]
 * @returns {Promise<{decision: string, score: number, reason: string, confidence?: number}>}
 */
export async function recommendCvReuseAsync(newJd, previousText, options = {}) {
  const deterministic = recommendCvReuse(newJd, previousText, options);
  if (!isJevEnabled() || deterministic.reason === 'level-mismatch') return deterministic;

  const threshold = resolveConfidenceThreshold(options.confidenceThreshold ?? process.env.JEV_REUSE_CONFIDENCE_THRESHOLD);
  const state = `NEW JD:\n${newJd}\n\nPREVIOUS JD/CV:\n${previousText}`;
  const result = await jevChoice({ state, instructions: JEV_REUSE_INSTRUCTIONS, options: JEV_REUSE_OPTIONS, id: 'cv-reuse' });
  if (result.choice === null || result.confidence < threshold) return deterministic;

  return { decision: result.choice, score: deterministic.score, reason: 'jev', confidence: result.confidence };
}

// ── CLI ─────────────────────────────────────────────────────────────

const KNOWN_FLAGS = ['--help', '-h'];

const USAGE = `Usage:
  node jd-similarity.mjs new-jd.txt previous-jd-or-cv.txt
  node jd-similarity.mjs --help                    # print this usage block and exit`;

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const unknownFlags = args.filter(a => a.startsWith('-') && !KNOWN_FLAGS.includes(a));
  if (unknownFlags.length) {
    console.error(`Error: unrecognized flag(s): ${unknownFlags.join(', ')}. Valid flags: ${KNOWN_FLAGS.join(', ')}`);
    console.error(USAGE);
    process.exit(1);
  }
  const [newJdPath, previousPath] = args;
  if (args.length !== 2 || !newJdPath || !previousPath) {
    console.error('Error: expected two file paths.');
    console.error(USAGE);
    process.exit(1);
  }

  return { newJdPath, previousPath };
}

if (isMainModule(import.meta.url)) {
  const { newJdPath, previousPath } = parseArgs(process.argv);
  try {
    const result = await recommendCvReuseAsync(readFileSync(newJdPath, 'utf8'), readFileSync(previousPath, 'utf8'));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Unable to read input files: ${error.message}`);
    process.exit(1);
  }
}
