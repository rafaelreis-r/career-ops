// adapters.mjs — deterministic Playwright actions, each followed by a DOM
// re-read that decides the outcome. No model is asked whether a field is done:
// a value that is on the page after the action is `verified`, anything else is
// `failed`/`mismatch` with the observed state. Every adapter makes a bounded,
// fixed sequence of attempts and never repeats an action that did not change
// the page (the old loop clicked "Toggle flyout" until loop-detected).

import { scanQuestionsInPage } from './page-scan.mjs';
import { findQuestionByIdentity, matchOption, normalizeText } from './answers.mjs';

const ACTION_TIMEOUT_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Does the widget's displayed selection correspond to the clicked option?
 *  Widgets may render a shorter form of the option (Greenhouse shows "+55"
 *  after "Brazil +55" is chosen), so one text's tokens must appear, in order,
 *  inside the other's. An unrelated or empty display is not a match. */
export function sameChoice(displayed, chosen) {
  const d = normalizeText(displayed);
  const c = normalizeText(chosen);
  if (!d || !c) return false;
  if (d === c) return true;
  const generic = new Set(['yes', 'no', 'sim', 'nao']);
  if (generic.has(d) || generic.has(c)) return false;
  return ` ${c} `.includes(` ${d} `) || ` ${d} `.includes(` ${c} `);
}

const optionPolarity = (s) => {
  const n = normalizeText(s);
  if (/^(yes|sim)(\b|$)/.test(n)) return true;
  if (/^(no|nao)(\b|$)/.test(n)) return false;
  return null;
};

function conflictingBinarySelections(question, desired, selected) {
  const options = question.options || [];
  const exact = options.find((option) => normalizeText(option) === normalizeText(desired));
  const desiredPolarity = exact ? optionPolarity(exact) : new Set(['yes', 'sim']).has(normalizeText(desired)) ? true : new Set(['no', 'nao']).has(normalizeText(desired)) ? false : null;
  const offered = new Set(options.map(optionPolarity).filter((p) => p !== null));
  if (desiredPolarity === null || !offered.has(true) || !offered.has(false)) return [];
  return selected.filter((option) => optionPolarity(option) === !desiredPolarity);
}

/** The question as it is on the page now: by key, or — when a re-render
 *  replaced its node and the rescan gave it a new key — by the same widget
 *  kind and label. Null when it is gone. */
export async function reread(frame, q) {
  const res = await frame.evaluate(scanQuestionsInPage);
  return findQuestionByIdentity(res.questions, q);
}

const control = (frame, key) => frame.locator(`[data-hyb-c="${key}"]`).first();
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const digits = (s) => String(s ?? '').replace(/\D+/g, '');

/** Did the page keep what was typed? Phone inputs may reformat or drop the
 *  country prefix, so they compare digits; everything else compares text. */
export function sameValue(observed, intended, inputType = '') {
  if (collapse(observed) === collapse(intended)) return true;
  if (/tel/i.test(inputType)) {
    const a = digits(observed);
    const b = digits(intended);
    return a.length >= 8 && b.length >= 8 && (a.endsWith(b) || b.endsWith(a));
  }
  return false;
}

/** Type a canonical value and read it back. A value the page altered (a
 *  maxlength cut, a mask that dropped digits) is not left behind looking like
 *  an answer: the field is cleared and the outcome says what the page did. */
export async function fillText(frame, q, value) {
  const loc = control(frame, q.key);
  await loc.fill(value, { timeout: ACTION_TIMEOUT_MS });
  await loc.blur().catch(() => {});
  const after = await reread(frame, q);
  const got = after?.state?.value ?? '';
  if (sameValue(got, value, q.inputType)) return { status: 'verified', observed: got };
  if (!got) return { status: 'failed', reason: 'the value did not stay in the field', observed: got };
  await control(frame, after.key).fill('', { timeout: 2000 }).catch(() => {});
  return { status: 'mismatch', reason: `the page altered the value to "${got.slice(0, 60)}"; field cleared`, observed: got };
}

