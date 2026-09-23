// gate.mjs — the pre-submit gate, computed from the FINAL DOM scan, and the
// order the round's tabs are left in.
//
// The gate is a fact about the page, not an opinion about the run: a required
// question needs a verified canonical answer AND a non-empty DOM state. Groups
// count as one question, so a required checkbox group with every box unchecked
// blocks even when no <input> carries `required` (Storyteller, 2026-09-22: the
// old verifier passed that form). The posting's CV must be present in the
// final DOM, not merely have been attached earlier. A consent the profile does
// not answer blocks, required or not. A captcha is a human step and always
// blocks. `ready` (no blocker at all) is the only state the driver submits in.

import { findQuestionByIdentity, questionSignature, valueFitsField } from './answers.mjs';

const CONSENT_RX = /consent|\bi agree\b|\bagree to\b|concordo|aceito|autorizo|privacy policy|pol[ií]tica de privacidade|termos de uso|terms of (use|service)/i;

/** Is a scanned question's DOM state empty? `cvName` lets a file question count
 *  as filled when the ATS consumed the input and shows the filename instead. */
export function isEmptyState(q, cvName = '') {
  const s = q.state || {};
  switch (q.kind) {
    case 'text':
    case 'textarea':
      return !String(s.value ?? '').trim();
    case 'file':
      return !(s.files && s.files.length) && !(cvName && String(s.text ?? '').includes(cvName));
    default:
      return !(s.selected && s.selected.length);
  }
}

/** Does the chosen resume input still hold this CV, or does its preserved ATS
 *  container show the filename after consuming the input? */
export function cvInFinalDom(finalScan, cvName, resumeQuestion = null) {
  if (!cvName || !resumeQuestion) return false;
  const question = findQuestionByIdentity(finalScan.questions, resumeQuestion);
  if (!question || question.kind !== 'file') return false;
  const state = question.state || {};
  return (state.files || []).includes(cvName) || String(state.text ?? '').includes(cvName);
}

export function alignOutcomes(finalQuestions, outcomes) {
  const prior = new Map();
  for (const outcome of outcomes.values()) {
    const key = questionSignature(outcome);
    if (!prior.has(key)) prior.set(key, []);
    prior.get(key).push(outcome);
  }
  const finalCounts = new Map();
  for (const q of finalQuestions) finalCounts.set(questionSignature(q), (finalCounts.get(questionSignature(q)) || 0) + 1);
  return new Map(
    finalQuestions
      .map((q) => {
        const direct = outcomes.get(q.key);
        if (direct && questionSignature(direct) === questionSignature(q)) return [q.key, direct];
        const matches = prior.get(questionSignature(q)) || [];
        return finalCounts.get(questionSignature(q)) === 1 && matches.length === 1 ? [q.key, matches[0]] : null;
      })
      .filter(Boolean),
  );
}

/**
 * @param {{questions: object[], captcha: {present: boolean}}} finalScan
 * @param {Map<string, {status: string, reason?: string}>} outcomes - per-question fill outcome, by key.
 * @param {{cvName?: string, cvReason?: string|null, resumeQuestion?: object|null}} [opts]
 * @returns {{ready: boolean, blockers: Array<{kind: string, key: string|null, label: string, reason: string}>}}
 */
export function evaluateGate(finalScan, outcomes, { cvName = '', cvReason = null, resumeQuestion = null } = {}) {
  const blockers = [];
  for (const frame of finalScan.frameErrors || []) blockers.push({ kind: 'frame-scan', key: null, label: frame.url || 'embedded application frame', reason: `frame could not be scanned: ${frame.reason}` });
  for (const q of finalScan.questions) {
    if (!q.visible) continue;
    const o = outcomes.get(q.key);
    const empty = isEmptyState(q, cvName);
    if (q.required && (empty || o?.status !== 'verified')) {
      const why = o?.status === 'locked' ? `locked: ${o.reason}` : o?.status === 'no-answer' ? 'no canonical answer' : o?.status ? `${o.status}: ${o.reason ?? ''}`.trim() : 'empty';
      blockers.push({ kind: empty ? 'required-empty' : 'required-unverified', key: q.key, label: q.label, reason: `required field lacks a verified canonical answer (${why})` });
    } else if (o?.status === 'mismatch' && !empty) {
      blockers.push({ kind: 'mismatch', key: q.key, label: q.label, reason: `value on the page differs from the canonical answer (${o.reason ?? ''})` });
    } else if (q.kind !== 'file' && CONSENT_RX.test(q.label ?? '') && o?.status !== 'verified') {
      blockers.push({ kind: 'consent', key: q.key, label: q.label, reason: 'a consent without a canonical answer: the candidate decides it' });
    } else if (q.kind === 'text' || q.kind === 'textarea') {
      // Whoever typed it (this run, an autofill, an earlier run): a value
      // whose shape the field does not ask for is not an answer.
      const misfit = valueFitsField(q, q.state?.value);
      if (misfit) blockers.push({ kind: 'type-mismatch', key: q.key, label: q.label, reason: `value does not fit the field: ${misfit.reason}` });
    }
  }
  if (!cvInFinalDom(finalScan, cvName, resumeQuestion) && !blockers.some((b) => /resume|cv|curr[ií]culo/i.test(b.label))) {
    blockers.push({ kind: 'resume', key: null, label: 'Resume/CV', reason: `the posting's CV is not in the final DOM: ${cvReason || (cvName ? `${cvName} not shown by any file input` : 'no CV for this posting')} (driver defect)` });
  }
  if (finalScan.captcha?.present) blockers.push({ kind: 'captcha', key: null, label: 'captcha', reason: 'captcha on the page: a human must complete it' });
  return { ready: blockers.length === 0, blockers };
}

/** A tab's standing for the round: `ready` (nothing left), `ready-captcha`
 *  (only the captcha left) or `incomplete`, plus the exact labels still pending. */
export function tabStatus(gate) {
  const pending = gate.blockers.filter((b) => b.kind !== 'captcha').map((b) => b.label);
  const captcha = gate.blockers.some((b) => b.kind === 'captcha');
  return { status: pending.length ? 'incomplete' : captcha ? 'ready-captcha' : 'ready', pending };
}

const STATUS_RANK = { ready: 0, 'ready-captcha': 0, incomplete: 1, submitted: 3 };

/** Round order: forms that only need the human (ready, or ready but for the
 *  captcha) first, then incomplete ones from fewest to most pending items;
 *  tabs the driver did not fill next, submitted applications last. Stable
 *  within equal ranks. */
export function orderTabs(tabs) {
  const rank = (t) => STATUS_RANK[t.status] ?? 2;
  return tabs
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || (a.t.pending?.length ?? 0) - (b.t.pending?.length ?? 0) || a.i - b.i)
    .map(({ t }) => t);
}
