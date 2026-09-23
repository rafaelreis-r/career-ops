#!/usr/bin/env node
// ab-jev-apply.mjs — Arm 1 of the Jev-vs-turbo-apply A/B test: an autonomous,
// end-to-end runner that opens a REAL headed browser, fills a job application
// from the user's own canonical data using the Jev decision loop, runs a
// pre-submit self-verification pass, and — unless `--no-submit` is given —
// clicks the real final Submit control via the driver's opt-in full-autonomous
// SUBMIT operation (web/src/lib/apply/jev-drive-core.mjs's `submitAllowed`
// gate). Emits a machine-readable metrics record for the A/B comparison.
//
// Run (from web/):
//   node scripts/ab-jev-apply.mjs --url <application-form-url> [--row 703] [--submit]
//   node scripts/ab-jev-apply.mjs --url file://$(pwd)/src/lib/apply/__fixtures__/careers-form.html --no-submit
//
// WHY THIS DUPLICATES PART OF driveSessionJev (web/src/lib/apply/jev-drive.ts)
// INSTEAD OF IMPORTING IT: jev-drive.ts imports `./diagnose` with NO file
// extension — TypeScript/Next's "bundler" module resolution allows that, but
// plain Node ESM cannot resolve an extensionless relative specifier (verified:
// `node --experimental-strip-types` on this repo's Node throws
// `Cannot find module '.../diagnose'` for that exact import). This repo
// already hit that wall once and solved it the same way this script does —
// see jev-drive-core.mjs's own module docstring and
// web/scripts/print-jev-drive-decisions.mjs, which duplicates the raw DOM
// scan for the identical reason. This script reuses EVERY piece that IS
// import-safe under plain Node (all of jev-drive-core.mjs — the actual
// decision logic and the new SUBMIT gate live there — plus diagnose.ts's
// dropNewTabs/dismissConsent/verifyFill, which only have `import type`
// specifiers and so resolve fine) and duplicates only the DOM-scan glue and
// loop control-flow, mirroring jev-drive.ts turn-for-turn.
//
// TYPESAFE_API_KEY is read from the environment exactly as
// lib/jev-client.mjs / jev-drive-core.mjs already do (isJevDriveEnabled());
// this script sets nothing and reads no other credential.
//
// CV UPLOAD + NO-DATA FIELD SKIP (fm/jev-runner-cv-skip): a real run against
// https://avahi.bamboohr.com/careers/176 filled 6 fields correctly but never
// submitted — it has no résumé upload, and it looped TYPE_TEXT on an optional
// ZIP field with no canonical answer until the repeat-signature stuck-guard
// fired, cutting the fill phase short. attachCv()/resolveCvPath() below
// attach the tailored CV deterministically (never a Jev decision — mirrors
// session.ts's fillSession); driveLoop()'s knownNoDataLabels tracking skips
// (never fabricates, never loops) a field once it has no matching answer,
// only actually blocking the outcome when that field is required.
//
// CV UPLOAD DETECTION ON UNNAMED FILE INPUTS (fm/jev-runner-cv-detect): the
// fix above still missed the real Avahi BambooHR form — inspecting its live
// DOM after "Apply for This Job" showed exactly one visible
// `<input type="file">`, with EMPTY name, id, and label, only distinguishable
// by accept=".pdf,.doc,.docx,...". attachCv()'s RESUME_LABEL_RX match needs a
// name/label to test, so it never even attempted this field (cvUploaded was
// uploaded:false, attempts:[]). attachCv() now tries the name/label match
// first (unchanged) and, only when that finds nothing, falls back to
// DOCUMENT_ACCEPT_RX against the file input's accept attribute; each attempt
// records which tier matched ("name" | "accept-fallback") in cvUploaded.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import * as yaml from "js-yaml";
import { isMainModule } from "../../lib/is-main-module.mjs";
import { parseApplicationAnswersSection } from "../../application-answers.mjs";
import { isReportMotivationLabel } from "../src/lib/apply/hybrid/answers.mjs";
import {
  isJevDriveEnabled,
  classifyElement,
  classifyBlocked,
  decideStep,
  resolveTypeTextValue,
  postJevChoices,
  normalizeLabel,
  SUBMIT_RX,
  CONSENT_RX,
  JEV_MODEL,
} from "../src/lib/apply/jev-drive-core.mjs";
// diagnose.ts imports ONLY `import type` specifiers (Page/Frame/ApplyField/
// ApplyIssue) — no runtime import, so Node's native TS type-stripping loads
// it directly. Verified against this repo's Node before relying on it here.
import { dropNewTabs, dismissConsent, verifyFill } from "../src/lib/apply/diagnose.ts";
// slugify() is duplicated (not imported) from web/src/lib/pdf-paths.mjs:
// importing that module drags in its top-level `import yaml from "js-yaml"`
// even though slugify() itself needs no YAML — and on this repo's Node,
// loading js-yaml a second time through that path (already reproduced by
// web/tests/lib/pdf-paths.test.mjs on a clean checkout, independent of this
// script) throws `SyntaxError: ... does not provide an export named
// 'default'`. Same "duplicate across a fragile boundary" rationale as
// SUBMIT_RX/CONSENT_RX above.

// ── canonical data (config/profile.yml, cv-facts.json, cv.md, the row's report) ──

