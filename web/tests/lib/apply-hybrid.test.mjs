// Hybrid apply driver (web/scripts/apply-hybrid.mjs): the deterministic parts,
// against markup and labels captured from the four real forms of the
// 2026-09-22 measurement (web/src/lib/apply/__fixtures__/hybrid-*.html) —
// Wellhub/Greenhouse, Camunda/Ashby, iTRTech/recrut.ai, Storyteller/applytojob.
// No live site, no model: Jev is stubbed where a decision is involved.
//
// Each browser test pins one of the three defects the old per-field loop had:
//   1. completion is read from the DOM after one action, never asked of a model;
//   2. a custom dropdown gets exactly one selection attempt, compared with the
//      widget state, and never leaves typed-but-unselected text behind;
//   3. the pre-submit gate sees a required checkbox GROUP whose inputs carry
//      no `required` attribute (the Storyteller false "passed").
//
// Run:  node --test tests/lib/apply-hybrid.test.mjs   (from web/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { scanQuestionsInPage } from '../../src/lib/apply/hybrid/page-scan.mjs';
import { answerYesNoFromFacts, buildAnswers, currencyLock, isNonAnswer, lockFor, matchAnswers, matchOption } from '../../src/lib/apply/hybrid/answers.mjs';
import { selectResumeTarget } from '../../src/lib/apply/hybrid/files.mjs';
import { evaluateGate, orderTabs, tabStatus } from '../../src/lib/apply/hybrid/gate.mjs';
import { resolvePostingCv } from '../../src/lib/apply/hybrid/cv.mjs';
import { attachFile, chooseOption, fillText, selectCombobox } from '../../src/lib/apply/hybrid/adapters.mjs';
import { mapActionsToQuestions } from '../../src/lib/apply/hybrid/stagehand.mjs';
import { trackerStanding } from '../../src/lib/apply/hybrid/tracker-row.mjs';

const FIXTURES = path.join(import.meta.dirname, '..', '..', 'src', 'lib', 'apply', '__fixtures__');

// Real labels, verbatim from the live pages.
const WELLHUB_COMMISSION = '(FOR COMMISSIONED ROLES ONLY) What is your average monthly variable compensation or commission? (In reais).*';
const WELLHUB_EXPECTED = 'What is your expected base salary for this role? (in reais)*';
const STORY_SALARY = 'Yearly Salary Expectations (in USD)*';
const STORY_SCHEDULE = 'Are you able to work 8am-4pm Eastern Time, with availability during key evening/weekend tentpole moments?*';
const PHONE_CODE_OPTIONS = ['BRA (+55)', 'USA (+1)', 'ARG (+54)', 'MEX (+52)', 'CHL (+56)', 'ESP (+34)', 'PRT (+351)', 'DEU (+49)', 'NLD (+31)', 'ITA (+39)', 'GBR (+44)', 'FRA (+33)'];

// --- answers: non-answers, currency, options, Jev staging (no browser) -------

test('report entries that record an open question are not canonical values', () => {
  // Verbatim from the Storyteller (2123) and Wellhub (1127) Application Answers.
  assert.equal(isNonAnswer('NOT ANSWERED: candidate confirmation required; no sport-following claim is present in Track C sources.'), true);
  assert.equal(isNonAnswer('OPEN: candidate confirmation required; profile confirms partial US/EU overlap but not this exact schedule or weekend availability.'), true);
  assert.equal(isNonAnswer('left blank: candidate confirmation required; no current base value was used'), true);
  assert.equal(isNonAnswer('14 days'), false);
  const answers = buildAnswers(
    [{ label: 'Current base salary', value: 'left blank: candidate confirmation required; no current base value was used' }, { label: 'Phone', value: '+55 31 98427-7956' }],
    [{ label: 'Phone', value: '31 98427-7956' }, { label: 'Email', value: 'someone@example.com' }],
  );
  assert.deepEqual(answers.map((a) => [a.label, a.source]), [['Phone', 'report'], ['Email', 'profile']], 'the open entry is dropped and the report answer wins its label');
});

