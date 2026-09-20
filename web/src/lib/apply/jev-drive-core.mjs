// jev-drive-core.mjs — pure decision core for the Jev-driven apply loop.
//
// No Playwright, no DOM, no filesystem: this module is plain, dependency-free
// JS on purpose, so it can be imported BOTH by web/src/lib/apply/jev-drive.ts
// (the Next/Playwright glue, via an explicit ".mjs" specifier TS resolves
// under "allowJs") AND directly by a plain `node` script or test — something
// the surrounding apply/*.ts files can't do, because their extensionless
// relative imports only resolve under Next's bundler, not under plain Node
// ESM. Keeping the logic that actually needs verifying in here, instead of in
// the Playwright glue, is what makes it independently testable at all.
//
// Conventions mirror the repo-root lib/jev-client.mjs (same TypeSafe System
// One endpoint/wire format, same "untrusted content only ever lives in
// `state`, never in `instructions`/`criteria` labels" rule, same "disabled by
// default, no key means the network is never touched" contract). It is a
// fresh, small implementation rather than an import of that file because
// web/ is a deliberately separate package (see web/next.config.mjs) that does
// not reach into the repo-root lib/.

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 20_000;

/** The Jev loop's fixed action vocabulary. TYPE_TEXT/SELECT are only ever
 *  offered for goal "full" (goal "reach" only navigates, never fills).
 *  SUBMIT is additionally offered ONLY when the caller explicitly opts into
 *  full-autonomous mode AND has already run its own out-of-band pre-submit
 *  verification for this turn (see buildDecisionRequest's `submitAllowed`
 *  param and web/scripts/ab-jev-apply.mjs) — every existing caller that never
 *  passes that flag keeps the exact never-submit vocabulary/behavior. */
export const OPERATIONS = ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL', 'WAIT', 'DONE', 'BLOCKED', 'SUBMIT'];

/** Opt-in gate: identical shape to lib/jev-client.mjs's isJevEnabled(), kept
 *  local because web/ does not import that file (see module docstring). */
export function isJevDriveEnabled() {
  return typeof process.env.TYPESAFE_API_KEY === 'string' && process.env.TYPESAFE_API_KEY.length > 0;
}

// Never-submit / never-auto-consent invariant for the Jev loop specifically.
// Deliberately a SEPARATE pattern from drive.ts's own SUBMIT_RX (used by the
// claude -p planner) rather than a shared export: the planner path must stay
// byte-identical when TYPESAFE_API_KEY is unset, so nothing here may ever be
// imported into that code path.
export const SUBMIT_RX =
  /\b(submit|send application|finish( application)?|complete application|apply (and|&) submit|register|sign[\s-]?up|create account|enviar|finalizar)\b/i;
export const CONSENT_RX =
  /\b(i agree|i consent|consent to|terms of (service|use)|privacy polic(y|ies)|gdpr|acknowledge (that|the)|accept the)\b/i;

/** Classify one scanned DOM control into a targetable kind. Kept OUT of the
 *  page.evaluate() callback that scans the page — Playwright serializes that
 *  callback to a string with no closure access, so putting classification
 *  here (not duplicated inline) keeps SUBMIT_RX/CONSENT_RX/this function the
 *  single source of truth for both the scan and the runtime click-guard. */
export function classifyElement({ tag, itype, role }) {
  const t = (tag || '').toLowerCase();
  const it = (itype || '').toLowerCase();
  const r = (role || '').toLowerCase();
  if (t === 'select' || r === 'combobox' || r === 'listbox') return 'select';
  if (t === 'textarea' || r === 'textbox' || r === 'contenteditable' || (t === 'input' && !['checkbox', 'radio', 'submit', 'button', 'image', 'reset', 'hidden', 'file'].includes(it))) {
    return 'type';
  }
  return 'click'; // a / button / [role=button|link] / checkbox / radio / submit-ish inputs
}

/** Which candidates the loop must never be OFFERED as a target — separate
 *  from `classifyElement`'s structural kind because a control can be
 *  structurally clickable yet unsafe/unusable for this loop specifically:
 *  a file input opens a native OS picker (would hang headed automation, and
 *  attachments are handled by a separate deterministic fill step per
 *  session.ts's fillSession), a submit-looking control is the never-submit
 *  invariant, and a consent checkbox is never auto-checked. */
