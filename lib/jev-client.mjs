/**
 * jev-client.mjs — thin client for TypeSafe's Jev "System One" judgment model.
 *
 * Jev returns a typed decision plus a calibrated probability, not prose. Three
 * primitives, mirrored here as three helpers:
 *   - Choice — pick one of N named options (jevChoice)
 *   - Score  — position on an ordered ladder of levels (jevScore)
 *   - Noul   — probability that a yes/no statement is true (jevNoul)
 *
 * A fourth helper, `jevAsk`, sends a whole MAP of those questions about one
 * state in a single request — the fan-out primitive. Jev answers every
 * question in the map in parallel, so a many-question judgment costs one
 * round trip and one copy of the state rather than one of each per question.
 *
 * This module is the shared opt-in surface every Jev consumer in career-ops
 * builds on. It is disabled by default: with no TYPESAFE_API_KEY set,
 * isJevEnabled() is false and every helper resolves `{ enabled: false, ... }`
 * without making a network call, so a caller's existing deterministic logic
 * is the only thing that ever runs. This mirrors the safe opt-in pattern from
 * career-ops-hq/career-ops#4289: gated entirely behind an API key, and a
 * low-confidence answer is reported as such rather than guessed — the caller
 * decides whether to fall back, this client never silently picks a default.
 *
 * Untrusted text (job titles, JD text, resume content) belongs only in the
 * `state` argument, which Jev treats as the subject being judged. It is never
 * concatenated into `instructions` or option/level labels, which are authored
 * by the caller and describe the judgment itself.
 */

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Whether a Jev API key is configured. Every helper below checks this itself,
 * so callers only need it to decide whether to skip building a state/options
 * payload at all before an unconditional call.
 *
 * @returns {boolean}
 */
export function isJevEnabled() {
  return typeof process.env.TYPESAFE_API_KEY === 'string' && process.env.TYPESAFE_API_KEY.length > 0;
}

/**
 * POST a whole question map to the Jev endpoint in ONE request and return the
 * raw answers, or a `{ ok: false }` result each caller turns into its own
 * fallback shape. Not exported — `jevAsk` and the three single-question
 * helpers are the public surface.
 *
 * The wire format keys `questions` by question id (a map, not an array) and
 * has no top-level `stateFormat` field — see docs.typesafe.ai/api.md. Every
 * question in the map is judged against the same `state`, in parallel,
 * server-side: N typed judgments cost one round trip and one copy of the
 * state, not N of each.
 *
 * @param {string} state - Untrusted subject text.
 * @param {Record<string, {type: string, instructions: string, criteria?: object|string[]}>} questions
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: true, answers: object, usage: object|null} | {ok: false, disabled?: boolean, error: string}>}
 */
