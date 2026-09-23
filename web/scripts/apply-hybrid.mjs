#!/usr/bin/env node
// apply-hybrid.mjs — hybrid application filler: ONE Stagehand observation per
// form, deterministic Playwright execution, and typed Jev judgment only where a
// label is ambiguous. It lives beside arm1-jev-agentbrowser.mjs (the per-field
// Jev loop) so both can run on the same form and be compared; routing is
// unchanged until this path proves it replaces that one.
//
//   1. Reach the form (click the apply trigger when the page has no fields yet).
//   2. Stagehand observe() once: which controls belong to the application.
//   3. DOM scan: label, required flag and state of every question, read from
//      the page, never from the model.
//   4. Answers: exact label match locally; the rest in ONE batched Jev choice
//      call with NONE; money answers in a field naming another currency lock.
//   5. Adapters act and re-read the DOM. Progress is what the page shows.
//   6. The CV goes only to an input identified as the résumé by its label/
//      context and whose `accept` admits the file.
//   7. Gate from the final DOM scan: any required question still empty, any
//      value that differs, or a captcha keeps `ready` false.
//
// It never submits. `ready: true` means a human (or the LLM-owned worker) may
// press submit; `ready: false` lists what blocks it. Exit code: 0 ready,
// 3 blocked by the gate, 1 run failure.
//
// Run (from web/):
//   node scripts/apply-hybrid.mjs --url <form-url> [--row N | --report <md>] [--cv <pdf>] [--headed] [--out <json>]
//
// Needs `codex` logged in (Stagehand's model callback) and TYPESAFE_API_KEY for
// Jev; without the key, ambiguous labels stay unanswered (never guessed).

import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { jevAsk, jevChoice } from '../../lib/jev-client.mjs';
import { pickOption } from '../../lib/jev-apply-helpers.mjs';
import { loadCanonicalData, resolveCvPath, deriveCompanySlug } from './ab-jev-apply.mjs';
import { scanPage } from '../src/lib/apply/hybrid/page-scan.mjs';
import { buildAnswers, matchAnswers, matchOption, normalizeText, truthyAnswer } from '../src/lib/apply/hybrid/answers.mjs';
import { selectResumeTarget } from '../src/lib/apply/hybrid/files.mjs';
import { evaluateGate } from '../src/lib/apply/hybrid/gate.mjs';
import { fillText, selectNative, chooseOption, selectCombobox, attachFile, reachApplicationForm, reread } from '../src/lib/apply/hybrid/adapters.mjs';
import { launchBrowser, observeOnce, mapActionsToQuestions, createCodexGenerate } from '../src/lib/apply/hybrid/stagehand.mjs';

function careerOpsRoot() {
  return process.env.CAREER_OPS_ROOT?.trim() || path.resolve(process.cwd(), '..');
}