/** Mirrors web/src/lib/career-ops.ts's careerOpsRoot() precedence (CAREER_OPS_ROOT
 *  override, else one directory up from web/'s cwd) — duplicated because that
 *  file is unreachable from plain Node (its sibling agent-interpret.ts imports
 *  `@/lib/...`, which only Next's bundler resolves). */
function careerOpsRoot() {
  const env = process.env.CAREER_OPS_ROOT?.trim();
  if (env) return env;
  return path.resolve(process.cwd(), "..");
}

function loadYamlSafe(file) {
  try {
    return yaml.load(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Verbatim candidate.* / location.* values from config/profile.yml, mapped
 * to the common label spellings ATS forms use. Every value is copied as-is —
 * never reworded or inferred — so a field either gets the user's real value
 * or is left for resolveTypeTextValue()/bestLabelMatch() to report as unmatched. */
export function answersFromProfile(profile) {
  const c = profile?.candidate || {};
  const loc = profile?.location || {};
  const out = [];
  const push = (label, value) => {
    const v = value == null ? "" : String(value).trim();
    if (v) out.push({ label, value: v });
  };
  push("Full Name", c.full_name);
  push("Name", c.full_name);
  if (c.full_name) {
    const parts = String(c.full_name).trim().split(/\s+/);
    push("First Name", parts[0]);
    push("Last Name", parts.slice(1).join(" "));
  }
  push("Email", c.email);
  push("Email Address", c.email);
  push("Phone", c.phone);
  push("Phone Number", c.phone);
  push("LinkedIn", c.linkedin);
  push("LinkedIn URL", c.linkedin);
  push("LinkedIn Profile", c.linkedin);
  push("Location", c.location);
  push("City", c.location);
  push("Current Location", c.location);
  push("Portfolio", c.portfolio_url);
  push("Website", c.portfolio_url);
  push("Portfolio URL", c.portfolio_url);
  push("Personal Website", c.portfolio_url);
  push("GitHub", c.github);
  push("GitHub URL", c.github);
  push("Twitter", c.twitter);
  push("Country", loc.country);
  if (loc.visa_status) push("Work Authorization", loc.visa_status);
  if (typeof loc.needs_sponsorship === "boolean") {
    const answer = loc.needs_sponsorship ? "Yes" : "No";
    push("Will you now or in the future require visa sponsorship?", answer);
    push("Do you require sponsorship?", answer);
  }
  // PT-BR label aliases (Brazilian ATS forms carry Portuguese labels for the
  // same values English forms use). The substring matcher is two-directional,
  // so one alias per field is enough to bind.
  push("Cidade", c.location);
  push("Cidade atual", c.location);
  push("Localizacao", c.location);
  push("Localização", c.location);
  push("Celular", c.phone);
  push("Celular com DDD", c.phone);
  push("Telefone", c.phone);
  // Country-code dropdown: a DISTINCT value so the substring rule can't misbind
  // "phone country" to the full phone number.
  push("Phone Country", c.phone_country);
  push("Country Code", c.phone_country);
  push("Codigo do pais", c.phone_country);
  push("Código do país", c.phone_country);
  // Privacy-consent checkbox: value from profile.application_answers.consent.
  const consent = profile?.application_answers?.consent || {};
  if (consent.required) {
    const v = String(consent.required).toLowerCase() === "accept" ? "accept" : String(consent.required);
    push("Consent", v);
    push("Concordo", v);
    push("Aceitar", v);
    push("Politica de Privacidade", v);
    push("Política de Privacidade", v);
    push("Privacy Policy", v);
  }
  return out;
}

/** Loads every canonical source the captain's brief names, never inventing a
 *  value for one that's missing — a missing file just means fewer candidate
 *  answers (recorded in `sources`), not a fabricated one. Report-derived
 *  answers are placed FIRST so they win bestLabelMatch()'s tie-break (the
 *  report's Application Answers section, when present, is posting-specific
 *  and already vetted; profile.yml is the generic fallback). */
export function findReportForRow(root, row) {
  const number = Number(row);
  if (!Number.isInteger(number) || number <= 0) return null;
  const dir = path.join(root, "reports");
  const hit = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((file) => {
        const match = /^(\d+)-/.exec(file);
        return match && Number(match[1]) === number && file.endsWith(".md");
      })
    : null;
  return hit ? path.join(dir, hit) : null;
}

export function answersFromCvMarkdown(text) {
  const answers = [];
  const push = (label, value) => {
    const cleanLabel = String(label ?? '').replace(/[*_`#]/g, '').trim();
    const cleanValue = String(value ?? '').replace(/[*_`]/g, '').trim();
    if (cleanLabel && cleanValue && cleanValue.length <= 300) answers.push({ label: cleanLabel, value: cleanValue });
  };
  const lines = String(text ?? '').split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+\S/.test(line));
  if (heading) push('Full Name', heading.replace(/^#\s+/, ''));
  for (const line of lines) {
    const match = /^\s*(?:[-*]\s*)?(?:\*\*)?([^:*]{2,60})(?:\*\*)?\s*:\s*(.+?)\s*$/.exec(line);
    if (match) push(match[1], match[2]);
  }
  return answers;
}

export function loadCanonicalData(root, { row, reportPath } = {}) {
  const sources = { profileYml: null, cvFactsJson: null, cvMd: null, report: null };
  const profileAnswers = [];
  const cvAnswers = [];
  const reportAnswers = [];

  const profilePath = path.join(root, "config", "profile.yml");
  if (fs.existsSync(profilePath)) {
    const profile = loadYamlSafe(profilePath);
    if (profile) {
      profileAnswers.push(...answersFromProfile(profile));
      sources.profileYml = profilePath;
    }
  }

  // The brief names "data/cv-facts.json"; the repo's actual, gitignored
  // location is config/cv-facts.json (confirmed against the primary
  // checkout — a symlink to career-ops-shared/data/cv-facts.json). Check
  // both so either layout works. Its allow_facts/allow_metrics are a
  // narrative whitelist, not label→value pairs, so they inform `sources`
  // for the metrics record but are never mapped onto a form field — doing
  // that would risk answering an open-ended question with an out-of-context
  // fact, which the brief's no-fabrication rule forbids.
  for (const p of [path.join(root, "config", "cv-facts.json"), path.join(root, "data", "cv-facts.json")]) {
    if (fs.existsSync(p)) {
      try {
        const facts = JSON.parse(fs.readFileSync(p, "utf8"));
        sources.cvFactsJson = { path: p, allowFacts: (facts.allow_facts || []).length, allowMetrics: (facts.allow_metrics || []).length };
      } catch {
        /* unreadable cv-facts.json is a gap, not a fatal error */
      }
      break;
    }
  }

  const cvPath = path.join(root, "cv.md");
  if (fs.existsSync(cvPath)) {
    cvAnswers.push(...answersFromCvMarkdown(fs.readFileSync(cvPath, "utf8")));
    sources.cvMd = cvPath;
  }

  let resolvedReportPath = reportPath ? path.resolve(reportPath) : null;
  if (!resolvedReportPath && row != null) {
    resolvedReportPath = findReportForRow(root, row);
  }
  if (resolvedReportPath && fs.existsSync(resolvedReportPath)) {
    const text = fs.readFileSync(resolvedReportPath, "utf8");
    const snap = parseApplicationAnswersSection(text);
    if (snap) {
      for (const e of snap.freeText) if (e.answer?.trim() && isReportMotivationLabel(e.question)) reportAnswers.push({ label: e.question, value: e.answer.trim() });
      sources.report = resolvedReportPath;
    }
  }

  // `answers` keeps the merged, report-first order every existing caller reads;
  // the two halves are exposed for callers that match them in that precedence
  // as separate stages (web/scripts/apply-hybrid.mjs).
  return { answers: [...reportAnswers, ...profileAnswers, ...cvAnswers], reportAnswers, profileAnswers, cvAnswers, sources };
}

// ── résumé/CV attachment (deterministic — never routed through the Jev
//    decision loop; mirrors session.ts's fillSession, which the same module
//    docstring rationale prevents this script from importing directly) ──────

/** Same regex fillSession's isResumeField() uses to recognize a résumé/CV
 *  file field — duplicated rather than imported because session.ts pulls in
 *  agentInterpretForm/chromium and can't load under plain Node (see this
 *  file's header). Kept as its own exported constant, not inlined, so a
 *  future divergence from session.ts's copy is a one-line diff to notice. */
export const RESUME_LABEL_RX = /resume|résumé|\bcv\b|curriculum|lebenslauf|currículum/i;

/** Lowercase, non-alphanumeric runs -> single hyphen, trimmed — byte-identical
 *  to web/src/lib/pdf-paths.mjs's slugify(), duplicated rather than imported
 *  (see this file's header for why). */
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Company slug for the CV filename lookup, in the brief's stated order:
 *  the already-resolved report file's own slug (identical convention to
 *  web/src/lib/pdf-paths.mjs's resolvePdfPaths — same reports/NNN-<slug>-
 *  DATE.md filename), else the first label of the application URL's host
 *  (avahi.bamboohr.com → "avahi") — every ATS this repo targets puts the
 *  company in a subdomain. Returns null rather than guessing when neither
 *  source yields anything usable. */
export function deriveCompanySlug({ reportPath, url }) {
  if (reportPath) {
    const m = path.basename(reportPath).match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
    if (m) return m[1];
  }
  if (url) {
    try {
      const host = new URL(url).hostname;
      const first = host.split(".")[0];
      if (first && first !== "www") return slugify(first);
    } catch {
      /* file:// fixtures and other unparsable "urls" just skip URL-derived slugs */
    }
  }
  return null;
}

/** Resolve the tailored CV PDF to attach, in the brief's fixed precedence: an
 *  explicit --cv always wins (existence-checked — a missing explicit path is
 *  a gap, never silently ignored); otherwise the newest
 *  output/cv-candidate-<company-slug>-*.pdf for this row/URL (real naming
 *  convention — see web/tests/lib/pdf-paths.test.mjs and data/pdf-index.tsv).
 *  Never fabricates a path: any miss returns `path: null` plus a `reason` the
 *  caller records as a gap instead of a fabricated attachment. */
export function resolveCvPath(root, { explicitCv, companySlug } = {}) {
  if (explicitCv) {
    const resolved = path.resolve(explicitCv);
    return fs.existsSync(resolved) ? { path: resolved, reason: null } : { path: null, reason: `--cv path does not exist: ${resolved}` };
  }
  if (!companySlug) return { path: null, reason: "no company slug derivable from --row/report/--url — nothing to look up" };
  const outputDir = path.join(root, "output");
  if (!fs.existsSync(outputDir)) return { path: null, reason: `no ${outputDir} directory` };
  const prefix = `cv-candidate-${companySlug}-`;
  const hits = fs.readdirSync(outputDir).filter((f) => f.startsWith(prefix) && f.endsWith(".pdf"));
  if (!hits.length) return { path: null, reason: `no output/${prefix}*.pdf found` };
  hits.sort((a, b) => fs.statSync(path.join(outputDir, b)).mtimeMs - fs.statSync(path.join(outputDir, a)).mtimeMs);
  return { path: path.join(outputDir, hits[0]), reason: null };
}

/** Same rationale RESUME_LABEL_RX's own comment gives — duplicated rather
 *  than imported, matched against a file input's `accept` attribute instead
 *  of its label. Fallback ONLY (see attachCv() below): the real Avahi
 *  BambooHR upload field (fm/jev-runner-cv-detect) has no name, id, or label
 *  at all — `<input type="file" accept=".pdf,.doc,.docx,...">` — so it never
 *  matches RESUME_LABEL_RX and needs a second signal. The dot-prefixed
 *  extension check (not a bare substring) avoids matching an unrelated field
 *  whose accept list happens to contain "pdf"/"doc" inside a longer token. */
export const DOCUMENT_ACCEPT_RX = /\.(pdf|docx?)\b/i;

/** Deterministically attach the resolved CV to every résumé/CV file input on
 *  screen — never a Jev decision (a file input opens a native OS picker;
 *  dropping one fixed, already-resolved path into it is a mechanical action,
 *  not a judgment call — same rationale session.ts's own module comment gives
 *  for fillSession's identical attach step). Guarded to real file inputs only
 *  (`itype === "file"`, which classifyBlocked() already tags `blocked:
 *  "file"`), and never uploads anything but the one resolved `cvPath`.
 *
 *  Two-tier target match (fm/jev-runner-cv-detect): a name/id/aria-label/text
 *  match against RESUME_LABEL_RX is always tried first and, when it hits,
 *  attaches to every matching input (unchanged prior behavior). Only when
 *  NO input matches by label does this fall back to accept-attribute
 *  matching (DOCUMENT_ACCEPT_RX) — the real Avahi form's upload field has an
 *  empty name/id/label and is identifiable only by its accept list. rawScan's
 *  visibility filter means every candidate ref is already on-screen, so
 *  "prefer the visible one" is automatic; if more than one visible
 *  document-accepting input remains, the first (scan order) is used and the
 *  choice is recorded via `strategy` on the returned attempt so it's never
 *  silent. Each attempt records `strategy: "name" | "accept-fallback"` for
 *  the caller's cvUploaded metrics. */
export async function attachCv(frame, refs, cvPath) {
  if (!cvPath) return [];
  const fileRefs = refs.filter((r) => r.itype === "file" && r.blocked === "file");
  const nameMatches = fileRefs.filter((r) => RESUME_LABEL_RX.test(r.label || ""));
  let targets;
  if (nameMatches.length) {
    targets = nameMatches.map((r) => ({ ref: r, strategy: "name" }));
  } else {
    const acceptMatches = fileRefs.filter((r) => DOCUMENT_ACCEPT_RX.test(r.accept || ""));
    targets = acceptMatches.length ? [{ ref: acceptMatches[0], strategy: "accept-fallback" }] : [];
  }
  const results = [];
  for (const { ref: r, strategy } of targets) {
    let ok = false;
    try {
      await frame.locator(`[data-co-field="${r.ref}"]`).first().setInputFiles(cvPath);
      ok = true;
    } catch {
      ok = false;
    }
    results.push({ ref: r.ref, label: r.label, strategy, ok });
  }
  return results;
}

// ── DOM scan (duplicated from jev-drive.ts's rawScan/snapshotRefs — see the
//    file header for why this can't just be imported) ─────────────────────────

function rawScanInPage() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const labelFor = (el) => {
    const id = el.getAttribute("id");
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lbl) {
        const t = clean(lbl.textContent);
        if (t) return t;
      }
    }
    const wrap = el.closest("label");
    if (wrap) {
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll("input, textarea, select, button").forEach((c) => c.remove());
      const t = clean(clone.textContent);
      if (t) return t;
    }
    return clean(el.getAttribute("aria-label") || el.placeholder || el.textContent || el.value || el.name);
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return el.offsetParent !== null && r.width > 2 && r.height > 2;
  };
  const sel =
    'a, button, input, textarea, select, [role="button"], [role="link"], [role="combobox"], [role="checkbox"], [role="radio"], [role="listbox"], [contenteditable="true"]';
  const els = Array.from(document.querySelectorAll(sel)).filter(vis);
  const out = [];
  let n = 0;
  for (const el of els.slice(0, 70)) {
    const tag = el.tagName.toLowerCase();
    const itype = (el.type || "").toLowerCase();
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag);
    const label = labelFor(el);
    const required = el.required === true || el.getAttribute("aria-required") === "true";
    // Captured for file inputs whose name/id/aria-label/text are all empty —
    // the real Avahi BambooHR upload field is exactly this: one visible
    // `<input type="file">` with no name/id/label, identifiable only by its
    // accept list (see attachCv()'s accept-based fallback below).
    const accept = el.getAttribute("accept") || "";
    const ref = `e${n}`;
    // Tag with BOTH ref attributes: data-co-jev-ref is what this loop's own
    // locators use (matching jev-drive.ts); data-co-field is the attribute
    // diagnose.ts's verifyFill() looks for — tagging both lets this script
    // reuse that real, already-tested self-verification helper.
    el.setAttribute("data-co-jev-ref", ref);
    el.setAttribute("data-co-field", ref);
    out.push({ ref, tag, itype, role, label, required, accept });
    n++;
  }
  return out;
}