test('a money answer never lands in a field that names another currency', () => {
  const usd = { label: 'Desired Salary', value: 'USD 8000/month' };
  assert.deepEqual(currencyLock({ label: WELLHUB_COMMISSION }, usd), { reason: 'currency-mismatch', fieldCurrency: 'BRL', answerCurrency: 'USD' });
  assert.equal(currencyLock({ label: WELLHUB_EXPECTED }, { label: 'Expected base salary for this role (reais)', value: '28000' }), null, 'a BRL answer fits a field in reais');
  assert.equal(currencyLock({ label: STORY_SALARY }, { label: 'Yearly Salary Expectations (in USD)', value: '80000' }), null);
  assert.deepEqual(currencyLock({ label: STORY_SALARY }, { label: 'Pretensão salarial', value: '20000' }), { reason: 'currency-mismatch', fieldCurrency: 'USD', answerCurrency: null }, 'an answer that names no currency is not assumed to be dollars');
  assert.equal(currencyLock({ label: STORY_SALARY }, { label: 'Consent', value: 'Yes' }), null, 'a value without digits is not money');
});

test('an option is chosen only when it represents the canonical value uniquely', () => {
  assert.equal(matchOption(PHONE_CODE_OPTIONS, 'BRA (+55)').index, 0);
  assert.equal(matchOption(PHONE_CODE_OPTIONS, '+55').index, 0, 'the profile stores the code alone');
  assert.equal(matchOption(['United States +1', 'Afghanistan +93', 'Brazil +55'], 'Brazil').index, 2);
  const sms = ['Yes - I consent to receiving text messages', 'No - I do not consent to receiving text messages'];
  assert.equal(matchOption(sms, 'No').index, 1);
  assert.equal(matchOption(['Yes', 'No'], 'Authorized to work in Brazil. No sponsorship needed.'), null, 'a sentence mentioning "no" is not the option "No"');
});

test('exact labels skip Jev; the report is asked before the profile; below-threshold is no answer', async () => {
  const answers = buildAnswers(
    [{ label: 'Country Phone Code', value: 'BRA (+55)' }, { label: 'Expected base salary for this role (reais)', value: '28000' }],
    [{ label: 'First Name', value: 'Rafael' }, { label: 'Desired Salary', value: 'USD 8000/month' }, { label: 'LinkedIn', value: 'https://linkedin.com/in/example' }],
  );
  const questions = [
    { key: 'q0', label: 'First Name*', kind: 'text' },
    { key: 'q1', label: 'Please select your Country Phone Code*', kind: 'combobox' },
    { key: 'q2', label: WELLHUB_COMMISSION, kind: 'text' },
    { key: 'q3', label: 'LinkedIn Profile*', kind: 'text' },
  ];
  const requests = [];
  const ask = async ({ questions: spec }) => {
    requests.push(Object.keys(spec));
    const offered = Object.keys(Object.values(spec)[0].options);
    const idOf = (value) => offered.find((id) => Object.values(spec)[0].options[id].includes(`"${value}"`));
    const out = {};
    for (const key of Object.keys(spec)) {
      if (requests.length === 1 && key === 'q1') out[key] = { choice: idOf('BRA (+55)'), confidence: 0.9 };
      else if (requests.length === 2 && key === 'q2') out[key] = { choice: idOf('USD 8000/month'), confidence: 0.95 };
      else if (requests.length === 2 && key === 'q3') out[key] = { choice: idOf('https://linkedin.com/in/example'), confidence: 0.4 };
      else out[key] = { choice: 'NONE', confidence: 0.9 };
    }
    return { enabled: true, answers: out };
  };
  const { decisions, jev } = await matchAnswers(questions, answers, { ask, threshold: 0.6 });
  assert.deepEqual(requests, [['q1', 'q2', 'q3'], ['q2', 'q3']], 'First Name matched exactly, so it never reaches Jev; the profile stage only sees what the report left open');
  assert.equal(jev.requests, 2);
  assert.equal(decisions.get('q0').source, 'exact');
  assert.equal(decisions.get('q1').answer.value, 'BRA (+55)');
  assert.equal(decisions.get('q2').lock.reason, 'currency-mismatch', 'even a confident pick is locked out of a field in reais');
  assert.equal(decisions.get('q3').answer, null, 'confidence 0.4 is below the 0.6 threshold: no value');
});

