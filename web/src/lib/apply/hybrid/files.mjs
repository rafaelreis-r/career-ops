// files.mjs — which file input takes the CV, decided by evidence.
//
// Attaching the CV to the wrong input is worse than not attaching it: on the
// real iTRTech form (2026-09-22) the first file input accepted only images and
// was the profile PHOTO, and the old driver put the PDF there. So an input
// receives the CV only when (a) its own label, question label, id/name or
// surrounding text identifies it as the résumé/CV, and (b) its `accept` list
// admits the CV's file type. Anything else — ambiguous candidates, no
// evidence, an accept list that excludes PDF — attaches nothing and says why.

const COVER_RX = /cover\s*letter|carta\s+de\s+apresenta|motivation\s+letter|lettre\s+de\s+motivation|anschreiben/i;
const PHOTO_RX = /\b(photo|foto|fotografia|picture|avatar|headshot|imagem|profile image)\b/i;
const AUTOFILL_RX = /autofill|auto-fill|autopreench|preencher automaticamente|parse your (resume|cv)/i;
const RESUME_RX = /\b(resume|résumé|cv|curriculum|curr[íi]culo|curriculo|lebenslauf)\b/i;
const EVIDENCE_RANK = { ownLabel: 0, label: 1, id: 2, context: 3 };

const MIME_BY_EXT = {
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  odt: ['application/vnd.oasis.opendocument.text'],
  rtf: ['application/rtf', 'text/rtf'],
  txt: ['text/plain'],
};

/** Does an `accept` attribute admit a file with this name? Empty accept admits all. */
export function acceptsFile(accept, fileName) {
  const list = String(accept ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const ext = String(fileName ?? '').toLowerCase().split('.').pop();
  const mimes = MIME_BY_EXT[ext] || [];
  return list.some((tok) => tok === `.${ext}` || tok === '*/*' || mimes.includes(tok) || (tok.endsWith('/*') && mimes.some((m) => m.startsWith(tok.slice(0, -1)))));
}

/** Purpose of a file input from its strongest evidence:
 *  'resume' | 'cover_letter' | 'photo' | 'autofill' | 'unknown'. */
export function classifyFileInput(q) {
  const sources = [
    ['ownLabel', q.ownLabel],
    ['label', q.label],
    ['id', `${q.id ?? ''} ${q.name ?? ''}`.replace(/[_-]+/g, ' ')],
    ['context', q.context],
  ];
  for (const [evidence, text] of sources) {
    const t = String(text ?? '');
    if (!t.trim()) continue;
    if (AUTOFILL_RX.test(t)) return { kind: 'autofill', evidence, text: t.slice(0, 120) };
    if (COVER_RX.test(t)) return { kind: 'cover_letter', evidence, text: t.slice(0, 120) };
    if (PHOTO_RX.test(t)) return { kind: 'photo', evidence, text: t.slice(0, 120) };
    if (RESUME_RX.test(t)) return { kind: 'resume', evidence, text: t.slice(0, 120) };
  }
  return { kind: 'unknown', evidence: null, text: '' };
}

/**
 * Pick the one input that should receive the CV, or none with a reason.
 *
 * @param {Array<object>} fileQuestions - scanned questions of kind 'file'.
 * @param {string} cvPath
 * @returns {{target: object|null, reason: string|null, considered: object[]}}
 */
export function selectResumeTarget(fileQuestions, cvPath) {
  const considered = (fileQuestions || []).map((q) => {
    const c = classifyFileInput(q);
    return { key: q.key, label: q.label, accept: q.accept, kind: c.kind, evidence: c.evidence, acceptsCv: acceptsFile(q.accept, cvPath), visible: q.visible !== false, q };
  });
  const resumes = considered.filter((c) => c.kind === 'resume');
  const usable = resumes.filter((c) => c.acceptsCv);
  const strip = ({ q, ...rest }) => rest;
  if (usable.length === 1) return { target: usable[0].q, reason: null, considered: considered.map(strip) };
  if (usable.length > 1) {
    const best = Math.min(...usable.map((c) => EVIDENCE_RANK[c.evidence]));
    const top = usable.filter((c) => EVIDENCE_RANK[c.evidence] === best);
    if (top.length === 1) return { target: top[0].q, reason: null, considered: considered.map(strip) };
    return { target: null, reason: 'ambiguous: more than one input identifies as the resume', considered: considered.map(strip) };
  }
  if (resumes.length) return { target: null, reason: 'the resume input does not accept this file type', considered: considered.map(strip) };
  return { target: null, reason: considered.length ? 'no file input identifies as the resume' : 'no file input on the form', considered: considered.map(strip) };
}