export async function snapshotRefs(frame) {
  const raw = await frame.evaluate(rawScanInPage).catch(() => []);
  return raw.map((r) => {
    const kind = classifyElement(r);
    const blocked = classifyBlocked(r, kind);
    return { ref: r.ref, kind, label: r.label, blocked, required: !!r.required, itype: r.itype, accept: r.accept || "" };
  });
}

// ── the drive loop (mirrors driveSessionJev turn-for-turn; see file header) ───

/**
 * @param {{fullAutonomous?: boolean, verified?: boolean, request?: Function, knownNoDataLabels?: Set<string>}} options
 * @returns {Promise<{reached: boolean, turns: number, reason: string, steps: object[], filledAnswers: Record<string,string>, skippedNoData: Array<{label: string, required: boolean}>}>}
 */
export async function driveLoop(page, goal, isFormReady, budget, answers, options = {}) {
  const steps = [];
  const filledAnswers = {};
  let lastSignature = "";
  let repeats = 0;
  const submitAllowed = options.fullAutonomous === true && options.verified === true;
  const request = options.request ?? postJevChoices;
  const history = [];
  // Fields already found to have no matching canonical answer this run — a
  // Set of normalized labels so a caller can thread it across driveLoop calls
  // (fill phase → submit phase) and Jev is never re-offered the same no-data
  // field. Defaults to a call-local Set when the caller doesn't share one.
  const knownNoDataLabels = options.knownNoDataLabels ?? new Set();
  const skippedNoData = [];
  const recordNoData = (label, required) => {
    const key = normalizeLabel(label);
    if (knownNoDataLabels.has(key)) return;
    knownNoDataLabels.add(key);
    skippedNoData.push({ label, required: !!required });
  };

  for (let turn = 1; turn <= budget; turn++) {
    if (goal === "reach" && (await isFormReady().catch(() => false))) {
      return { reached: true, turns: turn - 1, reason: "jev-reached", steps, filledAnswers, skippedNoData };
    }
    await dropNewTabs(page).catch(() => {});
    const frame = page.mainFrame();
    const refs = await snapshotRefs(frame);
    // A field this loop already determined has no canonical answer is marked
    // unselectable (mirrors classifyBlocked's own "not selectable" refs) so
    // jev-drive-core.mjs's buildDecisionRequest never re-offers it as a
    // TYPE_TEXT/SELECT target — it still shows up in `state` as "not
    // selectable" context, same as a file/submit/consent ref.
    for (const r of refs) {
      if ((r.kind === "type" || r.kind === "select") && !r.blocked && knownNoDataLabels.has(normalizeLabel(r.label))) {
        r.blocked = "no-data";
      }
    }

    const decision = await decideStep(
      {
        goal,
        url: page.url(),
        title: await page.title().catch(() => ""),
        refs,
        answersProvided: answers.length > 0,
        historyTail: history.slice(-5),
        submitAllowed,
      },
      request,
    );

    if (decision.operation === "DONE") {
      return { reached: true, turns: turn, reason: goal === "reach" ? "jev-reached" : "jev-done", steps, filledAnswers, skippedNoData };
    }
    if (decision.operation === "BLOCKED") {
      const s = { turn, action: "stuck", detail: decision.reason || "blocked" };
      steps.push(s);
      return { reached: false, turns: turn, reason: "stuck", steps, filledAnswers, skippedNoData };
    }

    const signature = `${decision.operation}:${decision.ref ?? ""}`;
    repeats = signature === lastSignature ? repeats + 1 : 0;
    lastSignature = signature;
    if (repeats >= 3) {
      const s = { turn, action: "stuck", detail: `repeated ${decision.operation} on the same target — handing off` };
      steps.push(s);
      return { reached: false, turns: turn, reason: "stuck", steps, filledAnswers, skippedNoData };
    }

    let detail = "";
    let note = "";
    try {
      const loc = decision.ref ? frame.locator(`[data-co-jev-ref="${decision.ref}"]`).first() : null;
      const ref = refs.find((r) => r.ref === decision.ref);
      if (decision.operation === "CLICK" && loc) {
        const txt = (await loc.innerText().catch(() => "")) || (await loc.getAttribute("value").catch(() => "")) || "";
        if (SUBMIT_RX.test(txt) || CONSENT_RX.test(txt)) {
          note = "refused to click a submit/register/consent control (the human decides)";
          detail = `blocked click "${txt.slice(0, 40)}"`;
        } else {
          detail = `click "${txt.slice(0, 40)}"`;
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await Promise.all([page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {}), loc.click({ timeout: 6000 })]);
        }
      } else if (decision.operation === "SUBMIT" && loc) {
        const txt = (await loc.innerText().catch(() => "")) || (await loc.getAttribute("value").catch(() => "")) || "";
        if (!SUBMIT_RX.test(txt)) {
          note = "refused SUBMIT: target element does not read as a submit control";
          detail = `blocked submit-mismatch "${txt.slice(0, 40)}"`;
        } else {
          detail = `SUBMIT "${txt.slice(0, 40)}"`;
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await Promise.all([page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {}), loc.click({ timeout: 6000 })]);
        }
      } else if (decision.operation === "TYPE_TEXT" && loc) {
        const value = await resolveTypeTextValue(ref?.label || "", answers, request);
        if (value == null) {
          const label = ref?.label || decision.ref;
          recordNoData(label, ref?.required);
          detail = `skipped "${label}" — no canonical answer (recorded as gap${ref?.required ? ", REQUIRED" : ""})`;
        } else {
          detail = `type into "${ref?.label || decision.ref}"`;
          await loc.fill(value).catch(async () => {
            await loc.click();
            await page.keyboard.type(value);
          });
          filledAnswers[decision.ref] = value;
        }
      } else if (decision.operation === "SELECT" && loc) {
        const value = await resolveTypeTextValue(ref?.label || "", answers, request);
        if (value == null) {
          const label = ref?.label || decision.ref;
          recordNoData(label, ref?.required);
          detail = `skipped select "${label}" — no canonical answer (recorded as gap${ref?.required ? ", REQUIRED" : ""})`;
        } else {
          detail = `select "${value}" in "${ref?.label || decision.ref}"`;
          await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
          filledAnswers[decision.ref] = value;
        }
      } else if (decision.operation === "SCROLL") {
        detail = "scroll";
        await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
      } else if (decision.operation === "WAIT") {
        detail = "wait";
      } else {
        detail = `unknown operation ${decision.operation}`;
      }
    } catch (e) {
      detail = `${decision.operation} failed: ${e instanceof Error ? e.message.slice(0, 50) : "err"}`;
    }
    await page.waitForTimeout(700);
    history.push(`${decision.operation} ${decision.ref ?? ""}: ${detail}`.trim());
    const s = { turn, action: decision.operation.toLowerCase(), detail, note: note || undefined };
    steps.push(s);
    if (decision.operation === "SUBMIT" && !note) {
      return { reached: true, turns: turn, reason: "jev-submitted", steps, filledAnswers, skippedNoData };
    }
  }
  return { reached: await isFormReady().catch(() => false), turns: budget, reason: "budget-exhausted", steps, filledAnswers, skippedNoData };
}