test('the CV goes only to an input identified as the resume that accepts the file', () => {
  const itr = selectResumeTarget(
    [
      { key: 'q4', kind: 'file', ownLabel: 'Carregador de avatar de usuário.', label: 'Carregador de avatar de usuário.', id: 'avatar-uploader', accept: 'image/jpeg,image/jpg,image/png,image/bmp' },
      { key: 'q9', kind: 'file', ownLabel: 'Currículo*', label: 'Currículo*', id: 'inputCV', accept: 'application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,text/plain,application/rtf,image/jpeg,image/jpg,image/png' },
    ],
    'cv.pdf',
  );
  assert.equal(itr.target.key, 'q9', 'iTRTech: the photo input came first and must not receive the PDF');
  const wellhub = selectResumeTarget(
    [
      { key: 'q6', kind: 'file', ownLabel: 'Attach', label: 'Resume/CV*', id: 'resume', accept: '.pdf,.doc,.docx,.txt,.rtf' },
      { key: 'q7', kind: 'file', ownLabel: 'Attach', label: 'Cover Letter', id: 'cover_letter', accept: '.pdf,.doc,.docx,.txt,.rtf' },
    ],
    'cv.pdf',
  );
  assert.equal(wellhub.target.key, 'q6');
  const sole = selectResumeTarget([{ key: 'q1', kind: 'file', ownLabel: 'Anexo', label: 'Anexo', accept: '.pdf' }], 'cv.pdf');
  assert.equal(sole.target.key, 'q1', 'the one unnamed document input is the upload slot: the CV is never left off');
  const two = selectResumeTarget(
    [
      { key: 'q1', kind: 'file', ownLabel: 'Anexo', label: 'Anexo', accept: '.pdf' },
      { key: 'q2', kind: 'file', ownLabel: 'Anexo 2', label: 'Anexo 2', accept: '.pdf' },
    ],
    'cv.pdf',
  );
  assert.equal(two.target, null, 'two unnamed document inputs: the model decides, not the first one');
  assert.equal(selectResumeTarget([{ key: 'q1', kind: 'file', ownLabel: 'Resume', label: 'Resume', accept: 'image/*' }], 'cv.pdf').reason, 'the resume input does not accept this file type');
});

// --- real markup in a real browser ---------------------------------------------

async function openFixture(t, name) {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 5000 });
  } catch (err) {
    t.skip(`chrome not available (${err.message})`);
    return null;
  }
  t.after(async () => {
    await browser.close();
  });
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(FIXTURES, name)).href);
  return page;
}

const scan = (page) => page.mainFrame().evaluate(scanQuestionsInPage);
const byLabel = (s, label) => s.questions.find((q) => q.label === label);

test('Storyteller: the gate blocks the required checkbox group that no input marks required', async (t) => {
  const page = await openFixture(t, 'hybrid-applytojob-storyteller.html');
  if (!page) return;
  assert.equal(await page.$$eval('input[type=checkbox]', (els) => els.some((e) => e.required)), false, 'the real inputs carry no required attribute');
  const before = await scan(page);
  const group = byLabel(before, STORY_SCHEDULE);
  assert.equal(group.kind, 'checkbox-group');
  assert.deepEqual(group.options, ['Yes', 'No']);
  assert.equal(group.required, true, 'required is read from the question label, not the inputs');

  const outcomes = new Map();
  for (const q of before.questions.filter((x) => x.kind === 'text' || x.kind === 'textarea')) {
    const r = await fillText(page.mainFrame(), q, q.inputType === 'email' ? 'fixture@example.com' : 'fixture value');
    assert.equal(r.status, 'verified', `${q.label}: one fill, verified from the DOM`);
    outcomes.set(q.key, r);
  }
  const gate = evaluateGate(await scan(page), outcomes);
  assert.equal(gate.ready, false);
  assert.deepEqual(gate.blockers.map((b) => b.label).sort(), ['Resume*', STORY_SCHEDULE].sort(), 'every text field is filled; the unchecked group and the missing resume still block');
});

