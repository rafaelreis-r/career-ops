#!/usr/bin/env node
// arm1-jev-agentbrowser.mjs — Arm 1 of the Jev-vs-turbo-apply A/B test, built on
// the LINKED libraries (no bespoke driver):
//
//   - forvela/jev-agent-browser  — the Jev decision loop (`runLoop`) and its own
//     `AgentBrowser` adapter. We use the Node API in-process against ONE
//     persistent session, and drive the form FIELD BY FIELD: each field is a
//     bounded subtask (the library's documented "short-horizon subtask"
//     pattern), which keeps the typed-decision loop from flailing across a
//     re-rendering React form the way a single "fill everything" goal does.
//   - vercel-labs/agent-browser  — the native engine the adapter shells out to.
//     Its native `upload` command attaches the CV to the unnamed accept-typed
//     file input; we then dispatch input/change so a React-controlled form
//     registers the file.
//
// The library does not export its AgentBrowser through package `exports`, so we
// import it by file URL from the installed package — the library's own code,
// not a reimplementation. Values are resolved locally by this parent and handed
// to the loop as inputValues (the library's documented contract); nothing is
// fabricated — a field with no canonical answer is never filled.
//
// Run (from web/):
//   node scripts/arm1-jev-agentbrowser.mjs --url <form-or-fixture> --cv <pdf> --no-submit [--headed]
//   node scripts/arm1-jev-agentbrowser.mjs --url <real-form> --row 703 --cv <pdf> --submit --headed
//
// Install once (node_modules is gitignored):
//   npm install --no-save agent-browser jev-agent-browser
//   node node_modules/agent-browser/scripts/postinstall.js   # fetch native binary
//
// TYPESAFE_API_KEY is read from the environment; this script sets nothing and
// reads no other credential.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as yaml from "js-yaml";
import { isMainModule } from "../../lib/is-main-module.mjs";
import { loadCanonicalData, resolveCvPath, deriveCompanySlug, DOCUMENT_ACCEPT_RX } from "./ab-jev-apply.mjs";
import { matchAnswer, resolveFields } from "./arm1-salary.mjs";

const require = createRequire(import.meta.url);
const JEV_PKG = require.resolve("jev-agent-browser/package.json");
const JEV_DIR = path.dirname(JEV_PKG);
// runLoop + requestDecision from the package root; AgentBrowser by file URL
// (the package's `exports` map only exposes "." and package.json).
const { runLoop, requestDecision } = await import("jev-agent-browser");
const { AgentBrowser } = await import(pathToFileURL(path.join(JEV_DIR, "src", "browser.js")).href);

function careerOpsRoot() {
  const env = process.env.CAREER_OPS_ROOT?.trim();
  return env || path.resolve(process.cwd(), "..");
}

/** answersFromProfile() (inside loadCanonicalData) does not map a salary/pay
 *  answer, but real forms ask for it as a required field. Derive Desired Pay
 *  from the documented compensation anchor in config/profile.yml — the USD
 *  per-month floor stated verbatim there — never an invented figure. */
function salaryAnswers(root) {
  try {
    const p = yaml.load(fs.readFileSync(path.join(root, "config", "profile.yml"), "utf8"));
    const comp = p?.compensation || {};
    const src = `${comp.target_range || ""} ${comp.minimum || ""}`;
    const m = src.match(/USD\s*\$?\s*(\d+)\s*K\s*\/?\s*month/i);
    if (!m) return [];
    const value = `USD ${Number(m[1]) * 1000}/month`;
    const answer = { value, kind: "desired-compensation", currency: "USD" };
    return ["Desired Pay","Desired Salary","Salary","Salary Expectation","Expected Salary","Expected Compensation","Compensation Expectation","Pretensão salarial"]
      .map((label) => ({ label, ...answer }));
  } catch {
    return [];
  }
}
/** Lowercase, collapse whitespace — the normalization the loop's
 * resolveInputValue() applies to a field's accessible name before lookup. */
