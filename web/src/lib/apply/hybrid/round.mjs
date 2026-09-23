// round.mjs — ONE browser for the whole apply round; every form is a tab of it.
//
// The first form of a round launches Chrome through Stagehand (visible, a
// persistent profile, kept alive after the script exits) and records its CDP
// endpoint; every later form, from any process, connects to that same browser
// and opens a new tab. No tab is closed when a form ends: what is not finished
// stays as filled as the driver could get it, for the human to finish. The only
// tab closed is a posting with no application form (closed or removed ad).
//
// After each form the round's tabs are re-ordered: forms that only need the
// human first (ready, or ready but for the captcha), then incomplete ones from
// fewest to most pending items. Chrome's CDP cannot move tabs; the Stagehand
// extension already loaded in the browser holds the `tabs` permission, so the
// move runs through `chrome.tabs.move` in its service worker.
//
// `--headless` runs (tests, CI) get a private browser that is closed at the end.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { localBrowser } from '@browserbasehq/stagehand';
import { chromium } from 'playwright-core';
import { orderTabs } from './gate.mjs';

const VIEWPORT = { width: 1280, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  return process.env.CAREER_OPS_HYBRID_STATE_DIR || path.join(os.homedir(), '.cache', 'career-ops');
}
const stateFile = () => path.join(stateDir(), 'hybrid-round.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
}
function writeState(s) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(stateFile(), `${JSON.stringify(s, null, 2)}\n`);
}

/** Serialize launch and state updates across concurrent processes. */
async function withLock(fn) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const lock = path.join(stateDir(), 'hybrid-round.lock');
  const end = Date.now() + 90_000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) fs.rmSync(lock, { force: true });
      } catch {
        /* lock vanished between the two calls */
      }
      if (Date.now() > end) throw new Error(`timed out waiting for ${lock}`);
      await sleep(200);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
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

async function alive(cdpUrl) {
  try {
    const r = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

const isFormTab = (url) => !/^(chrome-extension|chrome|devtools|about):/.test(url);

/** The Stagehand extension's service worker, woken through its own wake page
 *  when Chrome has put the idle MV3 worker to sleep. */
async function extensionWorker(context, extensionId = null) {
  const find = () => context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://') && w.url().includes('service-worker'));
  const w = find() || (await context.waitForEvent('serviceworker', { timeout: 3000 }).catch(() => null));
  if (w || !extensionId) return w || find() || null;
  const wake = await context.newPage();
  await wake.goto(`chrome-extension://${extensionId}/wake-service-worker.html`).catch(() => {});
  const woken = find() || (await context.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null));
  await wake.close().catch(() => {});
  return woken || find() || null;
}

/**
 * Join the round's browser (or start it) and open this form's tab.
 * @returns {Promise<{shBrowser, pw, context, page, shared: boolean, cdpUrl: string}>}
 */
export async function openFormTab({ headless = false } = {}) {
  if (headless) {
    const port = await freePort();
    const shBrowser = await localBrowser.launch({ port, headless: true, viewport: VIEWPORT });
    const pw = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = pw.contexts()[0];
    const page = context.pages().find((p) => isFormTab(p.url()) || p.url() === 'about:blank') || (await context.newPage());
    return { shBrowser, pw, context, page, shared: false, cdpUrl: `http://127.0.0.1:${port}` };
  }
  return withLock(async () => {
    const st = readState();
    if (st?.cdpUrl && (await alive(st.cdpUrl))) {
      const shBrowser = await localBrowser.connect({ cdpUrl: st.cdpUrl, ...(st.extensionId ? { extensionId: st.extensionId } : {}) });
      const pw = await chromium.connectOverCDP(st.cdpUrl);
      const context = pw.contexts()[0];
      const page = await context.newPage();
      return { shBrowser, pw, context, page, shared: true, cdpUrl: st.cdpUrl };
    }
    const port = await freePort();
    const cdpUrl = `http://127.0.0.1:${port}`;
    const shBrowser = await localBrowser.launch({
      port,
      headless: false,
      viewport: VIEWPORT,
      keepAlive: true,
      userDataDir: path.join(stateDir(), 'hybrid-round-profile'),
    });
    const pw = await chromium.connectOverCDP(cdpUrl);
    const context = pw.contexts()[0];
    const worker = await extensionWorker(context);
    writeState({ cdpUrl, extensionId: worker ? new URL(worker.url()).host : null, startedAt: new Date().toISOString(), tabs: {} });
    const page = context.pages().find((p) => p.url() === 'about:blank') || (await context.newPage());
    return { shBrowser, pw, context, page, shared: true, cdpUrl };
  });
}

/**
 * Release a Stagehand runtime that an earlier form left initialized (a run
 * that crashed before `close()`): reload the extension, then reconnect. The
 * tabs are untouched; only the extension's worker restarts.
 */
export async function resetStagehandRuntime(round) {
  const st = readState();
  const worker = await extensionWorker(round.context, st?.extensionId);
  await worker?.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await sleep(2000);
  round.shBrowser = await localBrowser.connect({ cdpUrl: round.cdpUrl, ...(st?.extensionId ? { extensionId: st.extensionId } : {}) });
  return round.shBrowser;
}

/**
 * Record this form's standing and put the round's tabs in order. Returns the
 * tabs as they stand, in their new order, with what each one still needs.
 * @param {{status: string, pending: string[]}|null} standing - null closes the tab (no form on the page).
 */
export async function settleFormTab(round, standing, { url = round.page.url(), note = null } = {}) {
  if (!round.shared) {
    await round.shBrowser.close().catch(() => {});
    return { tabs: [], closedThisTab: true };
  }
  return withLock(async () => {
    const st = readState() || { tabs: {} };
    st.tabs ||= {};
    if (standing) st.tabs[url] = { ...standing, note, updatedAt: new Date().toISOString() };
    else {
      delete st.tabs[url];
      await round.page.close().catch(() => {});
    }
    const pages = round.context.pages().filter((p) => !p.isClosed() && isFormTab(p.url()));
    const openUrls = new Set(pages.map((p) => p.url()));
    for (const u of Object.keys(st.tabs)) if (!openUrls.has(u)) delete st.tabs[u]; // closed by the human
    const tabs = pages.map((p) => ({ url: p.url(), ...(st.tabs[p.url()] || { status: 'unknown', pending: [] }) }));
    const ordered = orderTabs(tabs);
    const worker = await extensionWorker(round.context, st.extensionId);
    let arranged = false;
    if (worker) {
      arranged = await worker
        .evaluate(async (urls) => {
          const all = await chrome.tabs.query({});
          const byUrl = new Map(all.map((t) => [t.url, t]));
          const ids = urls.map((u) => byUrl.get(u)?.id).filter((id) => id != null);
          const first = Math.min(...all.filter((t) => ids.includes(t.id)).map((t) => t.index));
          for (const [i, id] of ids.entries()) await chrome.tabs.move(id, { index: first + i });
          return true;
        }, ordered.map((t) => t.url))
        .catch(() => false);
    }
    writeState(st);
    return { tabs: ordered, arranged, closedThisTab: !standing };
  });
}