async function postJev(state, questions, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    return { ok: false, disabled: true, error: 'TYPESAFE_API_KEY not set' };
  }

  let res;
  try {
    res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: JEV_MODEL,
        state,
        questions,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, disabled: false, error: `Jev request failed: ${err?.message || String(err)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, disabled: false, error: `Jev HTTP ${res.status}: ${body.slice(0, 300)}` };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, disabled: false, error: `Jev response was not valid JSON: ${err?.message || String(err)}` };
  }

  if (!data?.answers || typeof data.answers !== 'object') {
    return { ok: false, disabled: false, error: 'Jev response did not contain an answers object' };
  }
  return { ok: true, answers: data.answers, usage: data.usage ?? null };
}

/**
 * Single-question convenience over `postJev`, preserving the one-answer shape
 * the three helpers below were written against.
 *
 * @param {string} state - Untrusted subject text.
 * @param {{id: string, type: string, instructions: string, criteria?: object|string[]}} question
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: true, answer: object} | {ok: false, disabled?: boolean, error: string}>}
 */
async function askJev(state, question, opts) {
  const { id, ...rest } = question;
  const result = await postJev(state, { [id]: rest }, opts);
  if (!result.ok) return result;
  const answer = result.answers[id];
  if (!answer || typeof answer !== 'object') {
    return { ok: false, disabled: false, error: 'Jev response did not contain an answer object' };
  }
  return { ok: true, answer };
}

/**
 * Normalize one raw choice answer into the `jevChoice` return shape.
 *
 * @param {object} answer - Raw answer object from the API.
 * @param {Record<string, string>} options - The options offered, for validation.
 * @returns {{enabled: boolean, choice: string|null, confidence: number, probabilities: object|null, error?: string}}
 */
function normalizeChoice(answer, options) {
  if (typeof answer.choice !== 'string' || !(answer.choice in options)) {
    return { enabled: true, choice: null, confidence: 0, probabilities: null, error: 'Jev choice answer was missing or not one of the offered options' };
  }
  return {
    enabled: true,
    choice: answer.choice,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : 0,
    probabilities: answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : null,
  };
}

/**
 * Normalize one raw score answer into the `jevScore` return shape.
 *
 * @param {object} answer - Raw answer object from the API.
 * @returns {{enabled: boolean, score: number|null, confidence: number, probabilities: object|null, error?: string}}
 */
function normalizeScore(answer) {
  if (typeof answer.score !== 'number') {
    return { enabled: true, score: null, confidence: 0, probabilities: null, error: 'Jev score answer was missing a numeric score' };
  }
  return {
    enabled: true,
    score: answer.score,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : 0,
    probabilities: answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : null,
  };
}

/**
 * Normalize one raw noul answer into the `jevNoul` return shape.
 *
 * @param {object} answer - Raw answer object from the API.
 * @returns {{enabled: boolean, probability: number|null, error?: string}}
 */
function normalizeNoul(answer) {
  if (typeof answer.noul !== 'number') {
    return { enabled: true, probability: null, error: 'Jev noul answer was missing a numeric probability' };
  }
  return { enabled: true, probability: answer.noul };
}

/**
 * Choice — ask Jev to pick exactly one of the named options.
 *
 * @param {object} args
 * @param {string} args.state - Untrusted subject text (never instructions).
 * @param {string} args.instructions - What to decide, in the caller's own words.
 * @param {Record<string, string>} args.options - option label -> description map (2+ entries); sent on the wire as `criteria`.
 * @param {string} [args.id] - Question id; defaults to 'choice'.
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ enabled: boolean, choice: string|null, confidence: number, probabilities: Record<string, number>|null, error?: string }>}
 */
export async function jevChoice({ state, instructions, options, id = 'choice', timeoutMs } = {}) {
  if (!isJevEnabled()) {
    return { enabled: false, choice: null, confidence: 0, probabilities: null };
  }
  if (typeof state !== 'string' || typeof instructions !== 'string' || !options || typeof options !== 'object' || Object.keys(options).length < 2) {
    throw new TypeError('jevChoice requires state, instructions, and an options map with at least two entries');
  }

  const result = await askJev(state, { id, type: 'choice', instructions, criteria: options }, { timeoutMs });
  if (!result.ok) {
    return { enabled: true, choice: null, confidence: 0, probabilities: null, error: result.error };
  }

  return normalizeChoice(result.answer, options);
}

/**
 * Score — ask Jev for a position on an ordered ladder of levels.
 *
 * @param {object} args
 * @param {string} args.state - Untrusted subject text.
 * @param {string} args.instructions - What to score, in the caller's own words.
 * @param {string[]} args.levels - Ordered levels, lowest first (2+ entries); sent on the wire as `criteria`.
 * @param {string} [args.id] - Question id; defaults to 'score'.
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ enabled: boolean, score: number|null, confidence: number, probabilities: Record<string, number>|null, error?: string }>}
 */
export async function jevScore({ state, instructions, levels, id = 'score', timeoutMs } = {}) {
  if (!isJevEnabled()) {
    return { enabled: false, score: null, confidence: 0, probabilities: null };
  }
  if (typeof state !== 'string' || typeof instructions !== 'string' || !Array.isArray(levels) || levels.length < 2) {
    throw new TypeError('jevScore requires state, instructions, and an ordered levels array with at least two entries');
  }

  const result = await askJev(state, { id, type: 'score', instructions, criteria: levels }, { timeoutMs });
  if (!result.ok) {
    return { enabled: true, score: null, confidence: 0, probabilities: null, error: result.error };
  }

  return normalizeScore(result.answer);
}

/**
 * Noul — ask Jev for the probability that a yes/no statement is true.
 *
 * @param {object} args
 * @param {string} args.state - Untrusted subject text.
 * @param {string} args.instructions - The yes/no statement to judge, in the caller's own words.
 * @param {string} [args.whenTrue] - Optional clarifying description of the "true" case; sent on the wire as `criteria.true`.
 * @param {string} [args.whenFalse] - Optional clarifying description of the "false" case; sent on the wire as `criteria.false`.
 * @param {string} [args.id] - Question id; defaults to 'noul'.
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ enabled: boolean, probability: number|null, error?: string }>}
 */
export async function jevNoul({ state, instructions, whenTrue, whenFalse, id = 'noul', timeoutMs } = {}) {
  if (!isJevEnabled()) {
    return { enabled: false, probability: null };
  }
  if (typeof state !== 'string' || typeof instructions !== 'string') {
    throw new TypeError('jevNoul requires state and instructions');
  }

  const question = { id, type: 'noul', instructions };
  if (whenTrue !== undefined || whenFalse !== undefined) {
    question.criteria = {};
    if (whenTrue !== undefined) question.criteria.true = whenTrue;
    if (whenFalse !== undefined) question.criteria.false = whenFalse;
  }

  const result = await askJev(state, question, { timeoutMs });
  if (!result.ok) {
    return { enabled: true, probability: null, error: result.error };
  }

  return normalizeNoul(result.answer);
}

/**
 * Per-question fallback in the shape that question's type normally returns,
 * so a caller can read `answers[id]` the same way whether the request
 * succeeded, was disabled, or failed.
 *
 * @param {string} type - 'choice' | 'score' | 'noul'.
 * @param {{enabled: boolean, error?: string}} extra
 * @returns {object}
 */
function emptyAnswer(type, extra) {
  if (type === 'noul') return { probability: null, ...extra };
  if (type === 'score') return { score: null, confidence: 0, probabilities: null, ...extra };
  return { choice: null, confidence: 0, probabilities: null, ...extra };
}

/**
 * Ask MANY typed questions about ONE state in a single request — the fan-out
 * primitive. Jev judges every question in the map against the same state, in
 * parallel, so a 20-question evaluation costs one round trip and sends the
 * (potentially large) state once instead of twenty times.
 *
 * Never throws on transport problems: a disabled client, a network failure or
 * a malformed response resolves to an answers map whose every entry carries
 * the same `enabled`/`error` fields the single-question helpers use, so the
 * caller decides what to fall back to. Argument errors still throw — those are
 * caller bugs, not runtime conditions.
 *
 * @param {object} args
 * @param {string} args.state - Untrusted subject text (never instructions).
 * @param {Record<string, {type: 'choice'|'score'|'noul', instructions: string, options?: Record<string, string>, levels?: string[], whenTrue?: string, whenFalse?: string}>} args.questions
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{enabled: boolean, usage: object|null, error?: string, answers: Record<string, object>}>}
 */
export async function jevAsk({ state, questions, timeoutMs } = {}) {
  if (typeof state !== 'string' || !questions || typeof questions !== 'object' || Object.keys(questions).length === 0) {
    throw new TypeError('jevAsk requires state and a non-empty questions map');
  }

  const wire = {};
  for (const [id, spec] of Object.entries(questions)) {
    const { type, instructions } = spec || {};
    if (typeof instructions !== 'string') {
      throw new TypeError(`jevAsk question "${id}" requires instructions`);
    }
    if (type === 'choice') {
      if (!spec.options || typeof spec.options !== 'object' || Object.keys(spec.options).length < 2) {
        throw new TypeError(`jevAsk choice question "${id}" requires an options map with at least two entries`);
      }
      wire[id] = { type, instructions, criteria: spec.options };
    } else if (type === 'score') {
      if (!Array.isArray(spec.levels) || spec.levels.length < 2) {
        throw new TypeError(`jevAsk score question "${id}" requires an ordered levels array with at least two entries`);
      }
      wire[id] = { type, instructions, criteria: spec.levels };
    } else if (type === 'noul') {
      wire[id] = { type, instructions };
      if (spec.whenTrue !== undefined || spec.whenFalse !== undefined) {
        wire[id].criteria = {};
        if (spec.whenTrue !== undefined) wire[id].criteria.true = spec.whenTrue;
        if (spec.whenFalse !== undefined) wire[id].criteria.false = spec.whenFalse;
      }
    } else {
      throw new TypeError(`jevAsk question "${id}" has unknown type "${type}"`);
    }
  }

  const fill = (extra) => {
    const answers = {};
    for (const [id, spec] of Object.entries(questions)) answers[id] = emptyAnswer(spec.type, extra);
    return answers;
  };

  if (!isJevEnabled()) {
    return { enabled: false, usage: null, answers: fill({ enabled: false }) };
  }

  const result = await postJev(state, wire, { timeoutMs });
  if (!result.ok) {
    return { enabled: true, usage: null, error: result.error, answers: fill({ enabled: true, error: result.error }) };
  }

  const answers = {};
  for (const [id, spec] of Object.entries(questions)) {
    const raw = result.answers[id];
    if (!raw || typeof raw !== 'object') {
      answers[id] = emptyAnswer(spec.type, { enabled: true, error: `Jev returned no answer for "${id}"` });
      continue;
    }
    if (spec.type === 'choice') answers[id] = normalizeChoice(raw, spec.options);
    else if (spec.type === 'score') answers[id] = normalizeScore(raw);
    else answers[id] = normalizeNoul(raw);
  }
  return { enabled: true, usage: result.usage, answers };
}
