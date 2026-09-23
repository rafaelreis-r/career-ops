// Hybrid apply driver, the submission contract (captain, 2026-09-23: "pode
// enviar a candidatura"): nothing leaves the page while the driver works, the
// one explicit step submits only a form the gate cleared and counts it only on
// the employer's confirmation, and a company whose submission limit is used up
// across the tracks never enters the round. Real labels and markup: recrut.ai's
// "Inscrever-se na vaga", Camunda's refusal and BrightHire consent.
//
// Run:  node --test tests/lib/apply-hybrid-submit.test.mjs   (from web/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { holdSubmitLock, submitApplication, chooseSubmitControl } from '../../src/lib/apply/hybrid/submit.mjs';
import { reachApplicationForm } from '../../src/lib/apply/hybrid/adapters.mjs';
import { evaluateGate } from '../../src/lib/apply/hybrid/gate.mjs';
import { postingEligibility } from '../../src/lib/apply/hybrid/tracker-row.mjs';
import { isSubmitLikeText } from '../../src/lib/apply/hybrid/submit-policy.mjs';
import { scanPage } from '../../src/lib/apply/hybrid/page-scan.mjs';

async function openPage(t, html) {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 5000 });
  } catch (err) {
    t.skip(`chrome not available (${err.message})`);
    return null;
  }
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
}

// recrut.ai's button, verbatim markup (2026-09-23): a submit button, no fields.
const ITR_REVEAL = `<form action="/itrtechgroup/job-apply/" method="post"><input type="hidden" name="job" value="S8TTFW">
  <button type="submit" aria-label="Botão para submissão de candidatura à vaga.">Inscrever-se na vaga</button></form>`;

test('with the lock on, a form holding applicant fields never submits: typeless button, Enter, submit() and requestSubmit()', async (t) => {
  // The reviewer's case: one field and a typeless "INSCREVER-SE NA VAGA" inside the same <form>.
  const page = await openPage(
    t,
    `<form id="f"><label>E-mail*<input type="email" name="inputEmail"></label><button>INSCREVER-SE NA VAGA</button></form>
     <script>document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); window.__sent = (window.__sent || 0) + 1; });</script>`,
  );
  if (!page) return;
  const lock = await holdSubmitLock(page);
  await page.fill('input[name=inputEmail]', 'applicant@example.test');
  await page.click('button');
  await page.press('input[name=inputEmail]', 'Enter');
  await page.evaluate(() => document.getElementById('f').requestSubmit());
  await page.evaluate(() => document.getElementById('f').submit());
  assert.equal(await page.evaluate(() => window.__sent ?? 0), 0, 'no submit event reached the form');
  assert.equal(await page.inputValue('input[name=inputEmail]'), 'applicant@example.test', 'the page did not navigate away');
  assert.ok((await lock.blocked()) >= 4);
  // The probe never takes that button as the "open the application" trigger.
  const reach = await reachApplicationForm(page);
  assert.equal(reach.reached, false);
  assert.deepEqual(reach.log, [], 'nothing was clicked');
  await lock.release();
  await page.evaluate(() => document.getElementById('f').requestSubmit());
  assert.equal(await page.evaluate(() => window.__sent ?? 0), 1, 'released: the human can submit again');
});

test("recrut.ai's reveal button still opens the form: its <form> carries no applicant field", async (t) => {
  const page = await openPage(
    t,
    `${ITR_REVEAL}
     <script>document.forms[0].addEventListener('submit', (e) => {
       e.preventDefault();
       document.body.insertAdjacentHTML('beforeend', '<label>E-mail*<input type="email"></label><label>Nome completo*<input type="text"></label>');
     });</script>`,
  );
  if (!page) return;
  await holdSubmitLock(page);
  const reach = await reachApplicationForm(page);
  assert.equal(reach.reached, true);
  assert.deepEqual(reach.log.map((l) => l.clicked), ['Inscrever-se na vaga']);
});