test('Wellhub: a filled First Name is done the moment the DOM shows it', async (t) => {
  const page = await openFixture(t, 'hybrid-greenhouse-wellhub.html');
  if (!page) return;
  const first = byLabel(await scan(page), 'First Name*');
  const r = await fillText(page.mainFrame(), first, 'Rafael');
  assert.deepEqual(r, { status: 'verified', observed: 'Rafael' });
  const gate = evaluateGate(await scan(page), new Map([[first.key, r]]));
  assert.equal(gate.blockers.some((b) => b.label === 'First Name*'), false);
});

test('Wellhub: Country Phone Code is selected once and verified in the widget', async (t) => {
  const page = await openFixture(t, 'hybrid-greenhouse-wellhub.html');
  if (!page) return;
  const q = byLabel(await scan(page), 'Please select your Country Phone Code*');
  assert.equal(q.kind, 'combobox');
  assert.equal(q.required, true);
  const r = await selectCombobox(page.mainFrame(), q, '+55');
  assert.equal(r.status, 'verified');
  assert.equal(r.observed, 'BRA (+55)');
  assert.equal(await page.evaluate(() => window.__clicks), 1);
  assert.deepEqual(byLabel(await scan(page), 'Please select your Country Phone Code*').state.selected, ['BRA (+55)']);
});

test('Wellhub: a dropdown that ignores the click fails after one attempt and leaves no typed text', async (t) => {
  const page = await openFixture(t, 'hybrid-greenhouse-wellhub.html');
  if (!page) return;
  await page.evaluate(() => {
    window.__INERT = true;
  });
  const q = byLabel(await scan(page), 'Please select your Country Phone Code*');
  const r = await selectCombobox(page.mainFrame(), q, '+55');
  assert.equal(r.status, 'failed');
  assert.equal(await page.evaluate(() => window.__clicks), 1, 'the same click is never repeated');
  const after = byLabel(await scan(page), 'Please select your Country Phone Code*');
  assert.deepEqual(after.state, { selected: [], typed: '' });
  const gate = evaluateGate(await scan(page), new Map([[q.key, r]]));
  assert.ok(gate.blockers.some((b) => b.label === 'Please select your Country Phone Code*'));
});

test('Wellhub: the salary fields in reais keep their real labels and currency', async (t) => {
  const page = await openFixture(t, 'hybrid-greenhouse-wellhub.html');
  if (!page) return;
  const s = await scan(page);
  const commission = byLabel(s, WELLHUB_COMMISSION);
  const expected = byLabel(s, WELLHUB_EXPECTED);
  assert.equal(commission.required, true);
  assert.equal(currencyLock(commission, { label: 'Desired Salary', value: 'USD 8000/month' }).fieldCurrency, 'BRL');
  assert.equal(currencyLock(expected, { label: 'Expected base salary for this role (reais)', value: '28000' }), null);
});

test('iTRTech: the PDF lands on Currículo, never on the photo input that comes first', async (t) => {
  const page = await openFixture(t, 'hybrid-recrutai-itrtech.html');
  if (!page) return;
  const files = (await scan(page)).questions.filter((q) => q.kind === 'file');
  assert.deepEqual(files.map((q) => q.id), ['avatar-uploader', 'inputCV'], 'the photo input is first in the page');
  const sel = selectResumeTarget(files, 'cv.pdf');
  assert.equal(sel.target.id, 'inputCV');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-hybrid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cv = path.join(dir, 'cv-fixture.pdf');
  fs.writeFileSync(cv, '%PDF-1.4 fixture, not a real CV\n');
  const r = await attachFile(page.mainFrame(), sel.target, cv, 'cv-fixture.pdf');
  assert.equal(r.status, 'verified');
  assert.equal(await page.$eval('#avatar-uploader', (el) => el.files.length), 0);
});

