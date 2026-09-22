const DESIRED_COMPENSATION = "desired-compensation";

export function stripLabel(s) {
  return String(s ?? "").toLowerCase().replace(/\*+\s*$/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function isCommissionInReais(fieldName) {
  const text = String(fieldName ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const commission = /\bcommission(?:ed|s)?\b|\bcomissao(?:es)?\b|\bvariable\b|\bvariavel\b/.test(text);
  const reais = /\b(?:brl|reais?|real)\b|\br\s*\$/.test(text);
  return commission && reais;
}

/** Match canonical answers by label while keeping synthesized desired salary
 * out of BRL commission/variable-pay fields. Exact report answers remain
 * eligible because they do not carry the desired-compensation kind. */
export function matchAnswer(fieldName, answers) {
  const fn = stripLabel(fieldName);
  if (!fn) return null;
  const guarded = isCommissionInReais(fieldName);
  let best = null;
  for (const answer of answers) {
    if (guarded && answer.kind === DESIRED_COMPENSATION) continue;
    const al = stripLabel(answer.label);
    if (!al) continue;
    if (al === fn) return answer.value;
    const contained = fn.includes(al) || al.includes(fn);
    if (contained && Math.min(al.length, fn.length) >= 4) {
      if (!best || al.length > best.len) best = { value: answer.value, len: al.length };
    }
  }
  return best?.value ?? null;
}

export function resolveFields(refs, answers) {
  const matched = [];
  for (const [ref, details] of Object.entries(refs || {})) {
    const role = String(details.role || "").toLowerCase();
    if (role !== "textbox" && role !== "combobox") continue;
    if (/leave this field (blank|empty)|deixe este campo em branco/i.test(details.name || "")) continue;
    const value = matchAnswer(details.name, answers);
    if (value != null) matched.push({ ref, name: details.name, role, value });
  }
  return matched;
}