/**
 * Verify, from the DOM, what a model action left in a question. Text must be
 * the canonical value (a phone may be re-formatted, never re-numbered: its
 * digits must be the tail of the canonical digits) and must fit the field; a
 * choice must show an option that represents the value, literally or, when
 * `equivalent` (a typed model check) says so, semantically. A text value that
 * fails is cleared, so no wrong value is left looking like an answer.
 */
export async function verifyQuestion(frame, q, value, { equivalent = null, fits = null } = {}) {
  const after = await reread(frame, q);
  if (!after) return { status: 'failed', reason: 'the question left the page' };
  if (after.kind === 'text' || after.kind === 'textarea') {
    const got = after.state?.value ?? '';
    if (!got) return { status: 'failed', reason: 'the field is still empty' };
    const misfit = fits ? fits(after, got) : null;
    const phoneLike = /tel/i.test(after.inputType || '') || /phone|telefone|celular|mobile|whatsapp/i.test(after.label || '');
    const dg = digits(got);
    const ok = !misfit && (sameValue(got, value, after.inputType) || (phoneLike && dg.length >= 8 && digits(value).endsWith(dg)));
    if (ok) return { status: 'verified', observed: got };
    await control(frame, after.key).fill('', { timeout: 2000 }).catch(() => {});
    return { status: 'mismatch', reason: `the page held "${got.slice(0, 60)}"${misfit ? ` (${misfit.reason})` : ''}; field cleared`, observed: got };
  }
  if (after.kind === 'file') return { status: 'failed', reason: 'not a value question' };
  const shown = after.state?.selected ?? [];
  if (!shown.length) return { status: 'failed', reason: 'nothing selected' };
  const conflicts = conflictingBinarySelections(after, value, shown);
  if (conflicts.length) return { status: 'mismatch', reason: `the incompatible option is also selected: "${conflicts.join(', ')}"`, observed: shown.join(', ') };
  if (shown.some((s) => sameChoice(s, value) || matchOption([s], value))) return { status: 'verified', observed: shown.join(', ') };
  if (equivalent) {
    for (const s of shown) if (await equivalent(s, value, after.label)) return { status: 'verified', observed: s, how: 'model-equivalent' };
  }
  return { status: 'mismatch', reason: `the page shows "${shown.join(', ')}"`, observed: shown.join(', ') };
}

export async function selectNative(frame, q, index) {
  await control(frame, q.key).selectOption({ index }, { timeout: ACTION_TIMEOUT_MS });
  const after = await reread(frame, q);
  const want = q.options[index];
  const got = after?.state?.selected ?? [];
  return got.includes(want) ? { status: 'verified', observed: want } : { status: 'failed', reason: 'the option did not stay selected', observed: got.join(', ') };
}

/** Activate option `i` of a radio/checkbox/toggle question: a visible control
 *  is clicked, a visually hidden input through its label, else a DOM click. */
async function activateOption(frame, key, i) {
  const opt = frame.locator(`[data-hyb-o="${key}:${i}"]`).first();
  if (await opt.isVisible().catch(() => false)) {
    await opt.click({ timeout: ACTION_TIMEOUT_MS });
    return;
  }
  const id = await opt.getAttribute('id').catch(() => null);
  if (id) {
    const lab = frame.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first();
    if (await lab.isVisible().catch(() => false)) {
      await lab.click({ timeout: ACTION_TIMEOUT_MS });
      return;
    }
  }
  await opt.evaluate((el) => el.click());
}

/** Select option `index` of a radio group, checkbox group, single checkbox or
 *  yes/no toggle. An option already selected is left alone (a second click on
 *  a checkbox would clear it). */
export async function chooseOption(frame, q, index) {
  const want = q.options[index];
  const changed = !(q.state?.selected || []).includes(want);
  if (changed) await activateOption(frame, q.key, index);
  await sleep(150);
  const after = await reread(frame, q);
  const got = after?.state?.selected ?? [];
  const conflicts = after ? conflictingBinarySelections(after, want, got) : [];
  if (conflicts.length) {
    if (changed) await activateOption(frame, after.key, after.options.indexOf(want)).catch(() => {});
    const restored = await reread(frame, after).catch(() => after);
    return { status: 'mismatch', reason: `the incompatible option is already selected: "${conflicts.join(', ')}"; the new selection was undone`, observed: (restored?.state?.selected ?? got).join(', ') };
  }
  return got.includes(want) ? { status: 'verified', observed: want } : { status: 'failed', reason: 'the option did not register as selected', observed: got.join(', ') };
}

