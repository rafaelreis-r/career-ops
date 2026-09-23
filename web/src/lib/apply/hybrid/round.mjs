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
// Each round gets a fresh Chrome profile, launched by a detached keeper
// process (round-keeper.mjs) that holds the CDP connection through which
// Stagehand loaded its runtime extension: Chrome disables that extension when
// the connection closes, so the browser must not belong to one form's process.
// Profiles of rounds whose Chrome is gone are deleted when the next round starts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
function writeState(s) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const target = stateFile();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  fs.renameSync(tmp, target);
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

/** Delete the profiles of earlier rounds whose Chrome is no longer running
 *  (Chrome's SingletonLock is a `<host>-<pid>` symlink while it runs). */
function pruneRoundProfiles(dir) {
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const profile = path.join(dir, name);
    let pid = null;
    try {
      pid = Number(/-(\d+)$/.exec(fs.readlinkSync(path.join(profile, 'SingletonLock')))?.[1]) || null;
    } catch {
      /* no lock: that Chrome has exited */
    }
    if (pid) {
      try {
        process.kill(pid, 0);
        continue;
      } catch {
        /* stale lock */
      }
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/** The Stagehand extension's service worker, woken through its own wake page
 *  when Chrome has put the idle MV3 worker to sleep. */
async function extensionWorker(context, extensionId = null) {
  const find = () => context.serviceWorkers().find((w) => w.url().startsWith(extensionId ? `chrome-extension://${extensionId}/` : 'chrome-extension://'));
  const w = find() || (await context.waitForEvent('serviceworker', { timeout: 3000 }).catch(() => null));
  if (!extensionId) return w || null;
  if (find()) return find();
  const wake = await context.newPage();
  await wake.goto(`chrome-extension://${extensionId}/wake-service-worker.html`).catch(() => {});
  await context.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null);
  await wake.close().catch(() => {});
  return find() || null;
}

const keeperAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Launch the round's browser through a detached keeper (round-keeper.mjs)
 *  and wait for it to record the round. Called under the lock. */
async function startRound() {
  const port = await freePort();
  const profiles = path.join(stateDir(), 'hybrid-round-profiles');
  pruneRoundProfiles(profiles);
  const userDataDir = path.join(profiles, new Date().toISOString().replace(/[:.]/g, '-'));
  const keeper = spawn(process.execPath, [fileURLToPath(new URL('./round-keeper.mjs', import.meta.url)), stateFile(), String(port), userDataDir], {
    detached: true,
    stdio: 'ignore',
  });
  keeper.unref();
  const end = Date.now() + 120_000;
  for (;;) {
    const st = readState();
    if (st?.keeperPid === keeper.pid && st.error) throw new Error(`the round browser did not start: ${st.error}`);
    if (st?.keeperPid === keeper.pid && st.cdpUrl) return st;
    if (Date.now() > end) throw new Error('the round browser did not start within 120 s');
    await sleep(300);
  }
}

const sameSubmission = (attempt, dataRoot, postingUrl, reportNumber) =>
  (postingUrl && attempt.postingUrl === postingUrl) ||
  (attempt.dataRoot === path.resolve(dataRoot) && reportNumber != null && attempt.reportNumber != null && Number(attempt.reportNumber) === Number(reportNumber));

export function submissionAttemptFor(dataRoot, postingUrl, reportNumber = null) {
  return (readState()?.submissionAttempts || []).find((attempt) => sameSubmission(attempt, dataRoot, postingUrl, reportNumber)) || null;
}

export async function claimSubmissionAttempt(dataRoot, postingUrl, reportNumber = null) {
  return withLock(async () => {
    const st = readState() || { tabs: {} };
    st.submissionAttempts ||= [];
    const existing = st.submissionAttempts.find((attempt) => sameSubmission(attempt, dataRoot, postingUrl, reportNumber));
    if (existing) return { claimed: false, attempt: existing };
    const attempt = { dataRoot: path.resolve(dataRoot), postingUrl, reportNumber: reportNumber == null ? null : Number(reportNumber), status: 'claimed', attemptedAt: new Date().toISOString() };
    st.submissionAttempts.push(attempt);
    writeState(st);
    return { claimed: true, attempt };
  });
}

export async function recordSubmissionResult(dataRoot, postingUrl, reportNumber, result) {
  return withLock(async () => {
    const st = readState() || { tabs: {} };
    st.submissionAttempts ||= [];
    const attempt = st.submissionAttempts.find((entry) => sameSubmission(entry, dataRoot, postingUrl, reportNumber));
    if (!attempt) return false;
    attempt.status = result.status;
    attempt.control = result.control ?? null;
    attempt.evidence = result.evidence ?? null;
    attempt.reason = result.reason ?? null;
    if (result.tracker !== undefined) attempt.tracker = result.tracker;
    attempt.updatedAt = new Date().toISOString();
    writeState(st);
    return true;
  });
}

/**
 * Join the round's browser (or start it) and open this form's tab. A posting
 * that already has a tab in the round (`postingUrl` as the tab's address, or
 * as the posting a settled tab was reached from) gets that tab back as it
 * stands, `reused: true`, so a second run fills its gaps instead of opening a
 * duplicate or reloading away what the human typed.
 * `shBrowser` is null when the round's Stagehand runtime is gone (its keeper
 * was killed while Chrome kept running): the form is then filled without the
 * model fallback, and `runtimeError` says why.
 * @returns {Promise<{shBrowser, pw, context, page, reused: boolean, shared: boolean, cdpUrl: string, runtimeError?: string}>}
 */
export async function openFormTab({ postingUrl = null } = {}) {
  return withLock(async () => {
    let st = readState();
    const fresh = !(st?.cdpUrl && (await alive(st.cdpUrl)));
    if (fresh) st = await startRound();
    const pw = await chromium.connectOverCDP(st.cdpUrl);
    const context = pw.contexts()[0];
    const known = new Set([postingUrl, ...Object.entries(st.tabs || {}).filter(([, t]) => t.postingUrl === postingUrl).map(([u]) => u)]);
    const existing = postingUrl ? context.pages().find((p) => known.has(p.url())) : null;
    const blank = fresh ? context.pages().find((p) => p.url() === 'about:blank') : null;
    const page = existing || blank || (await context.newPage());
    let shBrowser = null;
    let runtimeError;
    if (!st.extensionId || !keeperAlive(st.keeperPid)) {
      runtimeError = `the round's Stagehand runtime is gone (keeper ${st.keeperPid ?? 'unknown'} not running); close the round browser to start a new round`;
    } else {
      shBrowser = await localBrowser.connect({ cdpUrl: st.cdpUrl, extensionId: st.extensionId }).catch((e) => {
        runtimeError = e instanceof Error ? e.message : String(e);
        return null;
      });
    }
    return { shBrowser, pw, context, page, reused: !!existing, shared: true, cdpUrl: st.cdpUrl, runtimeError };
  });
}

export async function rememberFormTab(round, postingUrl, note = null) {
  if (!round?.page || round.page.isClosed()) return false;
  return withLock(async () => {
    const st = readState() || { tabs: {} };
    st.tabs ||= {};
    const url = round.page.url();
    for (const [knownUrl, tab] of Object.entries(st.tabs)) {
      if (knownUrl !== url && tab.postingUrl === postingUrl) delete st.tabs[knownUrl];
    }
    st.tabs[url] = { status: 'unknown', pending: [], ...st.tabs[url], postingUrl, note, updatedAt: new Date().toISOString() };
    writeState(st);
    return true;
  });
}

/**
 * Release a Stagehand runtime that an earlier form left initialized (a run
 * killed before `close()`): stop the extension's service worker, whose
 * in-memory runtime starts idle again on the next wake, then reconnect. The
 * extension is not reloaded: Chrome would disable it, since the keeper's
 * connection loaded it. The tabs are untouched.
 */
export async function resetStagehandRuntime(round) {
  const { extensionId } = readState() || {};
  const cdp = await round.pw.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const t of targetInfos) {
      if (t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`)) await cdp.send('Target.closeTarget', { targetId: t.targetId });
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
  await sleep(500);
  await extensionWorker(round.context, extensionId);
  round.shBrowser = await localBrowser.connect({ cdpUrl: round.cdpUrl, extensionId });
  return round.shBrowser;
}

/**
 * Record this form's standing and put the round's tabs in order. Returns the
 * tabs as they stand, in their new order, with what each one still needs.
 * @param {{status: string, pending: string[]}|null} standing - null closes the tab (no form on the page).
 */
export async function settleFormTab(round, standing, { url = round.page.url(), postingUrl = null, note = null } = {}) {
  return withLock(async () => {
    const st = readState() || { tabs: {} };
    st.tabs ||= {};
    if (standing) st.tabs[url] = { ...standing, postingUrl, note, updatedAt: new Date().toISOString() };
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