test('the final step submits once, only when armed, and counts it only on the confirmation', async (t) => {
  const page = await openPage(
    t,
    `<h1>Senior SRE</h1><p>Thank you for your interest in this role.</p>
     <form id="f"><label>Email*<input type="email" required></label><button type="submit">Submit Application</button></form>
     <script>document.getElementById('f').addEventListener('submit', (e) => {
       e.preventDefault();
       window.__sent = (window.__sent || 0) + 1;
       setTimeout(() => { document.body.innerHTML = '<h1>Thank you for applying!</h1><p>Your application was received.</p>'; }, 300);
     });</script>`,
  );
  if (!page) return;
  await holdSubmitLock(page);
  await page.fill('input[type=email]', 'applicant@example.test');
  await page.click('button');
  assert.equal(await page.evaluate(() => window.__sent ?? 0), 0, 'a plain click is blocked');
  const r = await submitApplication(page, { timeoutMs: 5000 });
  assert.equal(r.status, 'confirmed');
  assert.equal(r.control, 'Submit Application');
  assert.match(r.evidence, /thank you for applying/i);
  assert.equal(await page.evaluate(() => window.__sent), 1);
});

test("Camunda's refusal is not a submission", async (t) => {
  const page = await openPage(
    t,
    `<form id="f"><label>Email<input type="email"></label><button type="submit">Submit Application</button></form>
     <script>document.getElementById('f').addEventListener('submit', (e) => {
       e.preventDefault();
       document.body.insertAdjacentHTML('beforeend', '<div role="alert">We limit submissions to 2 per person within a 30-day period.</div>');
     });</script>`,
  );
  if (!page) return;
  await holdSubmitLock(page);
  await page.fill('input[type=email]', 'applicant@example.test');
  const r = await submitApplication(page, { timeoutMs: 5000 });
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /We limit submissions/);
});

test('upload wording is neither blocked as submission nor selected as the final submit control', async (t) => {
  const page = await openPage(
    t,
    `<form><label>Email<input type="email"></label><button id="upload" type="button">Enviar currículo</button><button id="submit" type="button">Enviar candidatura</button></form>
     <script>upload.onclick=()=>window.__upload=(window.__upload||0)+1; submit.onclick=()=>window.__submit=(window.__submit||0)+1;</script>`,
  );
  if (!page) return;
  await holdSubmitLock(page);
  await page.fill('input', 'applicant@example.test');
  await page.click('#upload');
  assert.equal(await page.evaluate(() => window.__upload), 1);
  assert.equal(await page.evaluate(() => window.__submit || 0), 0);
  const r = await submitApplication(page, { timeoutMs: 20 });
  assert.equal(r.control, 'Enviar candidatura');
  assert.equal(await page.evaluate(() => window.__submit), 1);
});

test('a detached submit control is returned as an unconfirmed outcome', async (t) => {
  const page = await openPage(t, '<form><label>Email<input type="email" value="applicant@example.test"></label><button type="button">Apply</button></form>');
  if (!page) return;
  const r = await submitApplication(page, {
    timeoutMs: 20,
    beforeClick: async () => {
      await page.locator('button').evaluate((button) => button.remove());
      return { ok: true };
    },
  });
  assert.equal(r.status, 'unconfirmed');
  assert.match(r.reason, /submit click failed/);
});

test('a frame scan failure blocks the final gate', () => {
  const gate = evaluateGate({ questions: [], captcha: { present: false }, frameErrors: [{ url: 'https://ats.example.test/form', reason: 'detached' }] }, new Map(), { cvReason: 'missing' });
  assert.equal(gate.ready, false);
  assert.ok(gate.blockers.some((b) => b.kind === 'frame-scan'));
});

test('two unrelated submit-like controls are ambiguous: nothing is clicked', () => {
  assert.equal(chooseSubmitControl([{ index: 0, text: 'Send code', associated: false, formSubmit: false, finalText: true }, { index: 1, text: 'Apply filters', associated: false, formSubmit: false, finalText: true }]).control, null);
  assert.equal(chooseSubmitControl([{ index: 0, text: 'Upload', associated: true, formSubmit: true, finalText: false }, { index: 1, text: 'Submit Application', associated: true, formSubmit: true, finalText: true }]).control.index, 1);
});

