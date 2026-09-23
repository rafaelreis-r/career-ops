// gate.mjs — the pre-submit gate, computed from the FINAL DOM scan.
//
// The gate is a fact about the page, not an opinion about the run: a required
// question whose DOM state is empty blocks, whatever the driver believes it
// typed. Groups count as one question, so a required checkbox group with every
// box unchecked blocks even when no <input> carries `required` (Storyteller,
// 2026-09-22: the old verifier passed that form). A captcha is a human step and
// always blocks. The driver never submits; `ready` tells the human (or the
// LLM-owned worker) whether pressing submit is safe.

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
 * @param {{cvName?: string}} [opts]
 * @returns {{ready: boolean, blockers: Array<{key: string|null, label: string, reason: string}>}}
 */
export function evaluateGate(finalScan, outcomes, { cvName = '' } = {}) {
  const blockers = [];
  for (const q of finalScan.questions) {
    if (!q.visible) continue;
    const o = outcomes.get(q.key);
    if (q.required && isEmptyState(q, cvName)) {
      const why = o?.status === 'locked' ? `locked: ${o.reason}` : o?.status === 'no-answer' ? 'no canonical answer' : o?.status ? `${o.status}: ${o.reason ?? ''}`.trim() : 'empty';
      blockers.push({ key: q.key, label: q.label, reason: `required and empty (${why})` });
    } else if (o?.status === 'mismatch' && !isEmptyState(q, cvName)) {
      blockers.push({ key: q.key, label: q.label, reason: `value on the page differs from the canonical answer (${o.reason ?? ''})` });
    }
  }
  if (finalScan.captcha?.present) blockers.push({ key: null, label: 'captcha', reason: 'captcha on the page: a human must complete it' });
  return { ready: blockers.length === 0, blockers };
}
