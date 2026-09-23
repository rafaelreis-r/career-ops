// page-scan.mjs — deterministic DOM inventory for the hybrid apply driver.
//
// `scanQuestionsInPage` runs INSIDE the page (Playwright `frame.evaluate`), so it
// must stay self-contained: no imports, no closures over module scope. It groups
// every form control into a "question" (a text input, a radio group, a checkbox
// group, a custom combobox, a file input, ...) and reads, straight from the DOM:
//   - the question label as the page shows it (asterisk kept),
//   - whether the page marks it required, and on what evidence,
//   - its current state (typed value, selected option, checked boxes, files).
// It tags each question container `data-hyb-q`, each control `data-hyb-c`, and
// each option `data-hyb-o`, so the adapters act on exactly the scanned element.
// Keys are reused across rescans, so a question keeps its key after a fill.
//
// Required is read per QUESTION, not per <input>: a checkbox group whose label
// carries the asterisk outside every input (applytojob) or whose <fieldset> has
// aria-required (Greenhouse) is required even though no input has `required`.
// That is the check the old verifier missed (Storyteller, 2026-09-22).

/** @returns {{questions: object[], captcha: object, url: string}} */
export function scanQuestionsInPage() {
  const MAX_UP = 7;
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isChoiceInput = (el) => el.matches('input[type=checkbox], input[type=radio], [role=checkbox], [role=radio]');
  const isTextLike = (el) =>
    el.matches('textarea, select, [role=combobox], [contenteditable=true]') ||
    (el.tagName === 'INPUT' && !/^(checkbox|radio|file|hidden|submit|button|reset|image|range|color)$/i.test(el.type || 'text'));
  // Text of an element minus nested form controls, listboxes and scripts.
  const ownText = (el) => {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('input, select, textarea, option, svg, script, style, [role=listbox], [role=option]').forEach((n) => n.remove());
    return norm(clone.textContent);
  };
  const byIds = (ids) => norm((ids || '').split(/\s+/).filter(Boolean).map((id) => ownText(document.getElementById(id))).join(' '));
  const pseudoStar = (el) => {
    for (const p of ['::after', '::before']) {
      if (/\*/.test(getComputedStyle(el, p).content || '')) return true;
    }
    return false;
  };
  const labelMarksRequired = (labelEl, text) => {
    if (/\*\s*$/.test(text) || /^\s*\*/.test(text)) return 'asterisk';
    if (/\((required|obrigat[óo]rio)\)/i.test(text)) return 'required-text';
    if (!labelEl) return null;
    if (labelEl.querySelector('.asterisk, .required, [class*=required], abbr[title*=required i]')) return 'asterisk-element';
    if (typeof labelEl.className === 'string' && /required/i.test(labelEl.className)) return 'label-class';
    if (pseudoStar(labelEl)) return 'css-asterisk';
    return null;
  };
  const labelForId = (id) => (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null);
  // A <label> is an OPTION label when it names a checkbox/radio (for= or wrapping).
  const isOptionLabel = (lab) => {
    if (lab.querySelector('input[type=checkbox], input[type=radio]')) return true;
    const f = lab.getAttribute('for');
    const t = f ? document.getElementById(f) : null;
    return !!(t && isChoiceInput(t));
  };
  const optionText = (el) => {
    const lab = labelForId(el.id) || el.closest('label');
    const t = lab ? ownText(lab) : '';
    return norm(t || el.getAttribute('aria-label') || byIds(el.getAttribute('aria-labelledby')) || el.value || '');
  };
  // Resolve the question an element belongs to: the nearest ancestor that owns
  // a question label and holds no control of another question. Explicit
  // grouping (role=group + aria-labelledby, fieldset + legend) wins over the
  // nearest label-looking node. `ownLabel` (the input's own label, e.g. a
  // visually-hidden "Attach") is never the question label.
  const questionContainer = (el, sameGroup, ownLabel = null) => {
    const chain = [];
    let a = el.parentElement;
    for (let i = 0; a && i < MAX_UP && a !== document.body; i++, a = a.parentElement) {
      const foreign = [...a.querySelectorAll('input:not([type=hidden]), select, textarea, [role=combobox]')].some(
        (c) => c !== el && !sameGroup(c) && visible(c) && c.getAttribute('aria-hidden') !== 'true',
      );
      if (foreign) break;
      chain.push(a);
    }
    for (const c of chain) {
      if (c.matches('[role=group][aria-labelledby], [role=radiogroup][aria-labelledby]')) {
        const l = document.getElementById(c.getAttribute('aria-labelledby').split(/\s+/)[0]);
        if (l && ownText(l)) return { container: c, labelEl: l };
      }
      if (c.tagName === 'FIELDSET') {
        const lg = c.querySelector(':scope > legend');
        if (lg && ownText(lg)) return { container: c, labelEl: lg };
      }
    }
    // A label bound (for=) to another existing control belongs to that control;
    // one bound to a hidden input or to nothing is a question label.
    const boundElsewhere = (l) => {
      const f = l.tagName === 'LABEL' && l.getAttribute('for');
      const t = f ? document.getElementById(f) : null;
      return !!(t && t !== el && !sameGroup(t) && !t.matches('input[type=hidden]'));
    };
    for (const c of chain) {
      const labels = [...c.querySelectorAll('label, legend, [id$=-label], [class*=label], [class*=question], [class*=heading], [class*=title], h3, h4, p')].filter(
        (l) => l !== ownLabel && !boundElsewhere(l) && !isOptionLabel(l) && !l.closest('[role=listbox]') && !l.querySelector('input, select, textarea') && ownText(l),
      );
      if (labels.length) return { container: c, labelEl: labels[0] };
    }
    return null;
  };

  const seen = new Set();
  const questions = [];
  // Keys are unique across the frames of a page: the top document uses q0,
  // q1...; a subframe prefixes its own random id, kept on its root element so
  // it survives rescans (two frames once both tagged a "q0").
  const root = document.documentElement;
  if (window !== window.top && !root.getAttribute('data-hyb-frame')) root.setAttribute('data-hyb-frame', Math.random().toString(36).slice(2, 8));
  const prefix = window === window.top ? 'q' : `f${root.getAttribute('data-hyb-frame')}q`;
  let nextKey = 0;
  for (const el of document.querySelectorAll('[data-hyb-q]')) {
    const k = String(el.getAttribute('data-hyb-q'));
    const n = k.startsWith(prefix) ? Number(k.slice(prefix.length)) : NaN;
    if (Number.isFinite(n) && n >= nextKey) nextKey = n + 1;
  }
  const keyFor = (host) => {
    let k = host.getAttribute('data-hyb-q');
    if (!k) {
      k = `${prefix}${nextKey++}`;
      host.setAttribute('data-hyb-q', k);
    }
    return k;
  };

  const candidates = document.querySelectorAll(
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea, [role=combobox], [role=radio], [role=checkbox], [contenteditable=true]',
  );
  for (const el of candidates) {
    if (seen.has(el)) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const name = el.getAttribute('name') || '';
    // Mirrors and machinery: react-select's hidden required input, captcha
    // response fields, media sliders, and anything inside an open listbox.
    if (el.getAttribute('aria-hidden') === 'true' && type !== 'checkbox' && type !== 'radio' && type !== 'file') continue;
    if (/g-recaptcha-response|h-captcha-response|cf-turnstile-response/.test(name + el.id)) continue;
    if (/^(range|color)$/.test(type)) continue;
    if (el.closest('[role=listbox]') && el.getAttribute('role') !== 'combobox') continue;

    if (type === 'file') {
      seen.add(el);
      const labelEl = labelForId(el.id);
      const qc = questionContainer(el, (c) => c === el, labelEl);
      const container = qc?.container || el.parentElement;
      const ownLabel = norm(labelEl ? ownText(labelEl) : el.getAttribute('aria-label') || '');
      const qLabel = qc ? ownText(qc.labelEl) : '';
      // A generic button caption ("Attach", "Upload") says nothing about the
      // input's purpose; a real own label ("Resume*", "Currículo*") does.
      const genericOwn = !ownLabel || /^(attach|upload|browse|choose( a)? file|select file|anexar|enviar|carregar|selecionar)\b/i.test(ownLabel);
      const label = genericOwn ? qLabel || ownLabel : ownLabel;
      const labelNode = genericOwn ? qc?.labelEl || labelEl : labelEl;
      // Context: the nearest text around the input (autofill panes, "Accepted
      // file types", headings) — evidence for what this input is for.
      let ctxEl = el.parentElement;
      for (let i = 0; ctxEl && i < 4 && ownText(ctxEl).length < 12; i++) ctxEl = ctxEl.parentElement;
      const key = keyFor(container);
      el.setAttribute('data-hyb-c', key);
      const groupReq = container.getAttribute('aria-required') === 'true';
      const reqBy = el.required || el.getAttribute('aria-required') === 'true' || groupReq ? 'attribute' : labelMarksRequired(labelNode, label);
      // Remember the question on its container: Greenhouse removes the <input>
      // once it has uploaded the file and shows only the filename.
      container.setAttribute('data-hyb-kind', 'file');
      container.setAttribute('data-hyb-label', label);
      container.setAttribute('data-hyb-required', reqBy || '');
      questions.push({
        key, kind: 'file', label, ownLabel, id: el.id || null, name: name || null,
        accept: el.getAttribute('accept') || '', context: ownText(ctxEl).slice(0, 400),
        required: !!reqBy, requiredBy: reqBy || null, visible: visible(container),
        state: { files: [...(el.files || [])].map((f) => f.name), text: norm(container.textContent).slice(0, 600) },
      });
      continue;
    }

    if (isChoiceInput(el)) {
      // Group: radios/checkboxes sharing a name, else every choice input in the
      // question container (applytojob names each checkbox differently).
      const isRadio = el.matches('input[type=radio], [role=radio]');
      let group = name ? [...document.querySelectorAll(`input[name="${CSS.escape(name)}"]`)].filter(isChoiceInput) : [];
      let qc = questionContainer(el, (c) => group.includes(c) || isChoiceInput(c));
      if (group.length <= 1 && qc) group = [...qc.container.querySelectorAll('input[type=checkbox], input[type=radio], [role=checkbox], [role=radio]')];
      if (!group.length) group = [el];
      group.forEach((g) => seen.add(g));
      const container = qc?.container || el.parentElement;
      const key = keyFor(container);
      const qLabelEl = qc?.labelEl || null;
      const qLabel = qLabelEl ? ownText(qLabelEl) : '';
      const optional = /\((optional|opcional)\)/i.test(qLabel) || container.getAttribute('aria-required') === 'false';
      const groupReq = container.getAttribute('aria-required') === 'true' || group.some((g) => g.required || g.getAttribute('aria-required') === 'true');
      const reqBy = optional ? null : groupReq ? 'attribute' : labelMarksRequired(qLabelEl, qLabel);
      // Ashby-style yes/no: pressable buttons drive a hidden checkbox.
      const toggles = [...container.querySelectorAll('button[aria-pressed]')];
      if (toggles.length >= 2) {
        toggles.forEach((b, i) => b.setAttribute('data-hyb-o', `${key}:${i}`));
        questions.push({
          key, kind: 'toggle', label: qLabel, required: !!reqBy, requiredBy: reqBy || null, visible: visible(container),
          options: toggles.map((b) => norm(b.textContent)),
          state: { selected: toggles.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => norm(b.textContent)) },
        });
        continue;
      }
      group.forEach((g, i) => {
        g.setAttribute('data-hyb-o', `${key}:${i}`);
        g.setAttribute('data-hyb-c', key);
      });
      const checked = (g) => (g.matches('[role=checkbox], [role=radio]') ? g.getAttribute('aria-checked') === 'true' : g.checked === true);
      const kind = isRadio ? 'radio' : group.length > 1 ? 'checkbox-group' : 'checkbox';
      const opts = group.map(optionText);
      questions.push({
        key, kind, label: kind === 'checkbox' && !qLabel ? opts[0] : qLabel, required: !!reqBy, requiredBy: reqBy || null,
        visible: visible(container) || group.some(visible), options: opts,
        state: { selected: group.filter(checked).map(optionText) },
      });
      continue;
    }

    if (!isTextLike(el) || !visible(el)) continue;
    seen.add(el);
    const lab = labelForId(el.id);
    let labelEl = lab || (el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby').split(/\s+/)[0]) : null);
    let label = (lab ? ownText(lab) : '') || byIds(el.getAttribute('aria-labelledby')) || norm(el.getAttribute('aria-label'));
    const qc = questionContainer(el, (c) => c === el || !visible(c), lab);
    if (!label && el.closest('label')) {
      labelEl = el.closest('label');
      label = ownText(labelEl);
    }
    if ((!label || label === norm(el.getAttribute('placeholder'))) && qc) {
      labelEl = qc.labelEl;
      label = ownText(qc.labelEl);
    }
    if (!label) label = norm(el.getAttribute('placeholder') || el.getAttribute('name') || '');
    if (/leave this field (blank|empty)|deixe este campo em branco/i.test(label)) continue; // honeypot
    const container = qc?.container || el.parentElement;
    const key = keyFor(container);
    el.setAttribute('data-hyb-c', key);
    const optional = /\((optional|opcional)\)/i.test(label);
    const reqBy = optional ? null : el.required || el.getAttribute('aria-required') === 'true' ? 'attribute' : labelMarksRequired(labelEl, label);
    const tag = el.tagName.toLowerCase();
    const q = { key, label, required: !!reqBy, requiredBy: reqBy || null, visible: true, placeholder: el.getAttribute('placeholder') || null };
    if (tag === 'select') {
      const opts = [...el.options];
      opts.forEach((o, i) => o.setAttribute('data-hyb-o', `${key}:${i}`));
      const sel = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      const placeholderSel = !sel || !sel.value || (el.selectedIndex === 0 && /^(select|selecione|choose|escolha|--)/i.test(norm(sel.textContent)));
      questions.push({ ...q, kind: 'select', options: opts.map((o) => norm(o.textContent)), state: { selected: placeholderSel ? [] : [norm(sel.textContent)] } });
    } else if (el.getAttribute('role') === 'combobox') {
      // react-select shows the chosen option in a single-value node; its input
      // value is only the search text, never the selection.
      const shell = el.closest('[class*=select__container]') || el.closest('[class*=select-shell]') || container;
      const reactSelect = /select__input/.test(String(el.className)) || !!shell.querySelector('[class*=select__control]');
      const chips = [...shell.querySelectorAll('[class*=single-value], [class*=singleValue], [class*=multi-value__label]')].map((n) => norm(n.textContent)).filter(Boolean);
      const typed = norm(el.value);
      const selected = chips.length ? chips : !reactSelect && typed && el.getAttribute('aria-expanded') !== 'true' ? [typed] : [];
      questions.push({ ...q, kind: 'combobox', reactSelect, options: null, state: { selected, typed } });
    } else {
      const value = norm(el.isContentEditable ? el.textContent : el.value);
      questions.push({ ...q, kind: tag === 'textarea' || el.isContentEditable ? 'textarea' : 'text', inputType: el.type || tag, state: { value } });
    }
  }

  // A file question whose input the ATS consumed stays a question: its state
  // is whatever the container now shows (typically the uploaded filename).
  const emitted = new Set(questions.map((q) => q.key));
  for (const c of document.querySelectorAll('[data-hyb-kind=file]')) {
    const key = c.getAttribute('data-hyb-q');
    if (!key || emitted.has(key)) continue;
    const reqBy = c.getAttribute('data-hyb-required') || null;
    questions.push({
      key, kind: 'file', label: c.getAttribute('data-hyb-label') || '', ownLabel: '', id: null, name: null, accept: '', context: '',
      required: !!reqBy, requiredBy: reqBy, visible: visible(c), consumed: true,
      state: { files: [], text: norm(c.textContent).slice(0, 600) },
    });
  }

  const frames = [...document.querySelectorAll('iframe')];
  const captchaFrames = frames.filter((f) => /recaptcha|hcaptcha|turnstile|challenges\.cloudflare/i.test(`${f.src} ${f.title}`));
  const nativeInvalid = [...document.querySelectorAll('input[data-hyb-c], select[data-hyb-c], textarea[data-hyb-c]')]
    .filter((control) => control.willValidate && !control.checkValidity())
    .map((control) => ({
      key: control.getAttribute('data-hyb-c'),
      label: questions.find((question) => question.key === control.getAttribute('data-hyb-c'))?.label || control.name || control.id || control.tagName,
      message: control.validationMessage || 'invalid value',
    }));
  return {
    url: location.href,
    questions,
    nativeInvalid,
    captcha: {
      present: captchaFrames.length > 0 || !!document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, textarea[name=g-recaptcha-response]'),
      visibleWidgets: captchaFrames.filter(visible).map((f) => f.title || f.src.slice(0, 80)),
    },
  };
}