test('the final step ignores an unrelated host control and submits the application iframe', async (t) => {
  const page = await openPage(
    t,
    `<form><input placeholder="Search"><button id="filter" type="button">Apply filters</button></form><iframe></iframe><script>
      filter.onclick=()=>window.__filtered=(window.__filtered||0)+1;
      const d=document.querySelector('iframe').contentDocument;
      d.open();d.write('<form><input name=email value="applicant@example.test"><button type=submit>Submit Application</button></form>');d.close();
      d.forms[0].onsubmit=(e)=>{e.preventDefault();d.defaultView.__sent=(d.defaultView.__sent||0)+1;d.body.innerHTML='<h1>Application submitted</h1>';};
    </script>`,
  );
  if (!page) return;
  const r = await submitApplication(page, { timeoutMs: 3000 });
  assert.equal(r.status, 'confirmed');
  assert.equal(await page.evaluate(() => window.__filtered || 0), 0);
  assert.equal(await page.frames()[1].evaluate(() => window.__sent), 1);
});

test('an upload-labeled submit button remains locked before the final step', async (t) => {
  const page = await openPage(
    t,
    `<form id="f"><input name=email value="applicant@example.test"><button type="submit">Upload & Submit Application</button></form>
     <script>f.onsubmit=(e)=>{e.preventDefault();window.__sent=(window.__sent||0)+1;};</script>`,
  );
  if (!page) return;
  await holdSubmitLock(page);
  await page.click('button');
  assert.equal(await page.evaluate(() => window.__sent || 0), 0);
  const r = await submitApplication(page, { timeoutMs: 20 });
  assert.equal(r.control, 'Upload & Submit Application');
  assert.equal(await page.evaluate(() => window.__sent), 1);
});

test('the gate reads the CV and consents from the final DOM', () => {
  const brightHire =
    "Do you consent to BrightHire's Interview Integrity feature analyzing your interview for potential fraud signals—including deepfake detection, device consistency, and location checks—to help our team review interview authenticity? (This is separate from interview recording consent.)?";
  const cvName = 'cv-example-candidate-camunda-senior-site-reliability-engineer-1164-2026-09-22.pdf';
  const scan = (files, selected = []) => ({
    captcha: { present: false },
    questions: [
      { key: 'q2', kind: 'file', label: 'Resume', required: false, visible: true, state: { files } },
      { key: 'q22', kind: 'toggle', label: brightHire, required: false, visible: true, state: { selected } },
    ],
  });
  const outcomes = new Map([['q2', { status: 'verified' }]]);
  const cleared = evaluateGate(scan([]), outcomes, { cvName });
  assert.deepEqual(cleared.blockers.map((b) => b.kind).sort(), ['consent', 'resume'], 'a CV attached earlier but gone from the page blocks; an unanswered consent blocks');
  const consentOutcome = { status: 'verified', canonicalValue: 'Yes', observed: 'Yes' };
  const answered = evaluateGate(scan([cvName], ['Yes']), new Map([...outcomes, ['q22', consentOutcome]]), { cvName });
  assert.equal(answered.ready, false, 'a file is not accepted until its chosen resume key is supplied');
  assert.equal(evaluateGate(scan([cvName], ['Yes']), new Map([...outcomes, ['q22', consentOutcome]]), { cvName, resumeQuestion: { key: 'q2', kind: 'file', label: 'Resume' } }).ready, true);
});

test('the final gate rechecks verified canonical values after later page changes', () => {
  const finalScan = {
    captcha: { present: false },
    questions: [
      { key: 'name', kind: 'text', label: 'First Name*', inputType: 'text', required: true, visible: true, state: { value: 'Changed' } },
      { key: 'eligible', kind: 'toggle', label: 'Are you eligible?*', required: true, visible: true, state: { selected: ['No'] } },
    ],
  };
  const outcomes = new Map([
    ['name', { status: 'verified', canonicalValue: 'Casey', observed: 'Casey' }],
    ['eligible', { status: 'verified', canonicalValue: 'Yes', observed: 'Yes' }],
  ]);
  const gate = evaluateGate(finalScan, outcomes);
  assert.deepEqual(gate.blockers.filter((b) => b.key).map((b) => b.key).sort(), ['eligible', 'name']);
  finalScan.questions[0].state.value = 'Casey';
  finalScan.questions[1].state.selected = ['Yes'];
  const corrected = evaluateGate(finalScan, outcomes);
  assert.equal(corrected.blockers.some((b) => b.key === 'name' || b.key === 'eligible'), false);
});

