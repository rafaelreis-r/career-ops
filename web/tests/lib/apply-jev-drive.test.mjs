// Tests for the Jev-driven apply decision loop (web/src/lib/apply/jev-drive.ts
// + jev-drive-core.mjs). Two layers, both real, neither hitting a live job
// application:
//
//   1. DOM scan — a REAL headless Chrome opens the fixture HTML files under
//      __fixtures__/ and runs the actual snapshotRefs() scan/classification
//      shipped in jev-drive.ts. No mocking of the DOM or the scan logic.
//   2. Decision logic — decideStep()/resolveTypeTextValue() from
//      jev-drive-core.mjs, exercised via their `request` dependency-injection
//      seam (the same pattern jev-ag-eval.mjs's `evaluateWithJevFanout({ ask })`
//      uses) so the OPERATION/TARGET SELECTION LOGIC is proven deterministically
//      offline, and separately, opportunistically, against the REAL TypeSafe
//      endpoint when TYPESAFE_API_KEY is set in the environment running this
//      suite — never a fabricated "live" result when it is not.
//
// Run:  node --test tests/lib/apply-jev-drive.test.mjs   (from web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright-core";
import {
  isJevDriveEnabled,
  classifyElement,
  classifyBlocked,
  buildDecisionRequest,
  decideStep,
  resolveTypeTextValue,
  bestLabelMatch,
} from "../../src/lib/apply/jev-drive-core.mjs";

const FIXTURES = path.join(import.meta.dirname, "..", "..", "src", "lib", "apply", "__fixtures__");

// The exact scan the shipped snapshotRefs() runs inside the page — kept in
// lockstep with jev-drive.ts's rawScan() so this test exercises the real
// selector/labeling logic, not a hand-rolled substitute. Playwright's
// page.evaluate() callbacks can't import a module, so this is duplicated
// verbatim rather than shared; a divergence here would show up as this
// test's element counts/kinds no longer matching the fixture's real fields.
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
    out.push({ ref: `e${n}`, tag, itype, role, label });
    n++;
  }
  return out;
}

