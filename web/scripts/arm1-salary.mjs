// Pure salary-answer matching helpers used by the Arm 1 driver.

const DESIRED_COMPENSATION = "desired-compensation";
const COMPENSATION_WORD_RX = /\b(?:salary|salario|pay|compensation|compensacao|remuneration|remuneracao|wage|ordenado)\b/;

/** Strip a field label to its comparable core: lowercase, drop a trailing
 * required-marker asterisk, collapse non-alphanumeric runs to one space. */
export function stripLabel(s) {
  return String(s ?? "").toLowerCase().replace(/\*+\s*$/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function semanticText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function fieldMeaning(fieldName) {
  const text = semanticText(fieldName);
  const hasCompensationWord = COMPENSATION_WORD_RX.test(text);
  const hasCurrentMarker = /\b(?:current|present|existing|latest|last|previous|atual|presente|ultimo|ultima)\b/.test(text);
  const restricted =
    /\bcommission(?:ed|s)?\b|\bcomissao(?:es)?\b|\bvariable\b|\bvariavel\b|\bbonus(?:es)?\b|\bincentive(?:s)?\b|\bincentivo(?:s)?\b|\bequity\b|\bstock\b|\bshare(?:s)?\b|\b(?:stock|share|equity)\s+option(?:s)?\b|\b(?:rsu|esop)s?\b|\bparticipacao\s+acionaria\b/.test(text)
    || /\bcounter\s*(?:offer|proposal)\b|\bcounteroffer\b|\bcontra\s*(?:oferta|proposta)\b|\bcontraproposta\b/.test(text)
    || /\btotal\s+(?:compensation|compensacao|remuneration|remuneracao|pay|package)\b/.test(text)
    || (hasCurrentMarker && hasCompensationWord);
  if (restricted) return "restricted";

  const desiredMarker = /\b(?:desired|expected|expectations?|target|minimum|required|requirements?|pretensao|pretendida)\b/.test(text);
  const bareSalary = /^(?:salary|pay|wage)$/.test(text.trim());
  const baseOrRange = /\b(?:base|range|band)\b/.test(text) && hasCompensationWord;
  if (hasCompensationWord && (desiredMarker || bareSalary || baseOrRange)) return "desired";
  return "unknown";
}

function fieldCurrency(fieldName) {
  const raw = semanticText(fieldName);
  if (/\b(?:brl|reais?|real)\b|\br\s*\$/.test(raw)) return "BRL";
  if (/\b(?:usd|us dollars?|dollars?)\b|\$/.test(raw)) return "USD";
  if (/\b(?:eur|euros?)\b|€/.test(raw)) return "EUR";
  if (/\b(?:gbp|pounds?)\b|£/.test(raw)) return "GBP";
  return null;
}

function matchAnswerResult(fieldName, answers) {
  const fn = stripLabel(fieldName);
  if (!fn) return { value: null, reason: null };
  const meaning = fieldMeaning(fieldName);
  let best = null;
  let rejectedReason = null;
  for (const answer of answers) {
    const al = stripLabel(answer.label);
    if (!al) continue;
    const exact = al === fn;
    const contained = fn.includes(al) || al.includes(fn);
    if (!exact && (!contained || Math.min(al.length, fn.length) < 4)) continue;

    if (answer.kind === DESIRED_COMPENSATION) {
      if (meaning !== "desired") {
        if (meaning === "restricted") rejectedReason ||= "incompatible-field-semantics";
        continue;
      }
      const currency = fieldCurrency(fieldName);
      if (currency && currency !== answer.currency) {
        rejectedReason ||= "currency-mismatch";
        continue;
      }
    }

    if (exact) return { value: answer.value, reason: null };
    if (contained) {
      if (!best || al.length > best.len) best = { value: answer.value, len: al.length };
    }
  }
  return { value: best?.value ?? null, reason: best ? null : rejectedReason };
}

/** Resolve a field's value from canonical answers. Salary answers are only
 * eligible for fields whose meaning is a desired salary and whose explicit
 * currency matches the canonical answer. */
export function matchAnswer(fieldName, answers) {
  return matchAnswerResult(fieldName, answers).value;
}

/** Resolve fillable fields and retain guarded fields for metrics/logging. */
export function resolveFields(refs, answers) {
  const matched = [];
  const rejected = [];
  for (const [ref, details] of Object.entries(refs || {})) {
    const role = String(details.role || "").toLowerCase();
    if (role !== "textbox" && role !== "combobox") continue;
    if (/leave this field (blank|empty)|deixe este campo em branco/i.test(details.name || "")) continue;
    const result = matchAnswerResult(details.name, answers);
    if (result.value != null) {
      matched.push({ ref, name: details.name, role, value: result.value });
    } else if (result.reason) {
      rejected.push({ ref, name: details.name, role, reason: result.reason });
    }
  }
  return { matched, rejected };
}
