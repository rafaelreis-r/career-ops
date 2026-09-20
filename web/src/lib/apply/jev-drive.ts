import type { Page, Frame } from "playwright-core";
import type { DriveStep, DriveResult } from "./issue";
import { dropNewTabs } from "./diagnose";
import { classifyElement, classifyBlocked, decideStep, resolveTypeTextValue, isJevDriveEnabled, postJevChoices, SUBMIT_RX, CONSENT_RX } from "./jev-drive-core.mjs";

export { isJevDriveEnabled };

// ─────────────────────────────────────────────────────────────────────────────
// JEV DECISION LOOP — the drop-in replacement for the `claude -p` planner in
// driveSession() (drive.ts) when TYPESAFE_API_KEY is set. Same idea, cheaper
// mechanism: instead of a heavy per-turn LLM call, we snapshot the page into
// an indexed element table and ask Jev ONE typed judgment per step that picks
// BOTH the operation (CLICK/TYPE_TEXT/SELECT/SCROLL/WAIT/DONE/BLOCKED) and its
// target ref — no screenshots reach the decision. A small extra Jev choice
// call (not a generative model — see jev-drive-core.mjs) matches the
// candidate's own answers to the field being typed into.
// Runs on the SAME headed `page` the planner would have used (session.ts's
// headedBrowser()/newDrivePage() — never a second, hidden browser instance),
// so the captain-visible/streamed session is unchanged. NEVER-SUBMIT is
// enforced twice: submit/register/consent-looking controls are excluded from
// the candidates Jev is offered, AND refused again at click time if one slips
// through — BLOCKED always escalates to the human handoff, never auto-acts.
//
// FULL-AUTONOMOUS SUBMIT is a narrow, explicit opt-in exception to that
// invariant (7th `options` param, default `{}`): ONLY when a caller passes
// `{ fullAutonomous: true, verified: true }` — the latter set only after the
// caller's own out-of-band pre-submit verification passes — does a turn's
// vocabulary gain SUBMIT, targeting exactly the refs already classified
// `blocked === "submit"`. Every existing caller (drive.ts included) omits
// `options` and keeps the byte-identical never-submit behavior above; see
// web/scripts/ab-jev-apply.mjs for the one caller that opts in, for a
// captain-authorized A/B test of real, deliberate autonomous submission.
// ─────────────────────────────────────────────────────────────────────────────

type RefInfo = { ref: string; kind: "click" | "type" | "select"; label: string; blocked?: "submit" | "consent" | "file" };

/** Structural-only DOM scan (page.evaluate() callbacks are serialized with no
 *  closure access, so classification happens back in Node via
 *  classifyElement/SUBMIT_RX/CONSENT_RX — see jev-drive-core.mjs). */
async function rawScan(frame: Frame): Promise<Array<{ ref: string; tag: string; itype: string; role: string; label: string }>> {
  return frame.evaluate(() => {
    const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim().slice(0, 80);
    // A real ATS form's readable text lives in an associated <label>, not the
    // control's own attributes (a `name="full_name"` is a poor signal for
    // matching a candidate's answer to it) — resolve <label for> and a
    // wrapping <label> before falling back to aria-label/placeholder/etc.
    const labelFor = (el: Element): string => {
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
        const clone = wrap.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("input, textarea, select, button").forEach((c) => c.remove());
        const t = clean(clone.textContent);
        if (t) return t;
      }
      return clean(
        el.getAttribute("aria-label") || (el as HTMLInputElement).placeholder || el.textContent || (el as HTMLInputElement).value || (el as HTMLInputElement).name,
      );
    };
    const vis = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return (el as HTMLElement).offsetParent !== null && r.width > 2 && r.height > 2;
    };
    const sel =
      'a, button, input, textarea, select, [role="button"], [role="link"], [role="combobox"], [role="checkbox"], [role="radio"], [role="listbox"], [contenteditable="true"]';
    const els = Array.from(document.querySelectorAll(sel)).filter(vis);
    const out: Array<{ ref: string; tag: string; itype: string; role: string; label: string }> = [];
    let n = 0;
    for (const el of els.slice(0, 70)) {
      const tag = el.tagName.toLowerCase();
      const itype = ((el as HTMLInputElement).type || "").toLowerCase();
      const role = el.getAttribute("role") || (tag === "a" ? "link" : tag);
      const label = labelFor(el);
      const ref = `e${n}`;
      el.setAttribute("data-co-jev-ref", ref);
      out.push({ ref, tag, itype, role, label });
      n++;
    }
    return out;
  });
}

/** Ref-tagged, classified element table — the "indexed element table" Jev
 *  reasons over each step. Exported so a validation script can drive it
 *  against a real (fixture) DOM without also standing up the full loop. */
export async function snapshotRefs(frame: Frame): Promise<RefInfo[]> {
  const raw = await rawScan(frame);
  return raw.map((r) => {
    const kind = classifyElement(r) as RefInfo["kind"];
    const blocked = classifyBlocked(r, kind) as RefInfo["blocked"];
    return { ref: r.ref, kind, label: r.label, blocked };
  });
}