function normKey(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}


/** Key each matched field's value under every lookup key the loop's
 *  resolveInputValue() tries: ref, name, normalized name, role:name. */
function buildInputValues(matched) {
  const values = {};
  for (const { ref, name, role, value } of matched) {
    for (const key of [ref, name, normKey(name), `${role}:${normKey(name)}`]) {
      if (key) values[key] = value;
    }
  }
  return values;
}

/** Bring the real application form on screen (BambooHR/Avahi render it only
 *  after an "Apply for This Job" click, sometimes behind a consent banner).
 *  Probe for genuine form fields (named identity field, file input, or an
 *  identity label) — not any textbox, since the careers page ships a job-search
 *  box first — clicking consent + apply until the form appears. */
async function reachForm(browser) {
  const probe = async () => {
    try {
      const r = await browser.eval(`(() => {
        const q = (s) => document.querySelector(s);
        const byLabel = [...document.querySelectorAll('label')].some((l) => /first name|last name|email|linkedin|desired pay/i.test(l.textContent || ''));
        return { hasForm: !!(q('input[name=firstName]') || q('input[name=email]') || q('input[name=lastName]') || q('input[type=file]') || byLabel) };
      })()`);
      return r?.hasForm === true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 8; i++) {
    if (await probe()) break;
    await browser.eval(`(() => {
      const clickByText = (rx) => {
        const el = [...document.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit]')]
          .find(e => rx.test(((e.textContent || e.value || '')).trim()));
        if (el) { el.click(); return true; }
        return false;
      };
      clickByText(/accept|agree|got it|allow all|aceitar|concordo/i);
      clickByText(/candidatar-se a este emprego|apply for this job|apply now|start application|^apply$|^candidatar/i);
      return true;
    })()`).catch(() => {});
    await sleep(2500);
  }
  return browser.snapshot();
}

/** Attach the CV to the document-accepting file input via agent-browser's
 *  native upload, then dispatch input/change so a React-controlled form
 *  registers it. Returns { uploaded, strategy, accept, error }. */
async function attachCv(browser, cvPath) {
  const pick = await browser.eval(`(() => {
    const inputs = [...document.querySelectorAll('input[type=file]')];
    const doc = inputs.find(el => ${DOCUMENT_ACCEPT_RX}.test(el.getAttribute('accept') || ''));
    const el = doc || inputs[0];
    if (!el) return null;
    el.setAttribute('data-arm1-cv', '1');
    return { accept: el.getAttribute('accept') || '', strategy: doc ? 'accept' : 'first', total: inputs.length };
  })()`).catch(() => null);
  if (!pick || !pick.total) return { uploaded: false, strategy: null, accept: null, error: "no file input" };
  const up = await browser.run(["upload", "input[data-arm1-cv]", cvPath]).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: String(e.message || e) }));
  if (up.ok) {
    await browser.eval(`(() => {
      const el = document.querySelector('input[data-arm1-cv]');
      if (el) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      return true;
    })()`).catch(() => {});
  }
  return { uploaded: up.ok, strategy: pick.strategy, accept: pick.accept, error: up.error ?? null };
}

/** Read the live DOM to verify what actually landed. BambooHR consumes the
 *  file <input> into a hidden resumeFileId and shows the filename, so the CV is
 *  "attached" when any file input holds a file, OR a resume/attachment hidden
 *  field has a value, OR the uploaded filename appears on the page. */
async function verifyDom(browser, cvBasename) {
  const cvName = JSON.stringify(cvBasename || "");
  return browser.eval(`(() => {
    const out = { fields: [], fileAttached: false };
    for (const el of document.querySelectorAll('input, select, textarea')) {
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (type === 'file') { if (el.files && el.files.length) out.fileAttached = true; continue; }
      if (type === 'hidden') { if (/resume|cv|attachment|file/i.test(el.getAttribute('name') || '') && (el.value || '').trim()) out.fileAttached = true; continue; }
      if (['submit', 'button', 'reset'].includes(type)) continue;
      const label = (document.querySelector('label[for="' + el.id + '"]')?.textContent || el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '').replace(/\\s+/g, ' ').trim();
      out.fields.push({ label, type, required: el.required === true || /\\*/.test(label), value: (el.value || '').trim() });
    }
    const cvName = ${cvName};
    if (cvName && (document.body?.innerText || '').includes(cvName)) out.fileAttached = true;
    return out;
  })()`);
}