function parseArgs(argv) {
  const args = { headed: false, maxSeconds: 285, observeTimeoutSeconds: 150 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i];
    else if (a === '--row') args.row = argv[++i];
    else if (a === '--report') args.report = argv[++i];
    else if (a === '--cv') args.cv = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--headed') args.headed = true;
    else if (a === '--no-submit') args.noSubmit = true; // accepted for parity with arm1; this driver never submits
    else if (a === '--max-seconds') args.maxSeconds = Number(argv[++i]);
    else if (a === '--observe-timeout') args.observeTimeoutSeconds = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const USAGE = `apply-hybrid.mjs — fill an application form (Stagehand observe once + deterministic adapters + Jev for ambiguity). Never submits.

  node scripts/apply-hybrid.mjs --url <form-url> [--row N | --report <md>] [--cv <pdf>] [--headed] [--out <json>]

  --url              required. Job page or application form URL.
  --row / --report   the report whose "Application Answers" are canonical for this posting.
  --cv               CV PDF (default: newest output/cv-candidate-<company>-*.pdf).
  --headed           visible browser; left open for a human when the gate blocks.
  --max-seconds      fill deadline for the whole form (default 285).
  --observe-timeout  cap for the one Stagehand observation (default 150).
  --out              metrics JSON (default <root>/data/ab-test/hybrid.json).

Exit: 0 ready to submit, 3 blocked by the pre-submit gate, 1 run failure.`;

/** Offered option for a canonical value: deterministic, else one Jev pick. */
async function resolveOptionIndex(q, value, pick) {
  const m = matchOption(q.options, value);
  if (m) return { index: m.index, how: m.how };
  const r = await pick(q.options, { label: q.label, desiredValue: value });
  return r?.index != null ? { index: r.index, how: 'jev-pick' } : null;
}

/** Execute one question with the adapter for its widget. */
async function fillQuestion(frame, q, value, pick) {
  switch (q.kind) {
    case 'text':
    case 'textarea':
      return fillText(frame, q, value);
    case 'combobox':
      return selectCombobox(frame, q, value, { pick });
    case 'checkbox': {
      const want = truthyAnswer(value);
      if (want === null) return { status: 'no-option', reason: 'the canonical answer is not a yes/no for a single checkbox' };
      if (want === false) return (q.state?.selected || []).length ? { status: 'mismatch', reason: 'checked on the page, canonical answer is no' } : { status: 'verified', observed: 'unchecked' };
      return chooseOption(frame, q, 0);
    }
    case 'select':
    case 'radio':
    case 'checkbox-group':
    case 'toggle': {
      const opt = await resolveOptionIndex(q, value, pick);
      if (!opt) return { status: 'no-option', reason: 'no offered option represents the canonical value', offered: (q.options || []).slice(0, 12) };
      const r = q.kind === 'select' ? await selectNative(frame, q, opt.index) : await chooseOption(frame, q, opt.index);
      return { ...r, how: opt.how };
    }
    default:
      return { status: 'failed', reason: `no adapter for ${q.kind}` };
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (args.help || !args.url) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const root = careerOpsRoot();
  const t0 = Date.now();
  const deadline = t0 + args.maxSeconds * 1000;
  const loaded = loadCanonicalData(root, { row: args.row, reportPath: args.report });
  const answers = buildAnswers(loaded.reportAnswers, loaded.profileAnswers);
  const cvRes = resolveCvPath(root, { explicitCv: args.cv, companySlug: deriveCompanySlug({ reportPath: loaded.sources.report, url: args.url }) });
  const cvName = cvRes.path ? path.basename(cvRes.path) : '';
  console.log(`[hybrid] canonical sources: ${JSON.stringify(loaded.sources)}`);
  console.log(`[hybrid] ${answers.length} canonical answer(s); CV: ${cvRes.path || `NONE (${cvRes.reason})`}`);

  const calls = { stagehand: 0, stagehandMs: 0, jev: 0 };
  const generate = createCodexGenerate({ onCall: ({ ms }) => { calls.stagehand++; calls.stagehandMs += ms; } });
  const ask = (a) => { calls.jev++; return jevAsk(a); };
  const choice = (a) => { calls.jev++; return jevChoice(a); };
  const pick = (options, target) => pickOption(options, target, { jev: choice });

  const outcomes = new Map();
  const phases = {};
  const phase = async (name, fn) => {
    const s = Date.now();
    try {
      return await fn();
    } finally {
      phases[name] = Number(((Date.now() - s) / 1000).toFixed(1));
    }
  };
  const metrics = { driver: 'hybrid (stagehand observe x1 + playwright adapters + jev for ambiguity)', url: args.url, row: args.row ?? null, startedAt: new Date(t0).toISOString(), canonicalSources: loaded.sources, phases };
  let browser = null;
  let gate = { ready: false, blockers: [] };
  let stoppedAt = null;
  let failed = false;

  try {
    browser = await phase('launch', () => launchBrowser({ headless: !args.headed }));
    const { page } = browser;
    await phase('navigate', async () => {
      await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    });
    const reach = await phase('reachForm', () => reachApplicationForm(page));
    metrics.reach = reach;
    console.log(`[hybrid] form ${reach.reached ? 'reached' : 'NOT reached'} at ${reach.url}${reach.log.length ? ` after ${reach.log.map((l) => `"${l.clicked}"`).join(', ')}` : ''}`);
    if (!reach.reached) throw new Error(`form not reached: ${reach.reason}`);

    const scan = await phase('scan', () => scanPage(page));
    const obs = await phase('observe', () => observeOnce(browser.shBrowser, generate, { pageUrl: page.url(), timeoutMs: args.observeTimeoutSeconds * 1000 }));
    let targets;
    if (obs.ok) {
      const { keys, unmapped } = await phase('mapObserved', () => mapActionsToQuestions(page, obs.actions));
      targets = scan.questions.filter((q) => keys.has(q.key));
      metrics.discovery = { method: 'stagehand-observe', ms: obs.ms, actions: obs.actions.length, questionsObserved: keys.size, unmapped, cache: obs.cache, questionsScanned: scan.questions.length };
    } else {
      targets = scan.questions;
      metrics.discovery = { method: 'dom-scan (observe failed)', ms: obs.ms, error: obs.error, questionsScanned: scan.questions.length };
    }
    console.log(`[hybrid] discovery: ${metrics.discovery.method} in ${(obs.ms / 1000).toFixed(1)}s, ${targets.length} of ${scan.questions.length} scanned question(s) targeted`);

    const fillable = targets.filter((q) => q.kind !== 'file' && q.visible);
    const { decisions, jev } = await phase('matchAnswers', () => matchAnswers(fillable, answers, { ask }));
    metrics.answerMatching = { exact: [...decisions.values()].filter((d) => d.source === 'exact').length, jev: [...decisions.values()].filter((d) => d.source === 'jev').length, jevError: jev.error, jevEnabled: jev.enabled };

    const fillStart = Date.now();
    for (const q0 of fillable) {
      if (Date.now() > deadline) {
        stoppedAt = `deadline reached before "${q0.label}"`;
        break;
      }
      const d = decisions.get(q0.key);
      if (!d.answer) {
        outcomes.set(q0.key, { status: 'no-answer', reason: 'no canonical answer', confidence: d.confidence, label: q0.label, kind: q0.kind });
        continue;
      }
      if (d.lock) {
        outcomes.set(q0.key, { status: 'locked', reason: `${d.lock.reason}: field ${d.lock.fieldCurrency}, answer ${d.lock.answerCurrency ?? 'unstated'}`, answerLabel: d.answer.label, label: q0.label, kind: q0.kind });
        continue;
      }
      const frame = scan.frameObjs[q0.frame];
      const started = Date.now();
      let r;
      let q = q0;
      try {
        q = await reread(frame, q0);
        r = q ? await fillQuestion(frame, q, d.answer.value, pick) : { status: 'failed', reason: 'the question left the page before it was filled' };
      } catch (e) {
        r = { status: 'failed', reason: String(e?.message || e).split('\n')[0].slice(0, 200) };
      }
      outcomes.set((q || q0).key, { ...r, source: d.source, confidence: d.confidence, answerLabel: d.answer.label, label: q0.label, kind: q0.kind, ms: Date.now() - started });
    }
    phases.fill = Number(((Date.now() - fillStart) / 1000).toFixed(1));

    const sel = selectResumeTarget(scan.questions.filter((q) => q.kind === 'file'), cvRes.path || 'cv.pdf');
    metrics.cv = { path: cvRes.path, target: sel.target ? { key: sel.target.key, label: sel.target.label } : null, reason: sel.reason, considered: sel.considered };
    if (cvRes.path && sel.target && Date.now() <= deadline) {
      let r;
      try {
        r = await phase('attachCv', () => attachFile(scan.frameObjs[sel.target.frame], sel.target, cvRes.path, cvName));
      } catch (e) {
        r = { status: 'failed', reason: String(e?.message || e).split('\n')[0].slice(0, 200) };
      }
      outcomes.set(sel.target.key, { ...r, source: 'cv', label: sel.target.label, kind: 'file' });
      metrics.cv.status = r.status;
    }

    const finalScan = await phase('finalScan', () => scanPage(page));
    // Outcomes follow a question across a re-render that replaced its node
    // (new key): same widget kind and same label is the same question.
    const byLabel = new Map([...outcomes.values()].map((o) => [`${o.kind}|${normalizeText(o.label)}`, o]));
    const finalOutcomes = new Map(finalScan.questions.map((q) => [q.key, outcomes.get(q.key) ?? byLabel.get(`${q.kind}|${normalizeText(q.label)}`)]).filter(([, o]) => o));
    gate = evaluateGate(finalScan, finalOutcomes, { cvName });
    metrics.questions = finalScan.questions.map((q) => ({
      key: q.key, kind: q.kind, label: q.label, required: q.required, requiredBy: q.requiredBy, visible: q.visible,
      observed: targets.some((t) => t.key === q.key || (t.kind === q.kind && normalizeText(t.label) === normalizeText(q.label))), outcome: finalOutcomes.get(q.key) ?? null,
    }));
    metrics.captcha = finalScan.captcha;
  } catch (e) {
    failed = true;
    stoppedAt = stoppedAt || String(e?.message || e).split('\n')[0];
    console.error(`[hybrid] error: ${stoppedAt}`);
  } finally {
    const keepOpen = args.headed && !failed && !gate.ready;
    if (keepOpen) console.log('[hybrid] TAB LEFT OPEN for a human: the gate blocks (see blockers).');
    else await browser?.shBrowser.close().catch(() => {});
  }

  const all = [...outcomes.values()];
  const verified = all.filter((o) => o.status === 'verified');
  metrics.wallClockSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
  metrics.modelCalls = { total: calls.stagehand + calls.jev, stagehandObserve: calls.stagehand, stagehandSeconds: Number((calls.stagehandMs / 1000).toFixed(1)), jev: calls.jev };
  metrics.summary = {
    fieldsVerified: verified.length,
    fieldsFailed: all.filter((o) => ['failed', 'mismatch', 'unverified'].includes(o.status)).length,
    noCanonicalAnswer: all.filter((o) => o.status === 'no-answer' || o.status === 'no-option').length,
    locked: all.filter((o) => o.status === 'locked').length,
    requiredEmpty: gate.blockers.filter((b) => b.key && /required and empty/.test(b.reason)).map((b) => b.label),
    cvAttachedTo: metrics.cv?.status === 'verified' ? metrics.cv.target.label : null,
  };
  metrics.gate = gate;
  metrics.stoppedAt = stoppedAt || (gate.ready ? 'ready for a human to submit' : `pre-submit gate: ${gate.blockers.length} blocker(s)`);
  metrics.submitted = false;

  const outPath = args.out ? path.resolve(args.out) : path.join(root, 'data', 'ab-test', 'hybrid.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(metrics, null, 2)}\n`);

  for (const q of metrics.questions || []) {
    if (q.outcome) console.log(`[hybrid]   ${q.outcome.status.padEnd(10)} ${q.label}${q.outcome.reason ? ` — ${q.outcome.reason}` : ''}`);
  }
  console.log(`[hybrid] verified ${metrics.summary.fieldsVerified}, model calls ${metrics.modelCalls.total} (observe ${calls.stagehand}, jev ${calls.jev}), ${metrics.wallClockSeconds}s`);
  console.log(`[hybrid] CV: ${metrics.summary.cvAttachedTo ? `attached to "${metrics.summary.cvAttachedTo}"` : `not attached (${metrics.cv?.reason || metrics.cv?.status || 'n/a'})`}`);
  console.log(`[hybrid] gate: ${gate.ready ? 'READY' : 'BLOCKED'}${gate.blockers.map((b) => `\n[hybrid]   - ${b.label}: ${b.reason}`).join('')}`);
  console.log(`[hybrid] stopped at: ${metrics.stoppedAt}; metrics: ${outPath}`);
  process.exit(failed ? 1 : gate.ready ? 0 : 3);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error('[hybrid] fatal:', e instanceof Error ? e.stack : e);
    process.exit(1);
  });
}
