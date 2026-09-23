// submit.mjs — the only way an application leaves the driver, and the lock
// that stops every other way.
//
// The lock is installed in every frame of the form's tab before the posting is
// even loaded, and stays on while the driver works: a `submit` event, a
// `form.submit()` / `form.requestSubmit()` call (so also a button without a
// type, and Enter in a field) is cancelled for any form that holds applicant
// controls, and a click on a submit-like control is cancelled once the page
// holds applicant data. A form with no applicant control cannot carry an
// application, so it may still submit: recrut.ai opens its form through
// exactly that (<form action="/itrtechgroup/job-apply/"> with one
// <button type="submit">Inscrever-se na vaga</button>, 2026-09-23).
//
// The lock lives on a heartbeat: every document re-reads `until`, which the
// driver pushes forward while it runs. When the driver ends (or dies), the
// lock expires within LOCK_TTL_MS and the human's own Submit works again.
//
// `submitApplication` is the explicit final step, called only after the
// pre-submit gate found nothing to block: it arms the lock for one click on
// the form's submit control and counts the application as sent only when the
// employer's confirmation shows.

const LOCK_TTL_MS = 45_000;
const HEARTBEAT_MS = 15_000;

/** In-page (every frame): install the lock once, then extend it by `ttl`. */
function lockInPage(ttl) {
  const w = window;
  if (!w.__hybLock) {
    const L = { until: 0, armed: false, blocked: [] };
    w.__hybLock = L;
    const applicantControls = (root) =>
      [...root.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), textarea, select')].filter(
        (el) => !/search|busca|pesquis/i.test(`${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.name || ''}`),
      );
    const hasApplicantData = (root) =>
      applicantControls(root).some((el) =>
        el.type === 'file' ? el.files && el.files.length > 0 : el.type === 'checkbox' || el.type === 'radio' ? el.checked : String(el.value || '').trim() !== '',
      );
    const locked = () => !L.armed && Date.now() < L.until;
    const note = (what) => L.blocked.push({ what, at: Date.now() });
    const guardsForm = (form) => locked() && form instanceof HTMLFormElement && applicantControls(form).length > 0;
    w.addEventListener(
      'submit',
      (e) => {
        if (!guardsForm(e.target)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        note('submit event');
      },
      true,
    );
    const proto = HTMLFormElement.prototype;
    const nativeSubmit = proto.submit;
    const nativeRequestSubmit = proto.requestSubmit;
    proto.submit = function submit() {
      if (guardsForm(this)) return void note('form.submit()');
      return nativeSubmit.call(this);
    };
    proto.requestSubmit = function requestSubmit(...args) {
      if (guardsForm(this)) return void note('form.requestSubmit()');
      return nativeRequestSubmit.apply(this, args);
    };
    const FINAL_RX = /^(submit|send|apply|enviar|finalizar|concluir|candidatar|postular|aplicar|bewerben|confirmar)\b|submit application|send application|enviar candidatura|finalizar candidatura/i;
    w.addEventListener(
      'click',
      (e) => {
        if (!locked()) return;
        const c = e.target && e.target.closest ? e.target.closest('button, input[type=submit], input[type=image], [role=button], a') : null;
        if (!c) return;
        const text = `${c.textContent || ''} ${c.value || ''} ${c.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim();
        const formSubmit = (c.type === 'submit' || c.type === 'image') && c.form && applicantControls(c.form).length > 0;
        if (!formSubmit && !(FINAL_RX.test(text) && hasApplicantData(document))) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        note(`click "${text.slice(0, 60)}"`);
      },
      true,
    );
  }
  w.__hybLock.until = Date.now() + ttl;
  return w.__hybLock.blocked.length;
}

function setArmedInPage(armed) {
  if (window.__hybLock) window.__hybLock.armed = armed;
}

function releaseInPage() {
  if (window.__hybLock) window.__hybLock.until = 0;
}

async function eachFrame(page, fn, arg) {
  const out = [];
  for (const f of page.frames()) out.push(await f.evaluate(fn, arg).catch(() => null));
  return out;
}

/**
 * Lock every submission in the tab while the driver runs. The init script
 * covers documents loaded later (navigation, new frames); the heartbeat keeps
 * the lock alive. `release()` lifts it at once.
 *
 * @returns {Promise<{release: () => Promise<void>, blocked: () => Promise<number>}>}
 */
export async function holdSubmitLock(page) {
  await page.addInitScript(lockInPage, LOCK_TTL_MS);
  await eachFrame(page, lockInPage, LOCK_TTL_MS);
  const timer = setInterval(() => {
    eachFrame(page, lockInPage, LOCK_TTL_MS).catch(() => {});
  }, HEARTBEAT_MS);
  timer.unref?.();
  return {
    async release() {
      clearInterval(timer);
      await eachFrame(page, releaseInPage);
    },
    async blocked() {
      return (await eachFrame(page, lockInPage, LOCK_TTL_MS)).reduce((n, x) => n + (x || 0), 0);
    },
  };
}

// In-page: the controls that would send this application. Tagged
// `data-hyb-submit` for one exact click.
function submitControlsInPage() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const applicantControls = (root) => root.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), textarea, select').length;
  const FINAL_RX = /^(submit|send|apply|enviar|finalizar|concluir|candidatar|postular|aplicar|bewerben|confirmar)\b|submit application|send application|enviar candidatura|finalizar candidatura/i;
  document.querySelectorAll('[data-hyb-submit]').forEach((n) => n.removeAttribute('data-hyb-submit'));
  const found = [];
  for (const c of document.querySelectorAll('button, input[type=submit], input[type=image], [role=button]')) {
    if (!vis(c) || c.disabled) continue;
    const text = `${c.textContent || ''} ${c.value || ''} ${c.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim();
    if (/^(attach|upload|anexar|carregar|remove|remover|cancel|cancelar|back|voltar|save|salvar)\b/i.test(text)) continue;
    const formSubmit = (c.type === 'submit' || c.type === 'image') && c.form && applicantControls(c.form) > 0;
    const finalText = FINAL_RX.test(text);
    if (!formSubmit && !finalText) continue;
    c.setAttribute('data-hyb-submit', String(found.length));
    found.push({ index: found.length, text: text.slice(0, 80), formSubmit, finalText });
  }
  return found;
}

/** The one control that submits this application, or why there is none. */
export function chooseSubmitControl(found) {
  if (!found.length) return { control: null, reason: 'no submit control on the form' };
  const both = found.filter((c) => c.formSubmit && c.finalText);
  if (both.length === 1) return { control: both[0], reason: null };
  if (found.length === 1) return { control: found[0], reason: null };
  const forms = found.filter((c) => c.formSubmit);
  if (forms.length === 1) return { control: forms[0], reason: null };
  return { control: null, reason: `ambiguous: ${found.length} submit-like controls (${found.map((c) => `"${c.text}"`).join(', ')})` };
}

// Confirmation and refusal wording. Counted only when it appears AFTER the
// click: postings often say "thank you for your interest" in their own text.
const CONFIRM_RX =
  /thank(s| you) for (applying|your application)|application (has been |was )?(submitted|received|sent)|(we('ve| have)|we) received your application|successfully (submitted|applied)|your application is (in|complete)|candidatura (foi )?(enviada|recebida|realizada|conclu[ií]da|registrada)|inscri[cç][aã]o (realizada|conclu[ií]da|enviada|efetuada|registrada)|obrigad[oa] por (se candidatar|sua candidatura)|recebemos (a )?sua candidatura/i;
const REFUSED_RX = /we limit submissions|already (applied|submitted)|you have already applied|j[aá] se candidatou|limite de candidaturas/i;

async function pageText(page) {
  const parts = await eachFrame(page, () => document.body?.innerText || '');
  return parts.filter(Boolean).join('\n');
}

/** First match of `rx` in `after` that `before` did not already contain. */
function newMatch(rx, before, after) {
  const g = new RegExp(rx.source, 'gi');
  for (const m of after.matchAll(g)) if (!before.toLowerCase().includes(m[0].toLowerCase())) return m[0];
  return null;
}

/**
 * The final step: arm the lock for one click on the form's submit control,
 * then wait for the employer's answer. `confirmed` only when the page shows a
 * confirmation; a refusal or a form that is still there leaves the tab for the
 * human with the reason.
 *
 * @returns {Promise<{status: 'confirmed'|'refused'|'unconfirmed'|'no-control', control?: string, evidence?: string, url?: string, reason?: string}>}
 */
export async function submitApplication(page, { timeoutMs = 30_000 } = {}) {
  let target = null;
  for (const frame of page.frames()) {
    const found = await frame.evaluate(submitControlsInPage).catch(() => []);
    if (!found.length) continue;
    const pick = chooseSubmitControl(found);
    if (!pick.control) return { status: 'no-control', reason: pick.reason };
    target = { frame, control: pick.control };
    break;
  }
  if (!target) return { status: 'no-control', reason: 'no submit control on the form' };
  const before = page.url();
  const beforeText = await pageText(page);
  await eachFrame(page, setArmedInPage, true);
  try {
    await target.frame.locator(`[data-hyb-submit="${target.control.index}"]`).first().click({ timeout: 10_000 });
    for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
      await new Promise((r) => setTimeout(r, 1000));
      const text = await pageText(page);
      const refused = newMatch(REFUSED_RX, beforeText, text);
      if (refused) return { status: 'refused', control: target.control.text, evidence: refused, url: page.url(), reason: `the employer refused the submission: "${refused}"` };
      const confirmed = newMatch(CONFIRM_RX, beforeText, text);
      if (confirmed) return { status: 'confirmed', control: target.control.text, evidence: confirmed, url: page.url() };
    }
    return { status: 'unconfirmed', control: target.control.text, url: page.url(), reason: `clicked "${target.control.text}" but no confirmation showed within ${timeoutMs / 1000} s${page.url() !== before ? ` (now at ${page.url()})` : ''}` };
  } finally {
    await eachFrame(page, setArmedInPage, false);
  }
}
