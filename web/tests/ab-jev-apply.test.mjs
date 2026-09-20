// Tests for the Arm-1 Jev apply runner's CV-upload + no-data-field-skip
// maturation (fm/jev-runner-cv-skip). Two layers, neither ever touching a
// live job application or the real career-ops output/ directory:
//
//   1. Path resolution — deriveCompanySlug()/resolveCvPath() against a throwaway
//      temp directory tree (never the real repo's output/), exercised directly,
//      no browser.
//   2. Full dry-run pipeline — a REAL headless Chrome drives the actual shipped
//      driveLoop()/selfVerify()/attachCv() against
//      __fixtures__/careers-form-cv-upload.html (a local static file, never a
//      live site): the résumé/CV file input gets the resolved CV attached, the
//      optional "Postal / ZIP Code" field (which matches no canonical answer)
//      is skipped as a recorded gap instead of looping TYPE_TEXT until stuck,
//      pre-submit verification passes, and the submit-phase decision loop
//      reaches SUBMIT on the fixture's own submit button — proving the exact
//      two gaps the captain's brief named (no CV upload, stuck on a no-data
//      field) are closed, without ever driving https://avahi.bamboohr.com.
//
// Run:  node --test tests/ab-jev-apply.test.mjs   (from web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import {
  loadCanonicalData,
  snapshotRefs,
  driveLoop,
  selfVerify,
  attachCv,
  resolveCvPath,
  deriveCompanySlug,
  RESUME_LABEL_RX,
  DOCUMENT_ACCEPT_RX,
} from "../scripts/ab-jev-apply.mjs";

const FIXTURES = path.join(import.meta.dirname, "..", "src", "lib", "apply", "__fixtures__");

/** A throwaway root directory shaped like careerOpsRoot() (config/profile.yml,
 *  output/) — NEVER the real repo root, so these tests can never touch the
 *  user's real output/ or config/. */
function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "co-ab-jev-apply-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "config", "profile.yml"),
    "candidate:\n  full_name: Jordan Rivera\n  email: jordan.rivera@example.com\n  phone: \"+1 555 0100\"\n",
  );
  return root;
}

// --- 1. Company slug + CV path resolution (no browser, never real output/) --

test("deriveCompanySlug reads the slug from a resolved reports/NNN-<slug>-DATE.md filename", () => {
  const reportPath = "/tmp/whatever/reports/703-avahi-2026-09-18.md";
  assert.equal(deriveCompanySlug({ reportPath }), "avahi");
});

test("deriveCompanySlug falls back to the application URL's subdomain when no report resolved", () => {
  assert.equal(deriveCompanySlug({ url: "https://avahi.bamboohr.com/careers/176" }), "avahi");
});

test("deriveCompanySlug returns null (never guesses) with neither a report nor a usable URL host", () => {
  assert.equal(deriveCompanySlug({}), null);
  assert.equal(deriveCompanySlug({ url: "not a url" }), null);
});