// In-page: find the options the open dropdown offers for this combobox, tag
// them `data-hyb-live`, and return their texts. Looks in the listbox the input
// controls, then in the question container (react-select menus), then any
// visible listbox on the page.
function liveOptionsInPage(input) {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  document.querySelectorAll('[data-hyb-live]').forEach((n) => n.removeAttribute('data-hyb-live'));
  const ids = `${input.getAttribute('aria-controls') || ''} ${input.getAttribute('aria-owns') || ''}`.split(/\s+/).filter(Boolean);
  let opts = [];
  for (const id of ids) {
    const lb = document.getElementById(id);
    if (lb) opts = [...lb.querySelectorAll('[role=option]')];
    if (opts.length) break;
  }
  if (!opts.length) {
    const q = input.closest('[data-hyb-q]') || input.parentElement;
    opts = [...q.querySelectorAll('[role=option], [class*=menu] [class*=option]')];
  }
  if (!opts.length) opts = [...document.querySelectorAll('[role=listbox] [role=option]')];
  opts = opts.filter(vis).filter((o) => !/^(loading|searching|no options|no results|nenhum resultado|type to search|start typing)/i.test((o.textContent || '').trim()));
  return opts.map((o, i) => {
    o.setAttribute('data-hyb-live', String(i));
    return (o.textContent || '').replace(/\s+/g, ' ').trim();
  });
}

async function waitForOptions(input, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last = [];
  let stableSince = 0;
  while (Date.now() < end) {
    const now = await input.evaluate(liveOptionsInPage).catch(() => []);
    if (now.length && now.join('|') === last.join('|')) {
      if (Date.now() - stableSince > 400) return now;
    } else {
      stableSince = Date.now();
    }
    last = now;
    await sleep(150);
  }
  return last;
}

async function clearCombobox(input) {
  await input.fill('', { timeout: 2000 }).catch(() => {});
  await input.press('Escape', { timeout: 2000 }).catch(() => {});
}

/**
 * Custom dropdown (react-select, Ashby "Start typing...", async location
 * search): type the canonical value, read the options the widget offers,
 * choose one deterministically — or, when no option matches literally and a
 * `pick` (Jev) is given, let the model choose among the OFFERED texts — click
 * it, and re-read the widget's selected value. At most two queries (the full
 * value, then its first segment when the full one returns nothing). On any
 * failure the search text is cleared so no typed-but-unselected text is left
 * looking like an answer.
 */
