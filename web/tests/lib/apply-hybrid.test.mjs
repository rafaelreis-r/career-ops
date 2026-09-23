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
import { buildAnswers, currencyLock, isNonAnswer, matchAnswers, matchOption } from '../../src/lib/apply/hybrid/answers.mjs';
import { selectResumeTarget } from '../../src/lib/apply/hybrid/files.mjs';
import { evaluateGate } from '../../src/lib/apply/hybrid/gate.mjs';
import { attachFile, chooseOption, fillText, selectCombobox } from '../../src/lib/apply/hybrid/adapters.mjs';

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
  const unlabeled = selectResumeTarget([{ key: 'q1', kind: 'file', ownLabel: 'Anexo', label: 'Anexo', accept: '.pdf' }], 'cv.pdf');
  assert.equal(unlabeled.target, null, 'no evidence, no attachment');
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
    const r = await fillText(page.mainFrame(), q, 'fixture value');
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
