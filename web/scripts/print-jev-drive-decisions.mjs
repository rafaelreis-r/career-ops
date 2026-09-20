#!/usr/bin/env node
// print-jev-drive-decisions.mjs — run the Jev decision step against the real
// fixture DOM snapshots and print what it decides at each stage.
//
//   node scripts/print-jev-drive-decisions.mjs        (from web/)
//
// With TYPESAFE_API_KEY set in the environment, every decision below is a
// REAL network call to TypeSafe's Jev endpoint (no mocking) — this is how the
// captain gets a live, no-mocks read on the decision logic without driving
// any real browser tab or job application. Without a key, this script still
// runs the real DOM scan (headless Chrome, real fixture HTML) and prints
// clearly-labeled decisions from an injected, realistic fake response instead
// of pretending to have called Jev.

import path from "node:path";
import { chromium } from "playwright-core";
import { isJevDriveEnabled, classifyElement, classifyBlocked, decideStep, resolveTypeTextValue } from "../src/lib/apply/jev-drive-core.mjs";

const FIXTURES = path.join(import.meta.dirname, "..", "src", "lib", "apply", "__fixtures__");

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
    out.push({ ref: `e${n}`, tag, itype, role, label: labelFor(el) });
    n++;
  }
  return out;
}

async function snapshotFixture(browser, fixtureName) {
  const page = await browser.newPage();
  await page.goto(`file://${path.join(FIXTURES, fixtureName)}`);
  const raw = await page.evaluate(rawScanInPage);
  await page.close();
  return raw.map((r) => {
    const kind = classifyElement(r);
    const blocked = classifyBlocked(r, kind);
    return { ref: r.ref, kind, label: r.label, blocked };
  });
}

/** Injected, offline stand-in used ONLY when no TYPESAFE_API_KEY is present —
 *  a sensible, realistic decision at each stage, clearly labeled as such. */
function fakeRequestFor(scenario) {
  return async (_state, questions) => {
    if (scenario === "reach") {
      const applyRef = Object.keys(questions.click_target.criteria).find((k) => questions.click_target.criteria[k].includes("Apply Now"));
      return { operation: { choice: "CLICK" }, click_target: { choice: applyRef } };
    }
    if (scenario === "full-email") {
      const emailRef = Object.keys(questions.type_target.criteria).find((k) => questions.type_target.criteria[k].includes("Email"));
      return { operation: { choice: "TYPE_TEXT" }, type_target: { choice: emailRef } };
    }
    if (scenario === "full-select") {
      const selectRef = Object.keys(questions.select_target?.criteria ?? {})[1]; // skip none_of_the_above
      return { operation: { choice: "SELECT" }, select_target: { choice: selectRef } };
    }
    if (scenario === "full-submit-blocked") {
      // Nothing left to fill/click legitimately: only the submit/consent/file
      // controls remain, all excluded from candidates → BLOCKED.
      return { operation: { choice: "BLOCKED" } };
    }
    return { operation: { choice: "WAIT" } };
  };
}

async function main() {
  const live = isJevDriveEnabled();
  console.log(`mode: ${live ? "LIVE (TYPESAFE_API_KEY set — real network calls to TypeSafe)" : "OFFLINE (no TYPESAFE_API_KEY — injected realistic responses, clearly labeled)"}\n`);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const listingRefs = await snapshotFixture(browser, "careers-listing.html");
    const formRefs = await snapshotFixture(browser, "careers-form.html");

    console.log("--- careers-listing.html (goal: reach) ---");
    console.log("refs:", listingRefs);
    const reachDecision = await decideStep(
      { goal: "reach", url: "https://example.com/careers/1", title: "Listing", refs: listingRefs, answersProvided: false },
      live ? undefined : fakeRequestFor("reach"),
    );
    console.log("decision:", reachDecision, "\n");

    const answers = [
      { label: "Full Name", value: "Jordan Rivera" },
      { label: "Email Address", value: "jordan@example.com" },
      { label: "Phone", value: "+1-555-0100" },
      { label: "Work Authorization", value: "yes" },
    ];

    console.log("--- careers-form.html (goal: full, nothing filled yet) ---");
    console.log("refs:", formRefs);
    const fillDecision = await decideStep(
      { goal: "full", url: "https://example.com/apply/1", title: "Apply", refs: formRefs, answersProvided: true },
      live ? undefined : fakeRequestFor("full-email"),
    );
    console.log("decision:", fillDecision);
    if (fillDecision.operation === "TYPE_TEXT" && fillDecision.ref) {
      const targetLabel = formRefs.find((r) => r.ref === fillDecision.ref)?.label ?? "";
      const value = await resolveTypeTextValue(targetLabel, answers, live ? undefined : fakeRequestFor("match"));
      console.log(`resolved TYPE_TEXT value for "${targetLabel}":`, value);
    }
    console.log();

    console.log("--- careers-form.html (goal: full, everything else already filled — only submit/consent/file remain) ---");
    const blockedDecision = await decideStep(
      { goal: "full", url: "https://example.com/apply/1", title: "Apply", refs: formRefs, answersProvided: true },
      live ? undefined : fakeRequestFor("full-submit-blocked"),
    );
    console.log("decision:", blockedDecision);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