async function shot(page: Page): Promise<string | undefined> {
  try {
    return `data:image/jpeg;base64,${(await page.screenshot({ type: "jpeg", quality: 38 })).toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** Jev-driven decision loop — same DriveResult contract, same never-submit
 *  invariant, same headed `page` as driveSession()'s claude planner. `reason`
 *  uses "stuck" for BLOCKED specifically so the existing /api/apply/drive
 *  route (which pattern-matches `result.reason === "stuck"`) needs no change.
 *  `options` is the full-autonomous opt-in (default `{}` — every existing
 *  caller, including drive.ts, omits it and keeps the byte-identical
 *  never-submit behavior). Only when BOTH `options.fullAutonomous` AND
 *  `options.verified` are `true` does a turn's decideStep() call offer Jev
 *  the SUBMIT operation at all — `verified` must be set by the CALLER only
 *  after its own out-of-band pre-submit verification has passed (see
 *  web/scripts/ab-jev-apply.mjs), never by this loop itself. */
export async function driveSessionJev(
  page: Page,
  goal: "reach" | "full",
  isFormReady: () => Promise<boolean>,
  emit: (s: DriveStep) => void,
  budget: number,
  answers: { label: string; value: string }[] = [],
  options: { fullAutonomous?: boolean; verified?: boolean; request?: typeof postJevChoices } = {},
): Promise<DriveResult> {
  const steps: DriveStep[] = [];
  const history: string[] = [];
  let lastSignature = "";
  let repeats = 0;
  const submitAllowed = options.fullAutonomous === true && options.verified === true;
  // Single injection seam for EVERY network-bound Jev call this loop makes
  // (decisions AND per-field value matching) — defaults to the real
  // postJevChoices, so every existing caller is unaffected; a caller that
  // wants call/token metrics (web/scripts/ab-jev-apply.mjs) wraps it once.
  const request = options.request ?? postJevChoices;

  for (let turn = 1; turn <= budget; turn++) {
    if (goal === "reach" && (await isFormReady().catch(() => false))) {
      return { reached: true, turns: turn - 1, reason: "jev-reached", steps };
    }
    await dropNewTabs(page); // any "Apply" link/popup navigates in OUR tab, not a new one
    const frame = page.mainFrame();
    const refs = await snapshotRefs(frame).catch(() => [] as RefInfo[]);

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
      return { reached: true, turns: turn, reason: goal === "reach" ? "jev-reached" : "jev-done", steps };
    }
    if (decision.operation === "BLOCKED") {
      const s: DriveStep = { turn, action: "stuck", detail: decision.reason || "blocked", thumb: await shot(page) };
      steps.push(s);
      emit(s);
      return { reached: false, turns: turn, reason: "stuck", steps };
    }

    // Repeat guard: the same operation on the same target 3 turns running
    // means Jev is looping (e.g. a click that isn't navigating) — hand off
    // rather than burn the whole budget spinning.
    const signature = `${decision.operation}:${decision.ref ?? ""}`;
    repeats = signature === lastSignature ? repeats + 1 : 0;
    lastSignature = signature;
    if (repeats >= 3) {
      const s: DriveStep = { turn, action: "stuck", detail: `repeated ${decision.operation} on the same target — handing off`, thumb: await shot(page) };
      steps.push(s);
      emit(s);
      return { reached: false, turns: turn, reason: "stuck", steps };
    }

    let detail = "";
    let note = "";
    try {
      const loc = decision.ref ? frame.locator(`[data-co-jev-ref="${decision.ref}"]`).first() : null;
      const ref = refs.find((r) => r.ref === decision.ref);
      if (decision.operation === "CLICK" && loc) {
        const txt = (await loc.innerText().catch(() => "")) || (await loc.getAttribute("value").catch(() => "")) || "";
        if (SUBMIT_RX.test(txt) || CONSENT_RX.test(txt)) {
          // Defense in depth: the candidate table already excludes these, but
          // a label mismatch between the scan pass and the live element must
          // never fall through to an actual click.
          note = "refused to click a submit/register/consent control (the human decides)";
          detail = `blocked click "${txt.slice(0, 40)}"`;
        } else {
          detail = `click "${txt.slice(0, 40)}"`;
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await Promise.all([page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {}), loc.click({ timeout: 6000 })]);
        }
      } else if (decision.operation === "SUBMIT" && loc) {
        // Defense in depth, mirrored from the CLICK branch above but inverted:
        // SUBMIT is only ever offered (see jev-drive-core.mjs's submitAllowed
        // gate) when the caller already ran its own pre-submit verification —
        // but if the live element's text doesn't actually read as a submit
        // control, refuse rather than trust the ref alone.
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
          detail = `no matching answer for "${ref?.label || decision.ref}"`;
        } else {
          detail = `type into "${ref?.label || decision.ref}"`;
          await loc.fill(value).catch(async () => {
            await loc.click();
            await page.keyboard.type(value);
          });
        }
      } else if (decision.operation === "SELECT" && loc) {
        const value = await resolveTypeTextValue(ref?.label || "", answers, request);
        detail = `select "${value ?? ""}" in "${ref?.label || decision.ref}"`;
        if (value) await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
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
    const s: DriveStep = { turn, action: decision.operation.toLowerCase(), detail, thumb: await shot(page), note: note || undefined };
    steps.push(s);
    emit(s);
    if (decision.operation === "SUBMIT" && !note) {
      // Submit actually clicked (not refused above) — this is a terminal
      // action, unlike every other operation in this loop: stop driving
      // immediately rather than looping again on a page that just navigated
      // away. The caller captures the post-submit confirmation (URL/text).
      return { reached: true, turns: turn, reason: "jev-submitted", steps };
    }
  }
  return { reached: await isFormReady().catch(() => false), turns: budget, reason: "budget-exhausted", steps };
}