export async function selectCombobox(frame, q, desired, { pick = null } = {}) {
  const input = control(frame, q.key);
  const queries = [desired];
  const head = desired.split(/[,(]/)[0].trim();
  if (head && head !== desired) queries.push(head);
  const steps = [];
  let options = [];
  let query = desired;
  await input.click({ timeout: ACTION_TIMEOUT_MS });
  for (query of queries) {
    await input.fill('');
    await input.pressSequentially(query, { delay: 20 });
    options = await waitForOptions(input, 6000);
    steps.push({ query, offered: options.length });
    if (options.length) break;
  }
  if (!options.length) {
    await clearCombobox(input);
    return { status: 'failed', reason: 'the dropdown offered no option for the canonical value', steps };
  }
  let m = matchOption(options, desired) || (query !== desired ? matchOption(options, query) : null);
  let how = m?.how ?? null;
  if (!m && pick) {
    const r = await pick(options, { label: q.label, desiredValue: desired });
    if (r?.index != null) {
      m = { index: r.index };
      how = 'jev-pick';
    }
  }
  if (!m) {
    await clearCombobox(input);
    return { status: 'no-option', reason: 'no offered option represents the canonical value', offered: options.slice(0, 12), steps };
  }
  const chosen = options[m.index];
  await frame.locator(`[data-hyb-live="${m.index}"]`).first().click({ timeout: ACTION_TIMEOUT_MS });
  // The widget may re-render (even replace its node) before showing the value:
  // re-read for up to 2.5 s. One click, then only reads.
  let got = [];
  let after = null;
  for (const end = Date.now() + 2500; Date.now() < end; ) {
    await sleep(250);
    after = await reread(frame, q);
    got = after?.state?.selected ?? [];
    const shown = got.find((g) => sameChoice(g, chosen));
    if (shown) return { status: 'verified', observed: shown === chosen ? chosen : `${chosen} (shown as "${shown}")`, how, steps };
  }
  await clearCombobox(after ? control(frame, after.key) : input);
  return { status: 'failed', reason: `clicked "${chosen}" but the widget shows "${got.join(', ') || 'nothing'}"`, how, steps };
}

async function waitForFile(frame, q, cvName, ms) {
  const end = Date.now() + ms;
  let after = null;
  while (Date.now() < end) {
    after = await reread(frame, q);
    const s = after?.state || {};
    if ((s.files || []).includes(cvName) || String(s.text || '').includes(cvName)) return { ok: true, after };
    await sleep(400);
  }
  return { ok: false, after };
}

/** Attach the CV and wait (bounded) for the page to show it: the input holds
 *  the file, or the ATS consumed it and displays the filename. When setting
 *  the input does not register, the question's own upload control is clicked
 *  and the browser's file chooser receives the CV (the path a person takes). */
export async function attachFile(frame, q, cvPath, cvName) {
  await control(frame, q.key).setInputFiles(cvPath, { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
  let w = await waitForFile(frame, q, cvName, 8000);
  if (w.ok) return { status: 'verified', observed: cvName, how: 'setInputFiles' };
  const trigger = frame
    .locator(`[data-hyb-q="${q.key}"]`)
    .locator('button, a, [role=button], label')
    .filter({ hasText: /attach|upload|browse|choose|select|anexar|enviar|carregar|selecionar|resume|résumé|\bcv\b|curr[ií]culo/i })
    .first();
  if (await trigger.isVisible().catch(() => false)) {
    const chooser = frame.page().waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
    await trigger.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
    const fc = await chooser;
    if (fc) {
      await fc.setFiles(cvPath).catch(() => {});
      w = await waitForFile(frame, q, cvName, 8000);
      if (w.ok) return { status: 'verified', observed: cvName, how: 'file-chooser' };
    }
  }
  return { status: 'unverified', reason: 'the page does not show the attached file', observed: JSON.stringify(w.after?.state ?? null).slice(0, 160) };
}

// In-page: count controls an applicant fills (not search boxes), and find the
// "open the application" trigger. A control that would submit a form holding
// applicant controls is never the trigger, whatever it says; a submit button
// of a form with no applicant control only navigates (recrut.ai's
// "Inscrever-se na vaga" posts to /job-apply/ to open the form).
function applyProbeInPage() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const fillable = [...document.querySelectorAll('input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=file], textarea')]
    .filter((el) => (el.type === 'file' ? true : vis(el)) && !/search|busca|pesquis/i.test(`${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.name || ''}`));
  const applicantFile = fillable.some((el) => el.type === 'file');
  const applicantControls = (form) => form.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), textarea, select').length;
  document.querySelectorAll('[data-hyb-apply]').forEach((n) => n.removeAttribute('data-hyb-apply'));
  const SUBMIT_RX = /^(submit|send|apply|enviar|finalizar|concluir|candidatar|postular|aplicar|bewerben)\b|submit application|send application|enviar candidatura/i;
  const REVEAL_RX = /^inscrever-se na vaga$/i;
  const trigger = [...document.querySelectorAll('button, a, [role=button], input[type=submit], input[type=button]')].find((el) => {
    if (!vis(el)) return false;
    const text = `${el.textContent || ''} ${el.value || ''} ${el.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim();
    const href = el.getAttribute('href') || el.getAttribute('formaction') || el.form?.getAttribute('action') || '';
    // `type` is the effective type: a <button> without the attribute submits too.
    if ((el.type === 'submit' || el.type === 'image') && el.form && applicantControls(el.form) > 0) return false;
    if (SUBMIT_RX.test(text) && !REVEAL_RX.test(el.textContent.replace(/\s+/g, ' ').trim())) return false;
    if (!REVEAL_RX.test(el.textContent.replace(/\s+/g, ' ').trim()) && !/\/(apply|job-apply|candidat)/i.test(href)) return false;
    if (/linkedin|indeed|facebook|twitter|mailto:/i.test(href)) return false;
    return true;
  });
  if (trigger) trigger.setAttribute('data-hyb-apply', '1');
  // Only a dismiss/accept control of a cookie banner, matched on whole words:
  // "ok" inside "cookies" once clicked recrut.ai's "learn more about cookies",
  // which opened a second tab (2026-09-22).
  const cookie = [...document.querySelectorAll('button, [role=button]')].find((el) => {
    const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`;
    const inBanner = /cookie/i.test(`${el.getAttribute('aria-label') || ''} ${el.closest('[class*=cookie], [id*=cookie], [aria-label*=cookie i]') ? 'cookie' : ''}`);
    return vis(el) && inBanner && /\b(dismiss|accept|accept all|agree|ok|got it|entendi|aceitar|aceito|fechar|close)\b/i.test(text) && !/learn more|saiba mais|more info|settings|prefer[eê]ncias|configura/i.test(text);
  });
  if (cookie) cookie.setAttribute('data-hyb-cookie', '1');
  const text = (document.body?.innerText || '').slice(0, 20000);
  // A human-verification wall (Cloudflare, hCaptcha interstitial) is a step
  // for the captain, not a missing form; a closed/removed posting is the only
  // page with nothing to fill.
  const challenge = !!document.querySelector('iframe[src*="challenges.cloudflare"], .cf-turnstile, #challenge-form, #cf-challenge-running') || /verify you are human|confirme que [eé] humano|checking your browser|verificando (seu|o) navegador/i.test(text);
  const closed = /no longer (available|accepting applications|open)|job (is )?(closed|expired|no longer)|(position|job) has been (filled|closed|removed)|posting (has been )?(closed|removed)|this job (has )?expired|vaga (foi )?(encerrada|expirada|fechada)|n[aã]o est[aá] mais dispon[ií]vel|page (was )?not found|p[aá]gina n[aã]o encontrada/i.test(text);
  return { fillable: fillable.length, applicantFile, trigger: trigger ? (trigger.textContent || trigger.value || trigger.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80) : null, cookie: !!cookie, challenge, closed };
}

/**
 * Bring the application form on screen. A page with two or more applicant
 * fields is already the form. Otherwise click the apply trigger (a control that
 * opens the application, never a final submit) and wait for the fields; at most
 * two clicks.
 */
export async function reachApplicationForm(page) {
  const log = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const probe = await page.evaluate(applyProbeInPage).catch(() => ({ fillable: 0, applicantFile: false, trigger: null, cookie: false, challenge: false, closed: false }));
    if (probe.fillable >= 2 || probe.applicantFile) return { reached: true, url: page.url(), log };
    if (probe.challenge) return { reached: false, challenge: true, url: page.url(), log, reason: 'a human-verification challenge stands before the form' };
    if (attempt === 2 || !probe.trigger) {
      return { reached: false, closed: probe.closed, url: page.url(), log, reason: probe.closed ? 'the posting is closed or removed' : probe.trigger ? 'no applicant fields after the apply click' : 'no applicant fields and no apply trigger' };
    }
    if (probe.cookie) await page.locator('[data-hyb-cookie]').first().click({ timeout: 3000 }).catch(() => {});
    const before = page.url();
    await page.locator('[data-hyb-apply]').first().click({ timeout: ACTION_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const p = await page.evaluate(applyProbeInPage).catch(() => null);
      if (p && (p.fillable >= 2 || p.applicantFile)) break;
    }
    log.push({ clicked: probe.trigger, from: before, to: page.url() });
  }
  return { reached: false, url: page.url(), log };
}