test('a filename in supporting text or the wrong file input is not CV proof', () => {
  const cvName = 'cv-example-candidate.pdf';
  const finalScan = {
    captcha: { present: false },
    questions: [
      { key: 'new-resume', kind: 'file', label: 'Resume', required: false, visible: true, state: { files: [], text: '' } },
      { key: 'resume', kind: 'file', label: 'Cover Letter', required: false, visible: true, state: { files: [cvName], text: cvName } },
      { key: 'notes', kind: 'textarea', label: 'Supporting information', required: false, visible: true, state: { value: `See ${cvName}` } },
    ],
  };
  const resumeQuestion = { key: 'resume', kind: 'file', label: 'Resume' };
  const gate = evaluateGate(finalScan, new Map(), { cvName, resumeQuestion });
  assert.ok(gate.blockers.some((b) => b.kind === 'resume'));
  finalScan.questions[0].state.text = cvName;
  assert.equal(evaluateGate(finalScan, new Map(), { cvName, resumeQuestion }).blockers.some((b) => b.kind === 'resume'), false);
});

test('the captured applytojob submit anchor is locked until the final step', async (t) => {
  const page = await openPage(
    t,
    `<form id="f"><input name="email" value="applicant@example.test"><div id="resumator-submit" class="form-group"><a href="#" id="resumator-submit-resume" class="btn">Submit Application</a></div></form>
     <script>document.getElementById('resumator-submit-resume').onclick=(e)=>{e.preventDefault();window.__sent=(window.__sent||0)+1;document.body.innerHTML='<h1>Application submitted</h1>';};</script>`,
  );
  if (!page) return;
  await holdSubmitLock(page);
  await page.click('#resumator-submit-resume');
  assert.equal(await page.evaluate(() => window.__sent || 0), 0);
  const result = await submitApplication(page, { timeoutMs: 3000 });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.control, 'Submit Application');
});

test('one submit classifier protects finalize variants in the probe, lock and final step', async (t) => {
  for (const text of ['Finalize application', 'Finalise application', 'Finish application', 'Complete application', 'Confirm application']) assert.equal(isSubmitLikeText(text), true, text);
  const page = await openPage(
    t,
    `<form><input name="email" value="applicant@example.test"><a href="/apply/complete" role="link" id="finalize">Finalize application</a></form>
     <script>finalize.onclick=(e)=>{e.preventDefault();window.__sent=(window.__sent||0)+1;document.body.innerHTML='<h1>Application submitted</h1>';};</script>`,
  );
  if (!page) return;
  const lock = await holdSubmitLock(page);
  await page.click('#finalize');
  assert.equal(await page.evaluate(() => window.__sent || 0), 0);
  const result = await submitApplication(page, { timeoutMs: 3000 });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.control, 'Finalize application');
  await lock.release();

  const probePage = await openPage(t, '<label>Email<input type="email"></label><a href="/apply/complete" role="link" onclick="window.clicked=1">Finalize application</a>');
  if (!probePage) return;
  const reached = await reachApplicationForm(probePage);
  assert.equal(reached.reached, false);
  assert.equal(await probePage.evaluate(() => window.clicked || 0), 0);
});

test('native HTML validity blocks before the durable submit claim', async (t) => {
  const page = await openPage(
    t,
    `<form><label>Phone<input name="phone" pattern="[0-9]{10}" value="202 555 0100"></label><button type="submit">Submit Application</button></form>`,
  );
  if (!page) return;
  let claimed = false;
  const result = await submitApplication(page, { beforeClick: async () => { claimed = true; return { ok: true }; } });
  assert.equal(result.status, 'invalid');
  assert.equal(claimed, false);
  assert.match(result.reason, /Phone/);
  const gate = evaluateGate(await scanPage(page), new Map());
  assert.ok(gate.blockers.some((blocker) => blocker.kind === 'native-invalid' && blocker.label === 'Phone'));
});