/** Compare live DOM values to the intended (fuzzy-matched) canonical values. */
function summarizeVerification(dom, answers, cvPath) {
  const fields = Array.isArray(dom?.fields) ? dom.fields : [];
  const per = [];
  for (const f of fields) {
    const intended = matchAnswer(f.label, answers);
    const attempted = intended != null;
    const landed = !!(f.value || "").trim();
    const matches = attempted && landed && normKey(f.value) === normKey(intended);
    per.push({ label: f.label, required: f.required, attempted, landed, matches });
  }
  const requiredEmpty = per.filter((f) => f.required && !f.landed).map((f) => f.label);
  const mismatched = per.filter((f) => f.attempted && f.landed && !f.matches).map((f) => f.label);
  const fileAttached = dom?.fileAttached === true;
  return {
    passed: requiredEmpty.length === 0 && mismatched.length === 0 && (!cvPath || fileAttached),
    fieldsAttempted: per.filter((f) => f.attempted).length,
    fieldsFilled: per.filter((f) => f.landed).length,
    fieldsVerifiedCorrect: per.filter((f) => f.matches).length,
    requiredEmpty,
    mismatched,
    fileAttached,
  };
}

/** Click the final submit control and capture a confirmation snippet. */
async function submit(browser) {
  const found = await browser.eval(`(() => {
    const rx = /submit|apply|enviar|send application|candidatura/i;
    const els = [...document.querySelectorAll('button, input[type=submit], [role=button]')];
    const el = els.find(e => (e.getAttribute('type') || '').toLowerCase() === 'submit') || els.find(e => rx.test((e.textContent || e.value || '').trim()));
    if (!el) return null;
    el.setAttribute('data-arm1-submit', '1');
    return { text: (el.textContent || el.value || '').trim().slice(0, 60) };
  })()`).catch(() => null);
  if (!found) return { ok: false };
  await browser.run(["click", "[data-arm1-submit]"]).catch(() => {});
  await sleep(2500);
  const confirmation = await browser.eval(`({ url: location.href, text: (document.body?.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 500) })`).catch(() => null);
  return { ok: true, confirmation };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { noSubmit: true, maxSteps: 6, session: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--row") args.row = argv[++i];
    else if (a === "--report") args.report = argv[++i];
    else if (a === "--cv") args.cv = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--session") args.session = argv[++i];
    else if (a === "--max-steps") args.maxSteps = Number(argv[++i]);
    else if (a === "--headed") args.headed = true;
    else if (a === "--submit") args.noSubmit = false;
    else if (a === "--no-submit") args.noSubmit = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function usage() {
  return `arm1-jev-agentbrowser.mjs — Arm 1 (Jev driver on the linked libraries).

  node scripts/arm1-jev-agentbrowser.mjs --url <form-url> [--row N] [--cv PDF] [--submit|--no-submit] [--headed]

  --url         required. Application form URL, or a file:// fixture for a dry run.
  --row         optional. Tracker row -> reports/<row>-*.md Application Answers.
  --cv          optional. Tailored CV PDF (overrides the company-slug default).
  --submit      click the final Submit once verification passes.
  --no-submit   fill + upload + verify only (DEFAULT).
  --headed      show the browser window.
  --max-steps   per-field loop step budget (default 6).
  --out         metrics JSON path (default <root>/data/ab-test/arm1-jev.json).

Requires TYPESAFE_API_KEY in the environment.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.error("[arm1-ab] TYPESAFE_API_KEY absent — the loop cannot decide. Aborting.");
    process.exit(2);
  }

  const root = careerOpsRoot();
  const session = args.session || `arm1-${process.pid}`;
  const t0 = Date.now();

  const loaded = loadCanonicalData(root, { row: args.row, reportPath: args.report });
  const sources = loaded.sources;
  const answers = [...loaded.answers, ...salaryAnswers(root)];
  const companySlug = deriveCompanySlug({ reportPath: sources.report, url: args.url });
  const cvResolution = resolveCvPath(root, { explicitCv: args.cv, companySlug });

  console.log(`[arm1-ab] session=${session}`);
  console.log(`[arm1-ab] canonical sources: ${JSON.stringify(sources)}`);
  console.log(`[arm1-ab] ${answers.length} candidate answer(s) loaded`);
  console.log(`[arm1-ab] CV: ${cvResolution.path || `NONE — ${cvResolution.reason}`}`);

  // Token capture: wrap the decision call so we can sum any usage the TypeSafe
  // response carries. Jev calls are typed CHOICE/NOUL, not chat; usage may be
  // absent, in which case totals stay null (unmeasured, not zero).
  const jevCalls = [];
  const decide = async ({ apiKey: k, request }) => {
    const r = await requestDecision({ apiKey: k, request });
    const u = r?.raw?.usage ?? r?.raw?.usageMetadata ?? r?.raw?.meta?.usage ?? null;
    jevCalls.push({
      inputTokens: u?.input_tokens ?? u?.inputTokens ?? u?.prompt_tokens ?? null,
      outputTokens: u?.output_tokens ?? u?.outputTokens ?? u?.completion_tokens ?? null,
    });
    return r;
  };

  const events = [];
  const onEvent = (ev) => { if (ev?.type === "step") events.push(ev); };

  const browser = new AgentBrowser({ session, browserArgs: args.headed ? ["--headed"] : [] });

  let outcome = "failed";
  let matched = [];
  let verification = null;
  let cv = { path: cvResolution.path, uploaded: false, strategy: null, accept: null, error: null };
  let rejected = [];
  let confirmation = null;
  let fieldResults = [];

  try {
    await browser.open(args.url);
    const formSnap = await reachForm(browser);
    const fieldResolution = resolveFields(formSnap.refs, answers);
    matched = fieldResolution.matched;
    rejected = fieldResolution.rejected;
    if (rejected.length) {
      console.log(`[arm1-ab] guarded ${rejected.length} field(s): ${rejected.map((field) => `${field.name} [${field.reason}]`).join(" | ")}`);
    }
    console.log(`[arm1-ab] resolved ${matched.length} field(s): ${matched.map((m) => m.name).join(" | ") || "(none)"}`);
    if (matched.length === 0) throw new Error("no fillable field matched a canonical answer; nothing to fill");

    const inputValues = buildInputValues(matched);

    // Fill FIELD BY FIELD — each a bounded single-field subtask so the typed
    // loop cannot flail across the re-rendering form. The full inputValues map
    // is passed each time so the loop can resolve whichever ref it targets.
    for (const m of matched) {
      const res = await runLoop({
        browser,
        apiKey,
        decide,
        onEvent,
        inputValues,
        goal: `Type the provided value into the "${m.name}" field, then stop. Do not click Submit or Apply and do not touch any other field.`,
        subtask: `Fill "${m.name}"`,
        maxSteps: args.maxSteps,
        repeatLimit: 2,
        maxRecoveryAttempts: 2,
      });
      fieldResults.push({ field: m.name, status: res.status, reason: res.reason, steps: res.steps });
      console.log(`[arm1-ab]   ${m.name}: ${res.status} (${res.reason}, ${res.steps} step(s))`);
    }

    // Attach the CV (native upload + React event dispatch).
    if (cvResolution.path) {
      cv = { path: cvResolution.path, ...(await attachCv(browser, cvResolution.path)) };
      console.log(`[arm1-ab] CV upload (${cv.strategy}): ${cv.uploaded ? "OK" : "FAILED — " + cv.error}`);
    }

    const dom = await verifyDom(browser, cvResolution.path ? path.basename(cvResolution.path) : "");
    verification = summarizeVerification(dom, answers, cvResolution.path);
    console.log(`[arm1-ab] verification: ${verification.passed ? "PASSED" : "FAILED"} — ${JSON.stringify(verification)}`);

    if (args.noSubmit) {
      outcome = "skipped (--no-submit)";
    } else if (!verification.passed) {
      outcome = "blocked";
    } else {
      const s = await submit(browser);
      if (s.ok) {
        confirmation = s.confirmation;
        // A real confirmation is text on the page, not a bare click. Judge by
        // whether the page changed to a thank-you/confirmation state.
        const conf = (confirmation?.text || "").toLowerCase();
        outcome = /obrigado|thank you|received|submitted|recebemos|sua candidatura|application/i.test(conf) ? "submitted+confirmed" : "submitted (unconfirmed)";
      } else {
        outcome = "blocked";
      }
    }
  } catch (e) {
    console.error(`[arm1-ab] error: ${e instanceof Error ? e.message : e}`);
    outcome = "failed";
  } finally {
    // Persist the headed tab when the outcome needs a human (captcha, cookie
    // consent, or an unconfirmed submit): the agent-browser session is a named,
    // persistent browser, so NOT closing leaves the window open after this
    // process exits, for the captain to complete manually and avoid losing the
    // application. Clean outcomes close normally.
    const persist = args.headed && (outcome === "blocked" || outcome === "submitted (unconfirmed)");
    if (persist) {
      console.log(`[arm1-ab] TAB LEFT OPEN (session=${session}) — outcome "${outcome}". Solve any captcha/consent and click submit manually, then close the window.`);
    } else {
      await browser.close().catch(() => {});
    }
  }

  const wallClockSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
  const decisionSteps = events.length;
  const browserActions = events.filter((e) => e.action?.executed).length;
  const tokIn = jevCalls.reduce((a, c) => a + (c.inputTokens || 0), 0);
  const tokOut = jevCalls.reduce((a, c) => a + (c.outputTokens || 0), 0);
  const tokensMeasured = jevCalls.some((c) => c.inputTokens != null || c.outputTokens != null);

  const metrics = {
    arm: "arm1-jev",
    driver: "jev-agent-browser Node API (runLoop, per-field subtasks) + agent-browser native upload",
    row: args.row ?? null,
    url: args.url,
    startedAt: new Date(t0).toISOString(),
    wallClockSeconds,
    canonicalSources: sources,
    fieldsResolved: matched.length,
    fieldsRejected: rejected.length,
    rejectedFields: rejected,
    fieldResults,
    fieldsAttempted: verification?.fieldsAttempted ?? 0,
    fieldsFilled: verification?.fieldsFilled ?? 0,
    fieldsVerifiedCorrect: verification?.fieldsVerifiedCorrect ?? 0,
    verification,
    cvUploaded: cv,
    jev: {
      calls: jevCalls.length,
      decisionSteps,
      totalInputTokens: tokensMeasured ? tokIn : null,
      totalOutputTokens: tokensMeasured ? tokOut : null,
    },
    decisionSteps,
    browserActions,
    submitOutcome: outcome,
    confirmationEvidence: confirmation,
    estimatedUsd: null,
    costNote: tokensMeasured ? "token counts from the TypeSafe response usage" : "TypeSafe response carried no usage field; token/USD unmeasured (not zero).",
    humanInterventions: 0,
  };

  const outPath = args.out ? path.resolve(args.out) : path.join(root, "data", "ab-test", "arm1-jev.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2) + "\n");
  console.log(`[arm1-ab] outcome: ${outcome}`);
  console.log(`[arm1-ab] metrics written to ${outPath}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[arm1-ab] fatal:", e instanceof Error ? e.stack : e);
    process.exit(1);
  });
}
