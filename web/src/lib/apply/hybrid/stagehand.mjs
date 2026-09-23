// stagehand.mjs — the one model call per form: Stagehand observe().
//
// Stagehand 4 (MIT) launches the local Chrome with its extension and a CDP
// port; Playwright connects to the same browser over that port for every
// deterministic action. Stagehand's model is a client-side `generate`
// callback backed by the locally authenticated `codex exec` (no provider key,
// account or service is added). Its action cache is not used: it returned
// DISABLED on local browsers in the 2026-09-22 measurement, so nothing here
// relies on a selector surviving between runs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Stagehand, localBrowser } from '@browserbasehq/stagehand';
import { chromium } from 'playwright-core';

const CODEX_TIMEOUT_MS = 180_000;

export const OBSERVE_INSTRUCTION =
  'Find every form control a job applicant fills in on this job application form: text inputs, text areas, ' +
  'dropdowns and comboboxes, radio buttons, checkboxes, yes/no buttons and file upload fields. Exclude search boxes, ' +
  'cookie banners, language pickers, navigation links and the final submit button.';

/** OpenAI-style strict structured output: every object closed and every
 *  property required (codex --output-schema rejects open objects). */
export function strictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const s = {};
  for (const [k, v] of Object.entries(schema)) s[k] = strictSchema(v);
  if (s.type === 'object' && s.properties) {
    s.additionalProperties = false;
    s.required = Object.keys(s.properties);
  }
  return s;
}

const blockText = (content) =>
  (Array.isArray(content) ? content : [content]).map((b) => (b?.type === 'text' ? b.text : typeof b === 'string' ? b : '')).join('\n');

/**
 * Stagehand client-LLM callback running one `codex exec` per inference, in an
 * empty temp directory (no repo AGENTS.md, read-only sandbox, no user config).
 * `onCall` receives `{ms, ok}` for the metrics.
 */
export function createCodexGenerate({ onCall = () => {}, bin = process.env.CODEX_BIN || 'codex' } = {}) {
  return async function generate(params) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-codex-'));
    const outFile = path.join(dir, 'out.json');
    const args = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-s', 'read-only', '-C', dir, '-o', outFile];
    const schema = params.responseFormat?.schema;
    if (schema) {
      fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(strictSchema(schema)));
      args.push('--output-schema', path.join(dir, 'schema.json'));
    }
    args.push('-');
    const prompt = [params.systemPrompt || '', ...(params.messages || []).map((m) => `${String(m.role).toUpperCase()}:\n${blockText(m.content)}`), 'Respond with only the JSON object.'].join('\n\n');
    const t0 = Date.now();
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`codex exec timed out after ${CODEX_TIMEOUT_MS} ms`));
        }, CODEX_TIMEOUT_MS);
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`codex exec exited ${code}: ${err.slice(-400)}`));
        });
        child.stdin.end(prompt);
      });
      const text = fs.readFileSync(outFile, 'utf8').trim();
      onCall({ ms: Date.now() - t0, ok: true });
      return { role: 'assistant', content: { type: 'text', text }, outputFormat: 'json_schema', structuredContent: JSON.parse(text) };
    } catch (e) {
      onCall({ ms: Date.now() - t0, ok: false });
      throw e;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

/** Launch Chrome through Stagehand and attach Playwright to the same browser. */
export async function launchBrowser({ headless = true } = {}) {
  const port = await freePort();
  const shBrowser = await localBrowser.launch({ port, headless, viewport: { width: 1280, height: 900 } });
  const pw = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = pw.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith('chrome-extension://')) || (await context.newPage());
  return { shBrowser, pw, page };
}

/**
 * ONE Stagehand observe() on the page at `pageUrl`, bounded by `timeoutMs`
 * (the 2026-09-22 lab saw Stagehand stall on recrut.ai; a stall ends here as
 * an error instead of eating the form's budget). The page is named
 * explicitly: Stagehand's default is the most recently opened tab, which is
 * not the form when the site opened another one (recrut.ai's privacy page).
 */
export async function observeOnce(shBrowser, generate, { pageUrl, timeoutMs = 150_000, instruction = OBSERVE_INSTRUCTION } = {}) {
  let timer;
  const t0 = Date.now();
  try {
    const work = (async () => {
      const stagehand = await Stagehand.create({ browser: shBrowser, model: { generate } });
      let page;
      for (const p of await shBrowser.context.pages()) {
        if ((await p.url()) === pageUrl) page = p;
      }
      if (!page) throw new Error(`Stagehand does not see the form page ${pageUrl}`);
      return stagehand.observe(instruction, { timeout: timeoutMs, page });
    })();
    const res = await Promise.race([work, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`observe exceeded ${timeoutMs} ms`)), timeoutMs + 5000)))]);
    return { ok: true, ms: Date.now() - t0, actions: res.data, cache: res.metadata?.cache?.status ?? null };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, actions: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Candidate selectors for one observed XPath: the path itself, then its
 *  suffixes as `//…`, longest first. Stagehand's XPaths are positional from
 *  the document root, so a node the page inserts near the top AFTER the
 *  snapshot (recrut.ai prepends a video-player sprite to <body>) shifts every
 *  index above the form. The form's own subtree keeps its positions, so the
 *  longest suffix that matches exactly ONE element is the same element. */
export function xpathCandidates(selector) {
  const m = /^xpath=(\/[^>]*)$/.exec(String(selector).trim());
  if (!m) return [selector];
  const steps = m[1].split('/').filter(Boolean);
  const out = [selector];
  for (let k = 1; k < steps.length - 2; k++) out.push(`xpath=//${steps.slice(k).join('/')}`);
  return out;
}

/** Map each observed action's selector to the scanned question it belongs to
 *  (the element itself, its question container, or a control inside it). A
 *  suffix candidate counts only when it matches exactly one element. Child
 *  frames are asked only when the selector already matches there (a waiting
 *  lookup in each of recrut.ai's nine iframes cost 54 s, 2026-09-22). */
export async function mapActionsToQuestions(page, actions) {
  const keyOf = (loc) =>
    loc
      .evaluate((el) => {
        const own = el.closest('[data-hyb-q]');
        if (own) return own.getAttribute('data-hyb-q');
        const inner = el.querySelector('[data-hyb-c], [data-hyb-q]');
        return inner ? inner.getAttribute('data-hyb-c') || inner.getAttribute('data-hyb-q') : null;
      }, null, { timeout: 1000 })
      .catch(() => null);
  const keys = new Set();
  const unmapped = [];
  for (const a of actions) {
    let key = null;
    const candidates = xpathCandidates(a.selector);
    for (const frame of page.frames()) {
      // Suffix candidates only in the main frame; a child frame gets the path as observed.
      const list = frame === page.mainFrame() ? candidates : candidates.slice(0, 1);
      for (const [i, sel] of list.entries()) {
        const n = await frame.locator(sel).count().catch(() => 0);
        if (n === 1 || (i === 0 && n > 0)) {
          key = await keyOf(frame.locator(sel).first());
          break;
        }
      }
      if (key) break;
    }
    if (key) keys.add(key);
    else unmapped.push(a.description);
  }
  return { keys, unmapped };
}
