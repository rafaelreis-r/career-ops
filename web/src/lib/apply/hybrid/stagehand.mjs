// stagehand.mjs — the model side of the hybrid filler, through Stagehand 4 (MIT).
//
// Stagehand's model is a client-side `generate` callback backed by the locally
// authenticated `codex exec` (no provider key, account or service is added).
// Its action cache is not used: it returned DISABLED on local browsers in the
// 2026-09-22 measurement, so nothing here relies on a selector surviving
// between runs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const CODEX_TIMEOUT_MS = 180_000;
export const LOCAL_TELEMETRY = Object.freeze({ traces: { endpoint: 'http://127.0.0.1:9/v1/traces', headers: {} } });

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

/** A stalled Stagehand call ends as an error after `ms`, never as a hang. */
async function bounded(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The model side of one form: a Stagehand instance bound to the form's tab.
 * `act()` is the fallback for a field the deterministic adapter could not fill or verify.
 * `close()` MUST run when the form is done: the round's browser holds one
 * Stagehand runtime, and a later form cannot start its own until this one is
 * released ("A Stagehand instance is already initialized"). It releases the
 * runtime only; the browser and the tab stay. The tab is named explicitly:
 * Stagehand's default is the most recently opened tab, which is not the form
 * when the site opened another one or when the round holds other forms.
 */
export async function createFormAgent(shBrowser, generate, pageUrl) {
  const { Stagehand } = await import('@browserbasehq/stagehand');
  const stagehand = await bounded(Stagehand.create({ browser: shBrowser, model: { generate }, telemetry: LOCAL_TELEMETRY }), 60_000, 'Stagehand.create');
  let page = null;
  for (const p of await shBrowser.context.pages()) {
    if ((await p.url()) === pageUrl) page = p;
  }
  if (!page) {
    await stagehand.close().catch(() => {});
    throw new Error(`Stagehand does not see the form tab ${pageUrl}`);
  }
  return {
    async act(instruction, { timeoutMs = 120_000 } = {}) {
      const t0 = Date.now();
      try {
        const res = await bounded(stagehand.act(instruction, { timeout: timeoutMs, page }), timeoutMs + 5000, 'act');
        return { ok: res.data?.success !== false, ms: Date.now() - t0, message: res.data?.message ?? null };
      } catch (e) {
        return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
      }
    },
    close: () => bounded(stagehand.close(), 15_000, 'Stagehand.close').catch(() => {}),
  };
}