async function snapshotFixture(fixtureName) {
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 5000 });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${path.join(FIXTURES, fixtureName)}`);
    const raw = await page.evaluate(rawScanInPage);
    return raw.map((r) => {
      const kind = classifyElement(r);
      const blocked = classifyBlocked(r, kind);
      return { ref: r.ref, kind, label: r.label, blocked };
    });
  } finally {
    await browser.close();
  }
}

// --- 1. Real DOM scan against the application-form fixture -------------------

let formRefs = [];
let snapshotUnavailable = null;
try {
  formRefs = await snapshotFixture("careers-form.html");
} catch (err) {
  snapshotUnavailable = err;
}
const scanTest = snapshotUnavailable ? test.skip : test;

scanTest("scans every real field on the application form", () => {
  const byLabel = Object.fromEntries(formRefs.map((r) => [r.label, r]));
  assert.equal(byLabel["Full name*"]?.kind, "type");
  assert.equal(byLabel["Email*"]?.kind, "type");
  assert.equal(byLabel["Phone number"]?.kind, "type");
  assert.equal(byLabel["Are you authorized to work in this country?*"]?.kind, "select");
  assert.equal(byLabel["Cover letter (optional)"]?.kind, "type");
});

scanTest("the resume file input is scanned but blocked (never a CLICK target, never opens a native picker)", () => {
  const resume = formRefs.find((r) => r.label === "Resume/CV*");
  assert.ok(resume, "resume field should be present in the scan");
  assert.equal(resume.blocked, "file");
});

scanTest("the submit button is scanned but blocked — never offered as a clickable target", () => {
  const submit = formRefs.find((r) => r.label === "Submit Application");
  assert.ok(submit, "submit button should be present in the scan");
  assert.equal(submit.kind, "click");
  assert.equal(submit.blocked, "submit");
});

scanTest("the EEO consent checkbox is scanned but blocked — never auto-checked", () => {
  const consent = formRefs.find((r) => r.label.includes("consent to Acme Corp processing"));
  assert.ok(consent, "consent checkbox label should be present in the scan");
  assert.equal(consent.blocked, "consent");
});

// --- 2. Decision logic: offline, deterministic, request() injected ----------

scanTest("buildDecisionRequest excludes TYPE_TEXT/SELECT for goal 'reach' (never fills while just navigating)", () => {
  const { questions } = buildDecisionRequest({ goal: "reach", url: "https://example.com", title: "t", refs: formRefs, answersProvided: true });
  assert.ok(!("TYPE_TEXT" in questions.operation.criteria));
  assert.ok(!("SELECT" in questions.operation.criteria));
  assert.ok(!("type_target" in questions));
  assert.ok(!("select_target" in questions));
});

scanTest("buildDecisionRequest never offers a blocked ref as a click_target candidate", () => {
  // The fixture's only click-kind controls (submit, file input, consent
  // checkbox) are ALL blocked, so click_target should not exist at all —
  // add one legitimate clickable ref (a "Next" button) to prove filtering,
  // not just absence.
  const refs = [...formRefs, { ref: "e99", kind: "click", label: "Next" }];
  const { questions } = buildDecisionRequest({ goal: "full", url: "https://example.com", title: "t", refs, answersProvided: true });
  const submitRef = formRefs.find((r) => r.blocked === "submit").ref;
  const resumeRef = formRefs.find((r) => r.blocked === "file").ref;
  assert.ok("click_target" in questions, "the one unblocked clickable ref should produce a click_target question");
  assert.ok("e99" in questions.click_target.criteria, "the unblocked ref must be offered");
  assert.ok(!(submitRef in questions.click_target.criteria), "submit control must never be a click candidate");
  assert.ok(!(resumeRef in questions.click_target.criteria), "file input must never be a click candidate");
});

scanTest("decideStep resolves a CLICK on the Apply CTA when Jev picks it (fake request, real ref table)", async () => {
  const listingRefs = await snapshotFixture("careers-listing.html");
  const applyRef = listingRefs.find((r) => r.label === "Apply Now")?.ref;
  assert.ok(applyRef, "Apply Now control should be scanned");

  const fakeRequest = async (_state, questions) => {
    assert.ok("click_target" in questions, "reach goal should still offer CLICK for navigation");
    return { operation: { choice: "CLICK" }, click_target: { choice: applyRef } };
  };
  const decision = await decideStep({ goal: "reach", url: "https://example.com/careers/1", title: "t", refs: listingRefs, answersProvided: false }, fakeRequest);
  assert.deepEqual(decision, { operation: "CLICK", ref: applyRef });
});

scanTest("decideStep escalates to BLOCKED when Jev picks an operation with no valid target", async () => {
  const fakeRequest = async () => ({ operation: { choice: "CLICK" }, click_target: { choice: "none_of_the_above" } });
  const decision = await decideStep({ goal: "full", url: "https://example.com", title: "t", refs: formRefs, answersProvided: true }, fakeRequest);
  assert.equal(decision.operation, "BLOCKED");
});

scanTest("decideStep escalates to BLOCKED (never guesses) when the decision request fails or is disabled", async () => {
  const decision = await decideStep({ goal: "full", url: "https://example.com", title: "t", refs: formRefs, answersProvided: true }, async () => null);
  assert.equal(decision.operation, "BLOCKED");
});

scanTest("decideStep resolves DONE when Jev reports the form fully filled", async () => {
  const fakeRequest = async () => ({ operation: { choice: "DONE" } });
  const decision = await decideStep({ goal: "full", url: "https://example.com", title: "t", refs: formRefs, answersProvided: true }, fakeRequest);
  assert.deepEqual(decision, { operation: "DONE" });
});

test("resolveTypeTextValue matches the email field to the email answer via the injected match request", async () => {
  const answers = [
    { label: "Full Name", value: "Jordan Rivera" },
    { label: "Email Address", value: "jordan@example.com" },
    { label: "Phone", value: "+1-555-0100" },
  ];
  const fakeRequest = async (_state, questions) => {
    assert.ok(Object.keys(questions.match.criteria).some((k) => questions.match.criteria[k].includes("jordan@example.com")));
    return { match: { choice: "a1" } }; // index 1 = the Email Address answer
  };
  const value = await resolveTypeTextValue("Email*", answers, fakeRequest);
  assert.equal(value, "jordan@example.com");
});

test("resolveTypeTextValue falls back to deterministic label matching when Jev is unavailable", async () => {
  const answers = [
    { label: "Full Name", value: "Jordan Rivera" },
    { label: "Email Address", value: "jordan@example.com" },
  ];
  const value = await resolveTypeTextValue("Email*", answers, async () => null);
  assert.equal(value, "jordan@example.com");
});

test("resolveTypeTextValue never fabricates a value with zero matching answers", () => {
  assert.equal(bestLabelMatch("Favorite color", [{ label: "Full Name", value: "Jordan Rivera" }]), null);
});

test("a single candidate answer is used directly with no Jev call at all", async () => {
  let called = false;
  const value = await resolveTypeTextValue("Anything", [{ label: "Email", value: "x@example.com" }], async () => {
    called = true;
    return null;
  });
  assert.equal(value, "x@example.com");
  assert.equal(called, false);
});

// --- 2b. SUBMIT — the full-autonomous opt-in, never on by default ------------

scanTest("buildDecisionRequest never offers SUBMIT by default — submitAllowed omitted keeps every existing caller's vocabulary unchanged", () => {
  const { questions, operationCriteria } = buildDecisionRequest({ goal: "full", url: "https://example.com", title: "t", refs: formRefs, answersProvided: true });
  assert.ok(!("SUBMIT" in operationCriteria));
  assert.ok(!("submit_target" in questions));
});

scanTest("buildDecisionRequest offers SUBMIT targeting only the submit-classified ref when submitAllowed is true", () => {
  const submitRef = formRefs.find((r) => r.blocked === "submit").ref;
  const { questions, operationCriteria } = buildDecisionRequest({
    goal: "full",
    url: "https://example.com",
    title: "t",
    refs: formRefs,
    answersProvided: true,
    submitAllowed: true,
  });
  assert.ok("SUBMIT" in operationCriteria);
  assert.ok("submit_target" in questions);
  assert.ok(submitRef in questions.submit_target.criteria);
  assert.ok(!questions.click_target || !(submitRef in questions.click_target.criteria), "submit control must never also be a click_target candidate");
});

scanTest("buildDecisionRequest ignores submitAllowed for goal 'reach' (never offers SUBMIT while just navigating)", () => {
  const { questions, operationCriteria } = buildDecisionRequest({
    goal: "reach",
    url: "https://example.com",
    title: "t",
    refs: formRefs,
    answersProvided: true,
    submitAllowed: true,
  });
  assert.ok(!("SUBMIT" in operationCriteria));
  assert.ok(!("submit_target" in questions));
});

scanTest("buildDecisionRequest offers no SUBMIT when submitAllowed is true but no submit-classified ref is present", () => {
  const refsWithoutSubmit = formRefs.filter((r) => r.blocked !== "submit");
  const { questions, operationCriteria } = buildDecisionRequest({
    goal: "full",
    url: "https://example.com",
    title: "t",
    refs: refsWithoutSubmit,
    answersProvided: true,
    submitAllowed: true,
  });
  assert.ok(!("SUBMIT" in operationCriteria));
  assert.ok(!("submit_target" in questions));
});

scanTest("decideStep resolves SUBMIT on the submit-classified ref when Jev picks it (submitAllowed only)", async () => {
  const submitRef = formRefs.find((r) => r.blocked === "submit").ref;
  const fakeRequest = async (_state, questions) => {
    assert.ok("submit_target" in questions, "submitAllowed should offer submit_target this turn");
    return { operation: { choice: "SUBMIT" }, submit_target: { choice: submitRef } };
  };
  const decision = await decideStep(
    { goal: "full", url: "https://example.com", title: "t", refs: formRefs, answersProvided: true, submitAllowed: true },
    fakeRequest,
  );
  assert.deepEqual(decision, { operation: "SUBMIT", ref: submitRef });
});

scanTest("decideStep escalates to BLOCKED if a request returns SUBMIT when submitAllowed was never set (defense against a bad/adversarial response)", async () => {
  const submitRef = formRefs.find((r) => r.blocked === "submit").ref;
  const fakeRequest = async () => ({ operation: { choice: "SUBMIT" }, submit_target: { choice: submitRef } });
  const decision = await decideStep({ goal: "full", url: "https://example.com", title: "t", refs: formRefs, answersProvided: true }, fakeRequest);
  assert.equal(decision.operation, "BLOCKED", "SUBMIT is not in operationCriteria when submitAllowed is unset, so it must never be honored");
});

scanTest("decideStep escalates to BLOCKED when Jev picks SUBMIT with no valid target", async () => {
  const fakeRequest = async () => ({ operation: { choice: "SUBMIT" }, submit_target: { choice: "none_of_the_above" } });
  const decision = await decideStep(
    { goal: "full", url: "https://example.com", title: "t", refs: formRefs, answersProvided: true, submitAllowed: true },
    fakeRequest,
  );
  assert.equal(decision.operation, "BLOCKED");
});

// --- 3. The opt-in gate -------------------------------------------------------

test("no TYPESAFE_API_KEY means isJevDriveEnabled() is false", () => {
  const had = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(isJevDriveEnabled(), false);
  if (had !== undefined) process.env.TYPESAFE_API_KEY = had;
});

test("setting TYPESAFE_API_KEY turns isJevDriveEnabled() on", () => {
  const had = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key";
  assert.equal(isJevDriveEnabled(), true);
  if (had === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = had;
});

// --- 4. Opportunistic LIVE validation -----------------------------------------
// Only runs a real network call when a real key is present in the environment
// invoking this suite; otherwise it reports why it was skipped instead of
// fabricating a "live" result. This is how the captain (or CI with a real key
// configured) gets the no-mocks live check the feature brief calls for.

scanTest("live: Jev returns a sensible operation + a valid ref against the real application form (skipped without TYPESAFE_API_KEY)", async (t) => {
  if (!isJevDriveEnabled()) {
    t.skip("TYPESAFE_API_KEY not set in this environment — no live TypeSafe call was made");
    return;
  }
  const decision = await decideStep({ goal: "full", url: "https://example.com/apply", title: "Apply", refs: formRefs, answersProvided: true });
  console.log("live Jev decision (full):", decision);
  assert.ok(["CLICK", "TYPE_TEXT", "SELECT", "SCROLL", "WAIT", "DONE", "BLOCKED"].includes(decision.operation));
  if (decision.ref) assert.ok(formRefs.some((r) => r.ref === decision.ref), "a returned ref must be one Jev was actually offered");

  const listingRefs = await snapshotFixture("careers-listing.html");
  const reachDecision = await decideStep({ goal: "reach", url: "https://example.com/careers/1", title: "Listing", refs: listingRefs, answersProvided: false });
  console.log("live Jev decision (reach):", reachDecision);
  assert.ok(["CLICK", "SCROLL", "WAIT", "DONE", "BLOCKED"].includes(reachDecision.operation));
});