// ── pre-submit self-verification ───────────────────────────────────────────

/** Re-reads the REAL form (not the loop's own claims): every filled field's
 *  live DOM value against exactly the value this run chose to type (itself
 *  always copied verbatim from `answers` — resolveTypeTextValue() never
 *  fabricates, see its own docstring/tests), plus diagnose.ts's verifyFill()
 *  for required-empty and on-page validation-error signals. Never treats an
 *  unmatched field as a failure by itself — a field with no canonical answer
 *  is an accepted gap UNLESS it is `required`. Also feeds every real résumé/
 *  CV file input (classifyBlocked's `blocked: 'file'` refs) into verifyFill()
 *  so a required upload that silently failed to land is caught the same way
 *  a required-and-empty text field already is — an OPTIONAL upload is never
 *  a criterion, matching the no-data-isn't-blocking rule everywhere else in
 *  this file. */
export async function selfVerify(frame, refs, filledAnswers) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const typeSelectRefs = refs.filter((r) => (r.kind === "type" || r.kind === "select") && !r.blocked);
  const fileRefs = refs.filter((r) => r.itype === "file" && r.blocked === "file");
  const perField = [];
  for (const r of typeSelectRefs) {
    const intended = filledAnswers[r.ref];
    const loc = frame.locator(`[data-co-jev-ref="${r.ref}"]`).first();
    let actual = "";
    try {
      if (r.kind === "select") {
        // A <select>'s inputValue() returns the OPTION's `value` attribute
        // (e.g. "yes"), but selectOption({label}) was told the option's
        // VISIBLE TEXT (e.g. "Yes") — compare against that text. The
        // placeholder option (empty `value`, e.g. "Select…") must count as
        // NOTHING selected even though its own display text is non-empty.
        const sel = await loc.evaluate((el) => ({ value: el.value || "", text: el.options?.[el.selectedIndex]?.text || "" })).catch(() => ({ value: "", text: "" }));
        actual = sel.value ? sel.text : "";
      } else {
        actual = await loc.inputValue().catch(() => "");
      }
    } catch {
      /* combobox/contenteditable inputs may not support inputValue(); leave actual empty */
    }
    const attempted = intended != null;
    const landed = !!(actual || "").trim();
    const matches = attempted && landed && norm(actual) === norm(intended);
    perField.push({ ref: r.ref, label: r.label, required: r.required, attempted, landed, matches });
  }
  const fields = [
    ...typeSelectRefs.map((r) => ({ id: r.ref, label: r.label, type: r.kind === "select" ? "select-one" : r.itype || "text", required: r.required, combobox: false })),
    ...fileRefs.map((r) => ({ id: r.ref, label: r.label, type: "file", required: r.required, combobox: false })),
  ];
  const issues = await verifyFill(frame, fields, filledAnswers).catch(() => []);
  const requiredEmpty = perField.filter((f) => f.required && !f.landed);
  const mismatched = perField.filter((f) => f.attempted && f.landed && !f.matches);
  const passed = requiredEmpty.length === 0 && mismatched.length === 0 && issues.every((i) => i.level === "info");
  return {
    passed,
    fieldsAttempted: perField.filter((f) => f.attempted).length,
    fieldsFilled: perField.filter((f) => f.landed).length,
    fieldsVerifiedCorrect: perField.filter((f) => f.matches).length,
    requiredEmpty: requiredEmpty.map((f) => f.label),
    mismatched: mismatched.map((f) => f.label),
    issues: issues.map((i) => ({ level: i.level, code: i.code, message: i.message })),
  };
}

