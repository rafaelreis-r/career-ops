// round-keeper.mjs — launches the round's browser and keeps its Stagehand
// runtime loaded for as long as that browser lives.
//
// Stagehand installs its runtime extension through CDP `Extensions.loadUnpacked`,
// and Chrome disables an extension loaded that way when the CDP connection
// that loaded it closes. If the first form's process launched the browser, the
// runtime died with that process and every later form of the round timed out
// ("Stagehand initialization timed out"). This detached process owns that
// connection instead: it launches Chrome, records the round in the state file,
// and exits only when the browser is gone.
//
// Spawned by round.mjs:  node round-keeper.mjs <state-file> <port> <user-data-dir>

import fs from 'node:fs';
import path from 'node:path';
import { localBrowser } from '@browserbasehq/stagehand';
import { chromium } from 'playwright-core';

const [stateFile, portArg, userDataDir] = process.argv.slice(2);
const port = Number(portArg);
const cdpUrl = `http://127.0.0.1:${port}`;
const VIEWPORT = { width: 1280, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function write(state) {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, stateFile);
}

function priorAttempts() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')).submissionAttempts || [];
  } catch {
    return [];
  }
}

async function alive() {
  try {
    return (await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

try {
  // The launch's own CDP connection is the one that loaded the extension; this process keeps it open.
  await localBrowser.launch({ port, headless: false, viewport: VIEWPORT, keepAlive: true, userDataDir });
  const pw = await chromium.connectOverCDP(cdpUrl);
  const context = pw.contexts()[0];
  const worker =
    context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ||
    (await context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null));
  write({
    cdpUrl,
    extensionId: worker ? new URL(worker.url()).host : null,
    userDataDir,
    keeperPid: process.pid,
    startedAt: new Date().toISOString(),
    tabs: {},
    submissionAttempts: priorAttempts(),
  });
  while (await alive()) await sleep(5000);
  process.exit(0);
} catch (e) {
  write({ cdpUrl: null, error: e instanceof Error ? e.message : String(e), keeperPid: process.pid, tabs: {}, submissionAttempts: priorAttempts() });
  process.exit(1);
}