const CAPTCHA_FRAME_RX = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha/i;

/** Run the scan in every frame that can hold form fields. A captcha frame is
 *  only recorded, never scanned: its checkbox is the human's. It is recognised
 *  by the frame's URL, its <iframe> element (title/src/name: a cross-origin
 *  frame reached over CDP can report an empty URL, as recrut.ai's reCAPTCHA did
 *  on 2026-09-22) or its own document title. Each question carries `frame` (an
 *  index into `frameObjs`) so the adapters act in the frame it lives in. */
export async function scanPage(page) {
  const out = { url: page.url(), questions: [], captcha: { present: false, visibleWidgets: [] }, frameObjs: [], frameErrors: [], nativeInvalid: [] };
  for (const f of page.frames()) {
    let tag = f.url();
    if (f !== page.mainFrame()) {
      const el = await f.frameElement().catch(() => null);
      tag += ` ${(await el?.evaluate((e) => `${e.getAttribute('title') || ''} ${e.getAttribute('src') || ''} ${e.getAttribute('name') || ''}`).catch(() => '')) || ''}`;
      tag += ` ${await f.title().catch(() => '')}`;
    }
    if (CAPTCHA_FRAME_RX.test(tag)) {
      out.captcha.present = true;
      continue;
    }
    let res;
    try {
      res = await f.evaluate(scanQuestionsInPage);
    } catch (e) {
      out.frameErrors.push({ url: f.url(), reason: e instanceof Error ? e.message.split('\n')[0] : String(e) });
      continue;
    }
    const idx = out.frameObjs.push(f) - 1;
    if (res.captcha.present) out.captcha.present = true;
    out.captcha.visibleWidgets.push(...res.captcha.visibleWidgets);
    out.nativeInvalid.push(...(res.nativeInvalid || []).map((invalid) => ({ ...invalid, frame: idx })));
    for (const q of res.questions) out.questions.push({ ...q, frame: idx });
  }
  return out;
}