async function captureConfirmation(page) {
  await page.waitForTimeout(1500);
  const url = page.url();
  let textSnippet = "";
  try {
    textSnippet = (await page.evaluate(() => document.body?.innerText || "")).replace(/\s+/g, " ").trim().slice(0, 400);
  } catch {
    /* best-effort only — a missing snippet still leaves the URL as evidence */
  }
  return { url, textSnippet };
}

// ── metrics ─────────────────────────────────────────────────────────────────

function makeInstrumentedRequest(jevCalls, phase) {
  return async (state, questions, opts = {}) => {
    let usage = null;
    const result = await postJevChoices(state, questions, { ...opts, onUsage: (u) => (usage = u) });
    jevCalls.push({
      phase,
      model: JEV_MODEL,
      questionIds: Object.keys(questions),
      ok: result !== null,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
    });
    return result;
  };
}

function estimateCostUsd(jevCalls) {
  const rateIn = Number(process.env.JEV_USD_PER_1K_INPUT_TOKENS || 0);
  const rateOut = Number(process.env.JEV_USD_PER_1K_OUTPUT_TOKENS || 0);
  const totals = jevCalls.reduce(
    (acc, c) => ({ input: acc.input + (c.inputTokens || 0), output: acc.output + (c.outputTokens || 0) }),
    { input: 0, output: 0 },
  );
  const usd = (totals.input / 1000) * rateIn + (totals.output / 1000) * rateOut;
  return {
    totalInputTokens: totals.input,
    totalOutputTokens: totals.output,
    usd: Number(usd.toFixed(6)),
    note:
      rateIn || rateOut
        ? "computed from JEV_USD_PER_1K_INPUT_TOKENS / JEV_USD_PER_1K_OUTPUT_TOKENS env rates"
        : "no JEV_USD_PER_1K_INPUT_TOKENS / JEV_USD_PER_1K_OUTPUT_TOKENS env rate configured — TypeSafe/Jev per-token pricing isn't published anywhere in this repo, so this is 0 rather than an invented figure; the token counts above are the real, non-fabricated cost signal",
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { budgetReach: 8, budgetFill: 30, budgetSubmit: 3, out: null, noSubmit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--row") args.row = argv[++i];
    else if (a === "--report") args.report = argv[++i];
    else if (a === "--cv") args.cv = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--no-submit") args.noSubmit = true;
    else if (a === "--submit") args.noSubmit = false;
    else if (a === "--budget-reach") args.budgetReach = Number(argv[++i]);
    else if (a === "--budget-fill") args.budgetFill = Number(argv[++i]);
    else if (a === "--budget-submit") args.budgetSubmit = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function usage() {
  return `ab-jev-apply.mjs — Arm 1 (Jev driver) of the apply-driver A/B test.

  node scripts/ab-jev-apply.mjs --url <application-form-url> [--row <tracker-row>] [--submit|--no-submit]

  --url            required. The job application form URL (or a file:// fixture).
  --row            optional. Tracker row number — used to locate reports/<row>-*.md
                   for its already-vetted "## Application Answers" section.
  --report         optional. Explicit report path, overrides --row lookup.
  --cv             optional. Explicit tailored CV PDF path, overrides the default
                   output/cv-candidate-<company-slug>-*.pdf lookup (newest wins).
  --submit         actually click the final Submit control once verification passes (default).
  --no-submit      fill + verify only; never offers/clicks SUBMIT. Use for dry runs.
  --budget-reach   turn budget for navigating to the form (default 8).
  --budget-fill    turn budget for filling fields (default 30).
  --budget-submit  turn budget for the post-verification submit turn (default 3).
  --out            metrics JSON path (default <root>/data/ab-test/arm1-jev.json).

Requires TYPESAFE_API_KEY in the environment (same variable lib/jev-client.mjs reads) —
without it every Jev call is disabled and the loop escalates to a human handoff.`;
}

async function launchHeadedPage(url) {
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--window-size=1280,940"] });
  } catch {
    browser = await chromium.launch({ headless: false, args: ["--window-size=1280,940"] });
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await dismissConsent(page).catch(() => {});
  return { browser, context, page };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }

  const root = careerOpsRoot();
  const t0 = Date.now();
  const { answers, sources } = loadCanonicalData(root, { row: args.row, reportPath: args.report });
  const jevCalls = [];
  const knownNoDataLabels = new Set();

  console.log(`[ab-jev-apply] TYPESAFE_API_KEY ${isJevDriveEnabled() ? "present — real Jev calls" : "ABSENT — every decision escalates to BLOCKED/handoff"}`);
  console.log(`[ab-jev-apply] canonical sources: ${JSON.stringify(sources)}`);
  console.log(`[ab-jev-apply] ${answers.length} candidate answer(s) loaded`);

  const companySlug = deriveCompanySlug({ reportPath: sources.report, url: args.url });
  const cvResolution = resolveCvPath(root, { explicitCv: args.cv, companySlug });
  console.log(`[ab-jev-apply] CV resolution: ${cvResolution.path ? cvResolution.path : `NONE — ${cvResolution.reason}`}`);

  const { browser, context, page } = await launchHeadedPage(args.url);
  const isFormReady = async () => {
    const refs = await snapshotRefs(page.mainFrame());
    return refs.some((r) => (r.kind === "type" || r.kind === "select") && !r.blocked);
  };

  let outcome = "failed";
  let confirmation = null;
  let verification = null;
  let steps = [];
  let cvAttach = [];
  let fieldsSkippedNoData = [];

  try {
    const reachResult = await driveLoop(page, "reach", isFormReady, args.budgetReach, [], { request: makeInstrumentedRequest(jevCalls, "reach") });
    steps.push(...reachResult.steps.map((s) => ({ ...s, phase: "reach" })));

    // Deterministic, non-Jev step: attach the resolved CV to every résumé/CV
    // file input now that the reach phase has (hopefully) landed on the form.
    // Runs even with cvResolution.path === null (attachCv() then no-ops) so
    // the gap stays visible in cvUploaded below instead of silently absent.
    cvAttach = await attachCv(page.mainFrame(), await snapshotRefs(page.mainFrame()), cvResolution.path);
    for (const a of cvAttach) console.log(`[ab-jev-apply] CV attach "${a.label}" (${a.strategy}): ${a.ok ? "OK" : "FAILED"}`);

    const fillResult = await driveLoop(page, "full", isFormReady, args.budgetFill, answers, {
      fullAutonomous: true,
      verified: false,
      request: makeInstrumentedRequest(jevCalls, "fill"),
      knownNoDataLabels,
    });
    steps.push(...fillResult.steps.map((s) => ({ ...s, phase: "fill" })));
    fieldsSkippedNoData.push(...fillResult.skippedNoData);

    const refsAfterFill = await snapshotRefs(page.mainFrame());
    verification = await selfVerify(page.mainFrame(), refsAfterFill, fillResult.filledAnswers);
    console.log(`[ab-jev-apply] pre-submit verification: ${verification.passed ? "PASSED" : "FAILED"} — ${JSON.stringify(verification)}`);

    if (args.noSubmit) {
      outcome = "skipped (--no-submit)";
    } else if (!verification.passed) {
      outcome = "blocked";
    } else {
      const submitResult = await driveLoop(page, "full", isFormReady, args.budgetSubmit, answers, {
        fullAutonomous: true,
        verified: true,
        request: makeInstrumentedRequest(jevCalls, "submit"),
        knownNoDataLabels,
      });
      steps.push(...submitResult.steps.map((s) => ({ ...s, phase: "submit" })));
      fieldsSkippedNoData.push(...submitResult.skippedNoData);
      if (submitResult.reason === "jev-submitted") {
        confirmation = await captureConfirmation(page);
        outcome = "submitted+confirmed";
      } else if (submitResult.reason === "stuck") {
        outcome = "blocked";
      } else {
        outcome = "failed";
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const wallClockSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
  const blockedSteps = steps.filter((s) => s.action === "stuck");
  const refusedSteps = steps.filter((s) => (s.note || "").includes("refused"));
  const cost = estimateCostUsd(jevCalls);

  const metrics = {
    arm: "arm1-jev",
    row: args.row ?? null,
    url: args.url,
    startedAt: new Date(t0).toISOString(),
    wallClockSeconds,
    canonicalSources: sources,
    fieldsAttempted: verification?.fieldsAttempted ?? 0,
    fieldsFilled: verification?.fieldsFilled ?? 0,
    fieldsVerifiedCorrect: verification?.fieldsVerifiedCorrect ?? 0,
    verification,
    cvUploaded: {
      path: cvResolution.path,
      uploaded: cvAttach.length > 0 && cvAttach.every((a) => a.ok),
      // Which target-match tier landed the CV — "name" (label/id/aria-label
      // matched RESUME_LABEL_RX) or "accept-fallback" (no label match; the
      // file input's accept list matched DOCUMENT_ACCEPT_RX instead, as on
      // the real Avahi BambooHR form's unnamed upload field). null when no
      // attempt was made (no target found, or cvResolution.path was null).
      strategy: cvAttach[0]?.strategy ?? null,
      attempts: cvAttach,
      gapReason: cvResolution.path ? null : cvResolution.reason,
    },
    fieldsSkippedNoData,
    jev: {
      calls: jevCalls.length,
      // this driver never makes a free-text generative call (every Jev call is
      // a typed CHOICE — see jev-drive-core.mjs's module docstring); reported
      // as its own zeroed field so the A/B comparison against turbo-apply's
      // generative-model calls is apples-to-apples, not an omission.
      smallLlmTextGenerationCalls: 0,
      smallLlmTextGenerationTokens: { input: 0, output: 0 },
      totalInputTokens: cost.totalInputTokens,
      totalOutputTokens: cost.totalOutputTokens,
    },
    decisionSteps: steps.length,
    browserActions: steps.filter((s) => !["wait", "stuck"].includes(s.action)).length,
    blocks: blockedSteps.length,
    handoffs: blockedSteps.length, // every BLOCKED outcome in this driver IS a human handoff, by construction
    retries: refusedSteps.length,
    submitOutcome: outcome,
    confirmationEvidence: confirmation,
    estimatedUsd: cost.usd,
    costNote: cost.note,
    humanInterventions: 0,
    steps,
  };

  const outPath = args.out ? path.resolve(args.out) : path.join(root, "data", "ab-test", "arm1-jev.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2) + "\n");
  console.log(`[ab-jev-apply] outcome: ${outcome}`);
  console.log(`[ab-jev-apply] metrics written to ${outPath}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[ab-jev-apply] fatal:", e instanceof Error ? e.stack : e);
    process.exit(1);
  });
}