export function classifyBlocked({ tag, itype, role, label }, kind) {
  const it = (itype || '').toLowerCase();
  if (it === 'file') return 'file';
  if (kind === 'click' && (SUBMIT_RX.test(label || '') || it === 'submit')) return 'submit';
  if ((it === 'checkbox' || (role || '').toLowerCase() === 'checkbox') && CONSENT_RX.test(label || '')) return 'consent';
  return undefined;
}

/**
 * Build the ONE fan-out request for a single step: one `operation` choice plus
 * one target choice per targetable operation actually on offer this turn. This
 * is the "ONE Jev request per step picks both operation and target" contract —
 * everything the page/ATS produced (labels, url, title, history) lives in
 * `state` (untrusted); only the caller-authored description of the fixed
 * action vocabulary lives in `criteria`.
 *
 * `submitAllowed` is the full-autonomous opt-in: every existing caller omits
 * it (defaults false) and gets the byte-identical never-submit vocabulary —
 * SUBMIT is only ever added to `operationCriteria`/`questions` when the
 * caller passes `submitAllowed: true` for goal "full" AND a submit-classified
 * ref (`blocked === 'submit'`) is actually present on screen. The caller is
 * responsible for only ever setting this after its own pre-submit
 * verification has passed (see web/scripts/ab-jev-apply.mjs).
 *
 * @param {{goal: "reach"|"full", url: string, title: string, refs: Array<{ref: string, kind: "click"|"type"|"select", label: string, blocked?: string}>, answersProvided: boolean, historyTail?: string[], submitAllowed?: boolean}} params
 */
export function buildDecisionRequest({ goal, url, title, refs, answersProvided, historyTail = [], submitAllowed = false }) {
  const clickable = refs.filter((r) => r.kind === 'click' && !r.blocked);
  // `!r.blocked` additionally excludes a ref the caller marked unusable after
  // the scan (e.g. ab-jev-apply.mjs annotating a "no canonical answer" gap as
  // `blocked: 'no-data'` so Jev is never offered it twice) — classifyBlocked()
  // itself never blocks a type/select kind today, so this is a no-op for
  // every existing caller.
  const typeable = goal === 'full' ? refs.filter((r) => r.kind === 'type' && !r.blocked) : [];
  const selectable = goal === 'full' ? refs.filter((r) => r.kind === 'select' && !r.blocked) : [];
  const submittable = goal === 'full' && submitAllowed ? refs.filter((r) => r.kind === 'click' && r.blocked === 'submit') : [];

  const operationCriteria = {
    SCROLL: 'Scroll down to reveal more of the page or form.',
    WAIT: 'Wait briefly for the page to finish loading or settling before acting again.',
    DONE:
      goal === 'reach'
        ? 'The fillable application form (with name/email/resume-type fields) is now visible on screen — stop driving.'
        : submittable.length
          ? 'Every field with a matching candidate answer is filled, but a SUBMIT control is available — prefer SUBMIT over DONE in that case.'
          : 'Every field with a matching candidate answer is filled and you are on the final page — stop; the human submits, never you.',
    BLOCKED:
      'You cannot safely proceed without a human: the only remaining actionable control is a submit/register/consent control, or you hit a login wall, captcha, or dead end.',
  };
  if (clickable.length) operationCriteria.CLICK = "Click a navigation, expand, or Next/Continue/Apply control to make progress toward the goal.";
  if (typeable.length) operationCriteria.TYPE_TEXT = "Fill one of the candidate's provided answers into a matching text field, one field at a time.";
  if (selectable.length) operationCriteria.SELECT = 'Choose an option in a dropdown or combobox field.';
  if (submittable.length) {
    operationCriteria.SUBMIT =
      'Click the final Submit/Send Application control. Choose this ONLY when every required field is filled and has already been independently verified correct, and this is truly the last step.';
  }

  const questions = {
    operation: {
      type: 'choice',
      instructions: submittable.length
        ? 'Choose the single next browser operation that makes progress toward the goal. You are authorized to choose SUBMIT for the final submit control once every field is filled and verified. Never choose an operation that would register or check a legal consent box yourself — those situations are BLOCKED.'
        : 'Choose the single next browser operation that makes progress toward the goal. Never choose an operation that would submit, register, or check a legal consent box yourself — those situations are BLOCKED.',
      criteria: operationCriteria,
    },
  };
  if (clickable.length) {
    questions.click_target = {
      type: 'choice',
      instructions: "Which element ref should CLICK act on? Prefer 'Apply'/'Next'/'Continue'/expand controls over anything already visited this session.",
      criteria: { none_of_the_above: 'no clickable ref applies', ...Object.fromEntries(clickable.map((r) => [r.ref, `${r.kind} control: "${r.label}"`])) },
    };
  }
  if (typeable.length) {
    questions.type_target = {
      type: 'choice',
      instructions: 'Which text field ref should be filled next? Pick one that is not already correctly filled.',
      criteria: { none_of_the_above: 'no text field applies', ...Object.fromEntries(typeable.map((r) => [r.ref, `text field: "${r.label}"`])) },
    };
  }
  if (selectable.length) {
    questions.select_target = {
      type: 'choice',
      instructions: 'Which dropdown/combobox ref should be set next?',
      criteria: { none_of_the_above: 'no select field applies', ...Object.fromEntries(selectable.map((r) => [r.ref, `select field: "${r.label}"`])) },
    };
  }
  if (submittable.length) {
    questions.submit_target = {
      type: 'choice',
      instructions: 'Which ref is the final Submit/Send Application control?',
      criteria: { none_of_the_above: 'no submit ref applies', ...Object.fromEntries(submittable.map((r) => [r.ref, `submit control: "${r.label}"`])) },
    };
  }

  const state = JSON.stringify({
    goal:
      goal === 'reach'
        ? 'Navigate to the fillable job application form. Do not fill anything yet.'
        : submittable.length
          ? "Fill every visible field on this job application form from the candidate's answers, across pages if needed, then submit it. Never register or check a consent box yourself."
          : "Fill every visible field on this job application form from the candidate's answers, across pages if needed. Never submit, never register, never check a consent box.",
    url,
    title,
    elements: refs.map((r) => `[${r.ref}] ${r.kind}${r.blocked ? ` (${r.blocked}, not selectable)` : ''} "${r.label}"`).join('\n'),
    candidateHasAnswers: answersProvided,
    recentActions: historyTail,
  });

  return { state, questions, operationCriteria };
}