test('iTRTech: a phone the page truncates is cleared and blocks, never kept as an answer', async (t) => {
  const page = await openFixture(t, 'hybrid-recrutai-itrtech.html');
  if (!page) return;
  const phone = byLabel(await scan(page), 'Celular de contato*');
  assert.equal(phone.required, true);
  // The profile's full international number against the real maxlength="15".
  const r = await fillText(page.mainFrame(), phone, '+55 31 98427-7956');
  assert.equal(r.status, 'mismatch');
  assert.equal(r.observed, '+55 31 98427-79');
  assert.equal(await page.inputValue('#inputMobilePhone'), '');
  const gate = evaluateGate(await scan(page), new Map([[phone.key, r]]));
  assert.match(gate.blockers.find((b) => b.label === 'Celular de contato*').reason, /required and empty \(mismatch/);
});

test('iTRTech: an observed XPath still finds its question after the page prepends a node to <body>', async (t) => {
  const page = await openFixture(t, 'hybrid-recrutai-itrtech.html');
  if (!page) return;
  const cv = (await scan(page)).questions.find((q) => q.id === 'inputCV');
  // Positional XPath as Stagehand builds it from the document it read.
  const xpath = await page.$eval('#inputCV', (el) => {
    const seg = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      let i = 1;
      for (let p = n.previousElementSibling; p; p = p.previousElementSibling) if (p.tagName === n.tagName) i++;
      seg.unshift(`${n.tagName.toLowerCase()}[${i}]`);
    }
    return `/${seg.join('/')}`;
  });
  // recrut.ai injects its video-player sprite at the top of <body> after load.
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'sprite-plyr';
    document.body.prepend(d);
  });
  assert.equal(await page.locator(`xpath=${xpath}`).count(), 0, 'the observed path no longer resolves as written');
  const { keys } = await mapActionsToQuestions(page, [{ selector: `xpath=${xpath}`, description: 'Currículo' }]);
  assert.deepEqual([...keys], [cv.key]);
});

test('Camunda: autofill is not the resume, and a yes/no toggle is verified by aria-pressed', async (t) => {
  const page = await openFixture(t, 'hybrid-ashby-camunda.html');
  if (!page) return;
  const s = await scan(page);
  const sel = selectResumeTarget(s.questions.filter((q) => q.kind === 'file'), 'cv.pdf');
  assert.equal(sel.target.label, 'Resume');
  assert.equal(sel.considered.find((c) => c.label === 'Autofill from resume').kind, 'autofill');
  const eligible = byLabel(s, 'Are you legally eligible to work in the country where you’re planning to work from?');
  assert.equal(eligible.kind, 'toggle');
  assert.equal(eligible.required, true, "Ashby marks required with a class on the label");
  const r = await chooseOption(page.mainFrame(), eligible, eligible.options.indexOf('Yes'));
  assert.equal(r.status, 'verified');
  assert.equal(await page.getAttribute('button[data-option=yes]', 'aria-pressed'), 'true');
  const status = byLabel(s, 'If you are eligible, please select the status that allows you to work and live in that Country');
  assert.equal(status.kind, 'radio');
  assert.equal(status.options.length, 3);
});