test('a company whose submission limit is used up across the tracks never enters the round, and the report says when it reopens', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'co-hybrid-limits-'));
  try {
    const header = '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|-----|------|-------|--------|-----|--------|-------|\n';
    const track = (name, rows, log = '') => {
      const root = path.join(base, name);
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.writeFileSync(path.join(root, 'data', 'applications.md'), `# Applications Tracker\n\n${header}${rows}`);
      if (log) fs.writeFileSync(path.join(root, 'data', 'status-log.tsv'), log);
      return root;
    };
    // Track B holds the two Camunda submissions that count (dates from its status-log); track A only evaluates.
    const a = track('a', '| 1164 | 2026-09-22 | Camunda | — | Senior Site Reliability Engineer | 3.9/5 | Evaluated | ✅ | [1164](../reports/1164-camunda-2026-09-22.md) | |\n| 1165 | 2026-09-22 | Canonical | — | SRE | 3.8/5 | Evaluated | ✅ | [1165](../reports/1165-canonical-2026-09-22.md) | |\n');
    const b = track(
      'b',
      '| 1068 | 2026-08-24 | Camunda | — | Senior Product Manager - Core Platform | 4.1/5 | Applied | ✅ | [1068](../reports/1068-camunda-senior-product-manager-2026-08-24.md) | |\n| 1087 | 2026-08-31 | Camunda | — | Product Manager, Self Managed Service | 4.2/5 | Applied | ✅ | [1087](../reports/1087-camunda-product-manager-2026-08-31.md) | |\n',
      '1068\t2026-08-26\tEvaluated\tApplied\tset-status\t\n1087\t2026-08-31\tEvaluated\tApplied\tset-status\t\n',
    );
    const shared = path.join(base, 'shared');
    fs.mkdirSync(path.join(shared, 'data'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'trilhas.yml'), `trilhas:\n  - id: A\n    dir: ${a}\n  - id: B\n    dir: ${b}\n`);
    fs.writeFileSync(path.join(shared, 'data', 'submission-limits.tsv'), 'company\tmax_submissions\twindow_days\trecorded\tsource\nCamunda\t2\t30\t2026-09-23\tWe limit submissions to 2 per person within a 30-day period\n');
    fs.writeFileSync(path.join(shared, 'data', 'blacklist.md'), '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Canonical | 2026-09-21 | company | Formulário exige dados sem fonte canônica |\n');

    const blocked = postingEligibility({ root: a, reportNumber: 1164, today: '2026-09-23', shared });
    assert.equal(blocked.eligible, false);
    assert.deepEqual(blocked.limit.submissions.map((s) => [s.row, s.date]), [[1068, '2026-08-26'], [1087, '2026-08-31']]);
    assert.equal(blocked.limit.reopensOn, '2026-09-25');
    assert.match(blocked.reasons[0], /reopens on 2026-09-25/);
    assert.equal(postingEligibility({ root: a, reportNumber: 1164, today: '2026-09-25', shared }).eligible, true, 'the oldest submission leaves the window exactly 30 days later');
    const canonical = postingEligibility({ root: a, reportNumber: 1165, today: '2026-09-23', shared });
    assert.equal(canonical.eligible, false);
    assert.match(canonical.reasons[0], /Canonical is on the blacklist/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a confirmed prior attempt reconciles the tracker and exits successfully without another click', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-hybrid-reconcile-'));
  const stateDir = path.join(root, 'state');
  const out = path.join(root, 'reconciled.json');
  const url = 'https://jobs.example.test/acme/42';
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'reports'));
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(root, 'reports', '042-acme-2026-09-22.md'), '# Acme\n');
    fs.writeFileSync(
      path.join(root, 'data', 'applications.md'),
      '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 42 | 2026-09-22 | Acme | Engineer | 4.2/5 | Evaluated | ✅ | [42](../reports/042-acme-2026-09-22.md) | |\n',
    );
    fs.writeFileSync(
      path.join(stateDir, 'hybrid-round.json'),
      `${JSON.stringify({ submissionAttempts: [{ dataRoot: root, postingUrl: url, reportNumber: 42, status: 'confirmed', attemptedAt: '2026-09-23T00:00:00.000Z', evidence: 'Application submitted' }] })}\n`,
    );
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', '..', 'scripts', 'apply-hybrid.mjs'), '--url', url, '--row', '42', '--out', out], {
      cwd: path.join(import.meta.dirname, '..', '..'),
      encoding: 'utf8',
      env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_HYBRID_STATE_DIR: stateDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /no submit click was repeated/);
    assert.match(fs.readFileSync(path.join(root, 'data', 'applications.md'), 'utf8'), /\| Applied \|/);
    const metrics = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(metrics.reconciled, true);
    assert.equal(metrics.submitted, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