/**
 * POST one fan-out request to TypeSafe's Jev endpoint. Never throws: a
 * disabled client, a network failure, an HTTP error, or a malformed response
 * all resolve to `null` and the caller decides the fallback — the same
 * contract as postJev() in the repo-root lib/jev-client.mjs.
 *
 * `onUsage`, when given, is invoked once per successful response with the
 * endpoint's raw `usage` object (or `null` if the endpoint didn't send one)
 * — an optional metrics seam (see web/scripts/ab-jev-apply.mjs) that never
 * changes this function's return value or existing callers' behavior.
 *
 * @param {string} state
 * @param {Record<string, {type: 'choice', instructions: string, criteria: Record<string, string>}>} questions
 * @param {{timeoutMs?: number, onUsage?: (usage: object|null) => void}} [opts]
 * @returns {Promise<Record<string, {choice: string|null}>|null>}
 */
export async function postJevChoices(state, questions, { timeoutMs = DEFAULT_TIMEOUT_MS, onUsage } = {}) {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  let res;
  try {
    res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (!data?.answers || typeof data.answers !== 'object') return null;
  if (typeof onUsage === 'function') {
    try {
      onUsage(data.usage ?? null);
    } catch {
      /* metrics collection must never break the decision loop */
    }
  }
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const ans = data.answers[id];
    out[id] = { choice: ans && typeof ans === 'object' && typeof ans.choice === 'string' && ans.choice in q.criteria ? ans.choice : null };
  }
  return out;
}

/**
 * Turn one fan-out response into a single typed step decision. `request`
 * defaults to the real network call (postJevChoices); tests/scripts inject a
 * fake one — the same dependency-injection seam jev-ag-eval.mjs's
 * `evaluateWithJevFanout({ ask })` uses — so the decision LOGIC (which
 * operation/target is valid given the refs on screen) is exercised with zero
 * network dependency, while the real path is still what ships.
 *
 * @returns {Promise<{operation: string, ref?: string, reason?: string}>}
 */