test('Camunda: a yes/no toggle no answer names is judged from the facts; a consent toggle and a 3-option radio never are', async (t) => {
  const page = await openFixture(t, 'hybrid-ashby-camunda.html');
  if (!page) return;
  const s = await scan(page);
  const eligible = byLabel(s, 'Are you legally eligible to work in the country where you’re planning to work from?');
  const status = byLabel(s, 'If you are eligible, please select the status that allows you to work and live in that Country');
  // Same widget as the eligibility toggle, label verbatim from the live Camunda SRE form (2026-09-22).
  const consent = { ...eligible, key: 'brighthire', label: "Do you consent to BrightHire's Interview Integrity feature analyzing your interview for potential fraud signals—including deepfake detection, device consistency, and location checks—to help our team review interview authenticity? (This is separate from interview recording consent.)?" };
  const asked = [];
  const bool = async (question) => {
    asked.push(question);
    return { bool: true, confidence: 0.9 };
  };
  const facts = buildAnswers([], [{ label: 'Work Authorization', value: 'Brazil-based, remote only. No sponsorship needed' }]);
  const out = await answerYesNoFromFacts([eligible, status, consent], facts, { bool });
  assert.deepEqual(asked, [eligible.label]);
  assert.equal(out.get(eligible.key).answer.value, 'Yes');
  assert.equal(matchOption(eligible.options, out.get(eligible.key).answer.value)?.index, eligible.options.indexOf('Yes'));
});

// --- SMG (applytojob, 2026-09-22): the three errors the live round shipped ---

const SMG_ADDRESS = 'Address';
const SMG_SALARY = 'What are your annual salary requirements in $USD*';

test('SMG: the e-mail never goes into Address and a monthly amount never into the annual salary', async (t) => {
  const page = await openFixture(t, 'hybrid-applytojob-smg.html');
  if (!page) return;
  const s = await scan(page);
  const address = byLabel(s, SMG_ADDRESS);
  const salary = byLabel(s, SMG_SALARY);
  assert.equal(address.kind, 'text');
  assert.equal(salary.required, true);
  // Before typing: both canonical values are locked out of these fields.
  assert.equal(lockFor(address, { label: 'Email Address', value: 'someone@example.com' }).reason, 'type-mismatch');
  assert.match(lockFor(salary, { label: 'Desired Salary', value: 'USD 8000/month' }).text, /monthly amount in a field that asks for annual/);
  assert.equal(lockFor(salary, { label: 'Yearly salary (USD)', value: '96000' }), null, 'an annual USD figure fits');
  // After the fact: whatever put them there, the gate refuses them from the DOM.
  await page.fill('#resumator-address-value', 'someone@example.com');
  await page.fill('#resumator-questionnaire-q3022689', 'USD 8000/month');
  const gate = evaluateGate(await scan(page), new Map());
  const misfits = gate.blockers.filter((b) => b.kind === 'type-mismatch').map((b) => b.label);
  assert.deepEqual(misfits.sort(), [SMG_ADDRESS, SMG_SALARY].sort());
});

