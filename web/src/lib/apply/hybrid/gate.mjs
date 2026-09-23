// gate.mjs — the pre-submit gate, computed from the FINAL DOM scan, and the
// order the round's tabs are left in.
//
// The gate is a fact about the page, not an opinion about the run: a required
// question whose DOM state is empty blocks, whatever the driver believes it
// typed. Groups count as one question, so a required checkbox group with every
// box unchecked blocks even when no <input> carries `required` (Storyteller,
// 2026-09-22: the old verifier passed that form). A CV that is not attached
// and verified blocks, required or not. A captcha is a human step and always
// blocks. The driver never submits; `ready` tells the human whether pressing
// submit is safe.

import { valueFitsField } from './answers.mjs';

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

/**
 * @param {{questions: object[], captcha: {present: boolean}}} finalScan
 * @param {Map<string, {status: string, reason?: string}>} outcomes - per-question fill outcome, by key.
 * @param {{cvName?: string, cvAttached?: boolean|null, cvReason?: string|null}} [opts]
 *        `cvAttached: false` adds a resume blocker; null means no CV was expected.
 * @returns {{ready: boolean, blockers: Array<{kind: string, key: string|null, label: string, reason: string}>}}
 */
export function evaluateGate(finalScan, outcomes, { cvName = '', cvAttached = null, cvReason = null } = {}) {
  const blockers = [];
  for (const q of finalScan.questions) {
    if (!q.visible) continue;
    const o = outcomes.get(q.key);
    const empty = isEmptyState(q, cvName);
    if (q.required && (empty || o?.status !== 'verified')) {
      const why = o?.status === 'locked' ? `locked: ${o.reason}` : o?.status === 'no-answer' ? 'no canonical answer' : o?.status ? `${o.status}: ${o.reason ?? ''}`.trim() : 'empty';
      blockers.push({ kind: empty ? 'required-empty' : 'required-unverified', key: q.key, label: q.label, reason: `required field lacks a verified canonical answer (${why})` });
    } else if (o?.status === 'mismatch' && !empty) {
      blockers.push({ kind: 'mismatch', key: q.key, label: q.label, reason: `value on the page differs from the canonical answer (${o.reason ?? ''})` });
    } else if (q.kind === 'text' || q.kind === 'textarea') {
      // Whoever typed it (this run, an autofill, an earlier run): a value
      // whose shape the field does not ask for is not an answer.
      const misfit = valueFitsField(q, q.state?.value);
      if (misfit) blockers.push({ kind: 'type-mismatch', key: q.key, label: q.label, reason: `value does not fit the field: ${misfit.reason}` });
    }
  }
  if (cvAttached === false && !blockers.some((b) => /resume|cv|curr[ií]culo/i.test(b.label))) {
    blockers.push({ kind: 'resume', key: null, label: 'Resume/CV', reason: `CV not attached and verified: ${cvReason || 'unknown'} (driver defect)` });
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

const STATUS_RANK = { ready: 0, 'ready-captcha': 0, incomplete: 1 };

/** Round order: forms that only need the human (ready, or ready but for the
 *  captcha) first, then incomplete ones from fewest to most pending items;
 *  tabs the driver did not fill go last. Stable within equal ranks. */
export function orderTabs(tabs) {
  const rank = (t) => STATUS_RANK[t.status] ?? 2;
  return tabs
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || (a.t.pending?.length ?? 0) - (b.t.pending?.length ?? 0) || a.i - b.i)
    .map(({ t }) => t);
}