export async function decideStep(params, request = postJevChoices) {
  const { state, questions, operationCriteria } = buildDecisionRequest(params);
  const answers = await request(state, questions);
  if (!answers) return { operation: 'BLOCKED', reason: 'Jev decision request failed or is disabled' };
  const opChoice = answers.operation?.choice;
  if (!opChoice || !(opChoice in operationCriteria)) return { operation: 'BLOCKED', reason: 'Jev returned no valid operation' };
  if (opChoice === 'CLICK') {
    const t = answers.click_target?.choice;
    if (!t || t === 'none_of_the_above') return { operation: 'BLOCKED', reason: 'Jev chose CLICK with no valid target' };
    return { operation: 'CLICK', ref: t };
  }
  if (opChoice === 'TYPE_TEXT') {
    const t = answers.type_target?.choice;
    if (!t || t === 'none_of_the_above') return { operation: 'BLOCKED', reason: 'Jev chose TYPE_TEXT with no valid target' };
    return { operation: 'TYPE_TEXT', ref: t };
  }
  if (opChoice === 'SELECT') {
    const t = answers.select_target?.choice;
    if (!t || t === 'none_of_the_above') return { operation: 'BLOCKED', reason: 'Jev chose SELECT with no valid target' };
    return { operation: 'SELECT', ref: t };
  }
  if (opChoice === 'SUBMIT') {
    const t = answers.submit_target?.choice;
    if (!t || t === 'none_of_the_above') return { operation: 'BLOCKED', reason: 'Jev chose SUBMIT with no valid target' };
    return { operation: 'SUBMIT', ref: t };
  }
  return { operation: opChoice };
}

export function normalizeLabel(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Deterministic, zero-network fallback: best token-overlap match between a
 *  form field's label and the candidate's own answer labels. Used when Jev is
 *  disabled/unavailable for the per-field value-matching sub-call below, and
 *  as the tiebreak when Jev returns no usable choice. Never fabricates a
 *  value: returns null (never typed) rather than guessing. */
export function bestLabelMatch(fieldLabel, candidates) {
  const fTokens = new Set(normalizeLabel(fieldLabel).split(' ').filter(Boolean));
  let best = null;
  for (const c of candidates) {
    const cTokens = normalizeLabel(c.label).split(' ').filter(Boolean);
    const score = cTokens.filter((t) => fTokens.has(t)).length;
    if (score > 0 && (!best || score > best.score)) best = { value: c.value, score };
  }
  return best?.value ?? null;
}

/**
 * Resolve the text to type into ONE field — the "small cheap model writes
 * text only on TYPE_TEXT" step. The candidate's own answers are already-known
 * values (never generated), so this is a MATCH, not free-text generation:
 * Jev's typed-choice call is the project's existing cheap/fast classification
 * primitive (lib/jev-client.mjs) and picks which of the candidate's answers
 * belongs in the field. The field's own label is untrusted third-party DOM
 * text, so it lives only in `state`; the candidate's own answers (caller-
 * owned data, not adversarial page content) are what the criteria describe —
 * mirroring how buildDecisionRequest() separates the two above.
 *
 * Falls back to deterministic label matching with zero network calls when
 * Jev is disabled, errors, or returns no usable choice — the loop's fill step
 * never blocks on Jev being reachable.
 *
 * @returns {Promise<string|null>}
 */
export async function resolveTypeTextValue(fieldLabel, answers, request = postJevChoices) {
  const candidates = (answers || []).filter((a) => a.value?.trim());
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0].value;

  const criteria = { none_of_the_above: "none of the candidate's answers belong in this field" };
  candidates.forEach((a, i) => {
    criteria[`a${i}`] = `"${a.label}": ${a.value.replace(/\s+/g, ' ').slice(0, 120)}`;
  });
  const state = JSON.stringify({ formFieldLabel: fieldLabel });
  const answersRaw = await request(state, {
    match: { type: 'choice', instructions: 'Pick the candidate answer whose label best matches the form field described in state.', criteria },
  });
  const choice = answersRaw?.match?.choice;
  if (choice && choice !== 'none_of_the_above') {
    const idx = Number(choice.slice(1));
    if (Number.isInteger(idx) && candidates[idx]) return candidates[idx].value;
  }
  return bestLabelMatch(fieldLabel, candidates);
}