test("SMG: another posting's CV is refused; the posting's own PDF is used, or none so it gets generated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-hybrid-cv-'));
  try {
    for (const d of ['reports', 'output', 'data']) fs.mkdirSync(path.join(root, d));
    const report = path.join(root, 'reports', '617-service-management-group-smg-2026-09-14.md');
    fs.writeFileSync(report, '# SMG\n\n**PDF:** not generated in this evaluation-only batch pass (captain override)\n');
    const other = path.join(root, 'output', 'cv-candidate-fingerprint-2026-09-17.pdf');
    fs.writeFileSync(other, '%PDF-1.4 another posting\n');
    fs.writeFileSync(path.join(root, 'data', 'pdf-index.tsv'), '# report\tpdf\thtml\tformat\tdate\n601\toutput/cv-candidate-fingerprint-2026-09-17.pdf\toutput/x.html\ta4\t2026-09-17\n');

    const refused = resolvePostingCv({ root, reportPath: report, explicitCv: other });
    assert.equal(refused.path, null, 'the file the SMG round attached is not this posting\'s CV');
    assert.match(refused.rejected[0].reason, /made for report 601, not 617/);

    const own = path.join(root, 'output', 'cv-rafael-reis-service-management-group-smg-2026-09-22.pdf');
    fs.writeFileSync(own, '%PDF-1.4 this posting\n');
    fs.appendFileSync(path.join(root, 'data', 'pdf-index.tsv'), '617\toutput/cv-rafael-reis-service-management-group-smg-2026-09-22.pdf\toutput/y.html\tletter\t2026-09-22\n');
    const found = resolvePostingCv({ root, reportPath: report, explicitCv: other });
    assert.deepEqual([found.path, found.source], [own, 'pdf-index']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a CV the report links and names by report number (not by company) is this posting\'s CV', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-hybrid-cv-'));
  try {
    for (const d of ['reports', 'output', 'data']) fs.mkdirSync(path.join(root, d));
    const report = path.join(root, 'reports', '2003-itrtech-2026-09-21.md');
    fs.writeFileSync(report, '# iTRTech\n');
    const byRole = path.join(root, 'output', 'cv-rafael-reis-2003-desenvolvedor-backend-2026-09-22.pdf');
    fs.writeFileSync(byRole, '%PDF-1.4\n');

    const unlinked = resolvePostingCv({ root, reportPath: report, explicitCv: byRole });
    assert.equal(unlinked.path, null, 'a file nothing links to this report never passes on a number alone');

    fs.writeFileSync(path.join(root, 'data', 'pdf-index.tsv'), '2003\toutput/cv-rafael-reis-2003-desenvolvedor-backend-2026-09-22.pdf\toutput/x.html\ta4\t2026-09-22\n');
    const linked = resolvePostingCv({ root, reportPath: report });
    assert.deepEqual([linked.path, linked.source], [byRole, 'pdf-index']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the round leaves forms that only need the human first, then the fewest pending items', () => {
  const tab = (url, blockers) => ({ url, ...tabStatus({ ready: !blockers.length, blockers }) });
  const captcha = { kind: 'captcha', key: null, label: 'captcha', reason: '' };
  const req = (label) => ({ kind: 'required-empty', key: label, label, reason: '' });
  const tabs = [
    tab('camunda', [req('Post Code'), req('What is your Legal first and last name?'), captcha]),
    tab('storyteller', [req(STORY_SCHEDULE)]),
    tab('wellhub', [captcha]),
    { url: 'opened-by-hand', status: 'unknown', pending: [] },
  ];
  assert.deepEqual(tabs[2], { url: 'wellhub', status: 'ready-captcha', pending: [] });
  assert.deepEqual(tabs[0].pending, ['Post Code', 'What is your Legal first and last name?'], 'the captcha is not a pending field');
  assert.deepEqual(orderTabs(tabs).map((x) => x.url), ['wellhub', 'storyteller', 'camunda', 'opened-by-hand']);
});

test('a posting the tracker marks Applied (or an alias of it) never enters the round; Evaluated does', () => {
  // Header and rows as the track C tracker writes them (2026-09-22: 2010, 2078
  // and 2170 were already submitted and still got queued for a new round).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-hybrid-tracker-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(
      path.join(root, 'data', 'applications.md'),
      [
        '# Applications Tracker',
        '',
        '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |',
        '|---|------|---------|-----|------|-------|--------|-----|--------|-------|',
        '| 2010 | 2026-08-17 | Deepgram | — | Senior Program Manager, Data Operations | 3.5/5 | Applied | ✅ | [2010](../reports/2010-deepgram-senior-program-manager-data-operations-2026-08-17.md) | sent 2026-09-21 |',
        '| 2078 | 2026-08-22 | Clipboard | — | AI Tooling Program Manager | 3.6/5 | Aplicado | ✅ | [2078](../reports/2078-clipboard-ai-tooling-program-manager-2026-08-22.md) | |',
        '| 2187 | 2026-09-14 | Johnson & Johnson MedTech | — | Business, Process and Transformation Lead Latam | 3.5/5 | Evaluated | ✅ | [2187](../reports/2187-johnson-johnson-medtech-2026-09-14.md) | |',
        '',
      ].join('\n'),
    );
    const sent = (n) => trackerStanding(root, n).sent;
    assert.deepEqual([sent(2010), sent('2078'), sent(2187), sent(9999)], [true, true, false, false]);
    assert.equal(trackerStanding(root, 2078).canonical, 'Applied');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