test("resolveCvPath prefers an explicit --cv path that exists", () => {
  const root = makeTempRoot();
  try {
    const explicit = path.join(root, "custom-cv.pdf");
    fs.writeFileSync(explicit, "%PDF-1.4 fixture\n");
    const result = resolveCvPath(root, { explicitCv: explicit, companySlug: "avahi" });
    assert.deepEqual(result, { path: explicit, reason: null });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCvPath never fabricates a path — a missing explicit --cv is a recorded gap", () => {
  const root = makeTempRoot();
  try {
    const result = resolveCvPath(root, { explicitCv: path.join(root, "nope.pdf"), companySlug: "avahi" });
    assert.equal(result.path, null);
    assert.match(result.reason, /does not exist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCvPath finds the newest output/cv-candidate-<slug>-*.pdf for the derived company slug", () => {
  const root = makeTempRoot();
  try {
    const outputDir = path.join(root, "output");
    fs.mkdirSync(outputDir, { recursive: true });
    const older = path.join(outputDir, "cv-candidate-avahi-2026-09-10.pdf");
    const newer = path.join(outputDir, "cv-candidate-avahi-2026-09-18.pdf");
    fs.writeFileSync(older, "%PDF-1.4 older\n");
    fs.writeFileSync(newer, "%PDF-1.4 newer\n");
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(older, oldTime, oldTime);
    const result = resolveCvPath(root, { companySlug: "avahi" });
    assert.equal(result.path, newer);
    assert.equal(result.reason, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCvPath records a gap (never fabricates) when no CV matches the company slug", () => {
  const root = makeTempRoot();
  try {
    fs.mkdirSync(path.join(root, "output"), { recursive: true });
    const result = resolveCvPath(root, { companySlug: "nomatch" });
    assert.equal(result.path, null);
    assert.match(result.reason, /no output\/cv-candidate-nomatch-.*\.pdf/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- 2. Full dry-run pipeline against the fixture (real headless Chrome, ----
//        never a live site) ---------------------------------------------------

/** A deterministic fake Jev "request" — no network, no LLM: picks the first
 *  unblocked TYPE_TEXT target it hasn't already offered, then SUBMIT once
 *  every text target has been offered once. Returns null for a `match`
 *  question (resolveTypeTextValue's own sub-call) so field-value resolution
 *  falls through to the real, deterministic bestLabelMatch() — the same
 *  zero-network fallback the shipped code uses when Jev is disabled. */
function makeFixtureJevStub() {
  const offered = new Set();
  return async function request(state, questions) {
    if (questions.match) return null;
    if (questions.type_target) {
      const candidates = Object.keys(questions.type_target.criteria).filter((k) => k !== "none_of_the_above" && !offered.has(k));
      if (candidates.length) {
        offered.add(candidates[0]);
        return { operation: { choice: "TYPE_TEXT" }, type_target: { choice: candidates[0] } };
      }
    }
    if (questions.submit_target) {
      const candidates = Object.keys(questions.submit_target.criteria).filter((k) => k !== "none_of_the_above");
      if (candidates.length) return { operation: { choice: "SUBMIT" }, submit_target: { choice: candidates[0] } };
    }
    return { operation: { choice: "DONE" } };
  };
}

test("CV attaches, the optional no-data field is skipped without looping, verification passes, and the submit phase reaches SUBMIT — fixture only, never a live site", async (t) => {
  const root = makeTempRoot();
  const outputDir = path.join(root, "output");
  fs.mkdirSync(outputDir, { recursive: true });
  const cvPath = path.join(outputDir, "cv-candidate-avahi-2026-09-18.pdf");
  fs.writeFileSync(cvPath, "%PDF-1.4 test fixture CV — never the real candidate's document\n");

  const { answers } = loadCanonicalData(root, {});
  const cvResolution = resolveCvPath(root, { companySlug: deriveCompanySlug({ url: "https://avahi.bamboohr.com/careers/176" }) });
  assert.equal(cvResolution.path, cvPath, "resolves the fixture's own newest cv-candidate-avahi-*.pdf, never a fabricated path");

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(async () => {
    await browser.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await page.goto(`file://${path.join(FIXTURES, "careers-form-cv-upload.html")}`);
  const isFormReady = async () => {
    const refs = await snapshotRefs(page.mainFrame());
    return refs.some((r) => (r.kind === "type" || r.kind === "select") && !r.blocked);
  };

  // reach — the fixture IS the form already, so this resolves with zero Jev calls.
  const reachResult = await driveLoop(page, "reach", isFormReady, 8, [], {});
  assert.equal(reachResult.reached, true);

  // CV attach — deterministic, never a Jev decision.
  const refsForCv = await snapshotRefs(page.mainFrame());
  const resumeRefs = refsForCv.filter((r) => r.itype === "file" && r.blocked === "file");
  assert.equal(resumeRefs.length, 1, "the fixture's résumé file input is scanned and blocked (never a CLICK target)");
  assert.match(resumeRefs[0].label, RESUME_LABEL_RX);
  const cvAttach = await attachCv(page.mainFrame(), refsForCv, cvResolution.path);
  assert.equal(cvAttach.length, 1);
  assert.equal(cvAttach[0].ok, true);
  const attachedFile = await page.$eval("#resume", (el) => (el.files[0] ? el.files[0].name : null));
  assert.equal(attachedFile, path.basename(cvPath), "setInputFiles landed the resolved CV on the real DOM file input");

  // fill — the no-data optional field must be skipped as a recorded gap, never
  // looped until stuck.
  const knownNoDataLabels = new Set();
  const request = makeFixtureJevStub();
  const fillResult = await driveLoop(page, "full", isFormReady, 30, answers, {
    fullAutonomous: true,
    verified: false,
    request,
    knownNoDataLabels,
  });
  assert.equal(fillResult.reason, "jev-done");
  assert.equal(
    fillResult.steps.some((s) => s.action === "stuck"),
    false,
    "the no-data postal-code field must never trigger the repeat-signature stuck guard",
  );
  assert.equal(fillResult.skippedNoData.length, 1);
  assert.match(fillResult.skippedNoData[0].label, /postal|zip/i);
  assert.equal(fillResult.skippedNoData[0].required, false, "the optional postal field is a gap, never a blocker");
  assert.equal(Object.keys(fillResult.filledAnswers).length, 3, "full name, email, phone all landed from canonical answers");

  // pre-submit verification — must PASS: résumé attached (required, satisfied),
  // postal code empty but optional (not a criterion).
  const refsAfterFill = await snapshotRefs(page.mainFrame());
  const verification = await selfVerify(page.mainFrame(), refsAfterFill, fillResult.filledAnswers);
  assert.equal(verification.passed, true, `expected verification to pass: ${JSON.stringify(verification)}`);
  assert.equal(verification.fieldsAttempted, 3);
  assert.equal(verification.fieldsVerifiedCorrect, 3);

  // submit phase — reaches an actual SUBMIT decision on the fixture's own
  // button (a local static file, never a live site).
  const submitResult = await driveLoop(page, "full", isFormReady, 3, answers, {
    fullAutonomous: true,
    verified: true,
    request,
    knownNoDataLabels,
  });
  assert.equal(submitResult.reason, "jev-submitted");
  const submitStep = submitResult.steps.find((s) => s.action === "submit");
  assert.ok(submitStep, "expected a submit-phase step with action 'submit'");
  assert.equal(submitStep.note, undefined, "the submit control must never be refused (it matches SUBMIT_RX, it's the resolved target)");
});

// --- 3. Accept-attribute fallback for an UNNAMED file input (fm/jev-runner- --
//        cv-detect — mirrors the real Avahi BambooHR upload field, which
//        has no name/id/label at all) --------------------------------------

test("CV attaches via the accept-attribute fallback on an unnamed, unlabeled file input — mirrors the real Avahi form, verification passes, and the submit phase reaches SUBMIT", async (t) => {
  const root = makeTempRoot();
  const outputDir = path.join(root, "output");
  fs.mkdirSync(outputDir, { recursive: true });
  const cvPath = path.join(outputDir, "cv-candidate-avahi-2026-09-18.pdf");
  fs.writeFileSync(cvPath, "%PDF-1.4 test fixture CV — never the real candidate's document\n");

  const { answers } = loadCanonicalData(root, {});
  const cvResolution = resolveCvPath(root, { companySlug: deriveCompanySlug({ url: "https://avahi.bamboohr.com/careers/176" }) });
  assert.equal(cvResolution.path, cvPath);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(async () => {
    await browser.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await page.goto(`file://${path.join(FIXTURES, "careers-form-cv-upload-unnamed.html")}`);
  const isFormReady = async () => {
    const refs = await snapshotRefs(page.mainFrame());
    return refs.some((r) => (r.kind === "type" || r.kind === "select") && !r.blocked);
  };

  // reach — the fixture IS the form already, so this resolves with zero Jev calls.
  const reachResult = await driveLoop(page, "reach", isFormReady, 8, [], {});
  assert.equal(reachResult.reached, true);

  // The scanned file ref has no matchable name/id/label at all — proves
  // RESUME_LABEL_RX can never be the signal that finds this field.
  const refsForCv = await snapshotRefs(page.mainFrame());
  const fileRefs = refsForCv.filter((r) => r.itype === "file" && r.blocked === "file");
  assert.equal(fileRefs.length, 1, "the fixture's single unnamed file input is scanned and blocked (never a CLICK target)");
  assert.equal(fileRefs[0].label, "", "no name/id/label/aria-label — byte-identical to the real Avahi field");
  assert.equal(RESUME_LABEL_RX.test(fileRefs[0].label), false, "the name/label match must miss this field");
  assert.match(fileRefs[0].accept, DOCUMENT_ACCEPT_RX, "the accept list carries the real Avahi form's document types");

  // CV attach — deterministic, never a Jev decision. Must land via the
  // accept-attribute fallback strategy, not the name/label match.
  const cvAttach = await attachCv(page.mainFrame(), refsForCv, cvResolution.path);
  assert.equal(cvAttach.length, 1);
  assert.equal(cvAttach[0].ok, true);
  assert.equal(cvAttach[0].strategy, "accept-fallback", "no label matched, so the accept-based fallback must be the recorded strategy");
  const attachedFile = await page
    .locator(`[data-co-field="${fileRefs[0].ref}"]`)
    .first()
    .evaluate((el) => (el.files[0] ? el.files[0].name : null));
  assert.equal(attachedFile, path.basename(cvPath), "setInputFiles landed the resolved CV on the unnamed, unlabeled file input");

  // fill — the no-data optional field must be skipped as a recorded gap, never
  // looped until stuck.
  const knownNoDataLabels = new Set();
  const request = makeFixtureJevStub();
  const fillResult = await driveLoop(page, "full", isFormReady, 30, answers, {
    fullAutonomous: true,
    verified: false,
    request,
    knownNoDataLabels,
  });
  assert.equal(fillResult.reason, "jev-done");
  assert.equal(fillResult.skippedNoData.length, 1);
  assert.match(fillResult.skippedNoData[0].label, /postal|zip/i);

  // pre-submit verification — must PASS: the unnamed upload is required and
  // satisfied via the accept-fallback attach above (selfVerify() feeds every
  // blocked:'file' ref into verifyFill(), unconditional on label — see its
  // own docstring), postal code empty but optional (not a criterion).
  const refsAfterFill = await snapshotRefs(page.mainFrame());
  const verification = await selfVerify(page.mainFrame(), refsAfterFill, fillResult.filledAnswers);
  assert.equal(verification.passed, true, `expected verification to pass: ${JSON.stringify(verification)}`);

  // submit phase — reaches an actual SUBMIT decision on the fixture's own
  // button (a local static file, never a live site). Firstmate runs the real
  // submission separately; this dry-run never touches Avahi and never submits.
  const submitResult = await driveLoop(page, "full", isFormReady, 3, answers, {
    fullAutonomous: true,
    verified: true,
    request,
    knownNoDataLabels,
  });
  assert.equal(submitResult.reason, "jev-submitted");
  const submitStep = submitResult.steps.find((s) => s.action === "submit");
  assert.ok(submitStep, "expected a submit-phase step with action 'submit'");
});
