// @ts-check
// Jobs Search (jobs.bridglabs.com) credential store for providers/jobs-search.mjs.
//
// The MCP server at https://mcp.jobs.bridglabs.com/mcp needs an OAuth bearer
// token from https://conta.jobs.bridglabs.com. That authorization server only
// accepts clients identified by a Client ID Metadata Document it trusts (no
// dynamic registration), and the one it accepts is Codex's
// (https://chatgpt.com/oauth/codex/client.json). So the first grant comes from
// `codex mcp add jobs-search --url https://mcp.jobs.bridglabs.com/mcp` (or
// `codex mcp login jobs-search`), which stores it in the macOS Keychain.
//
// This module keeps the provider's OWN copy of that grant in a credential file
// (mode 0600, outside any repo) and renews the access token with the
// refresh_token grant through the MCP SDK, so a scan does not need Codex:
//
//   node providers/_jobs-search-auth.mjs seed-from-codex   # once, copies the Keychain grant
//   node providers/_jobs-search-auth.mjs status            # expiry, never the token
//   node providers/_jobs-search-auth.mjs refresh           # renew now
//
// Credential file: $CAREER_OPS_JOBS_SEARCH_CREDENTIALS, else
// $XDG_CONFIG_HOME/career-ops/jobs-search/credentials.json (default
// ~/.config/…). A portals.yml entry may point elsewhere with
// `jobs_search.credentials_file`.
//
// Codex dependency, verified live on 2026-09-28: the refresh_token grant from
// this file works without Codex (client_id = Codex's metadata URL, no secret),
// access tokens last 15 minutes, and renewal ROTATES the refresh token — the
// pre-renewal refresh token was then refused with `invalid_grant`. So after
// seeding, Codex is needed only to re-login:
//   - The provider's first renewal spends the refresh token Codex also holds.
//     Codex's own `jobs-search` login is dead from then on: before using that
//     MCP server from Codex again, run `codex mcp login jobs-search`.
//   - Each renewal writes the new refresh token to the file before the access
//     token is used, so the file is the one live copy. Never keep two copies
//     (another machine, a restored backup, a second seed over a renewed
//     file): the older copy holds a spent token. `seed-from-codex` therefore
//     refuses to overwrite an existing file without --force.
//   - If the file's refresh token is rejected (revoked grant, spent token),
//     scans fail with a named error until `codex mcp login jobs-search` +
//     `seed-from-codex --force` re-seed it.
//
// Tokens never reach stdout, logs, errors, or fixtures: every message below
// names the file and the failure, not the credential.

import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { discoverAuthorizationServerMetadata, refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { isMainModule } from '../lib/is-main-module.mjs';

export const DEFAULT_ENDPOINT = 'https://mcp.jobs.bridglabs.com/mcp';
export const AUTH_SERVER = 'https://conta.jobs.bridglabs.com';
export const CODEX_CLIENT_ID = 'https://chatgpt.com/oauth/codex/client.json';
export const CODEX_KEYCHAIN_SERVICE = 'Codex MCP Credentials';
export const CODEX_SERVER_NAME = 'jobs-search';
// Renew this long before the recorded expiry. Tokens are re-checked before
// every tool call, so a pull longer than the 15-minute token life renews
// between pages.
export const EXPIRY_SKEW_MS = 5 * 60_000;

/**
 * `~/x` → `$HOME/x`, then absolute. portals.yml and env values are typed by
 * hand, and path.resolve alone would read `~` as a directory name.
 * @param {string} p
 */
export function resolveUserPath(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return path.resolve(p);
}

/** @param {NodeJS.ProcessEnv} [env] */
export function defaultCredentialsPath(env = process.env) {
  const explicit = env.CAREER_OPS_JOBS_SEARCH_CREDENTIALS?.trim();
  if (explicit) return resolveUserPath(explicit);
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config');
  return path.join(configHome, 'career-ops', 'jobs-search', 'credentials.json');
}

/**
 * The Keychain account Codex files an HTTP MCP server's OAuth grant under:
 * `{server name}|` + the first 16 hex chars of sha256 over the server's
 * transport config serialized as Codex does. Checked against the live record
 * for `jobs-search` on 2026-09-28 (`jobs-search|a37461d2ddee6282`).
 * @param {string} serverName
 * @param {string} url
 */
export function codexKeychainAccount(serverName, url) {
  const payload = JSON.stringify({ type: 'http', url, headers: {} });
  return `${serverName}|${createHash('sha256').update(payload).digest('hex').slice(0, 16)}`;
}

/**
 * Codex stores `expires_at` in epoch milliseconds; tolerate seconds too, since
 * a seconds value read as ms would look expired in 1970 and force a renewal
 * rather than use a stale token.
 * @param {unknown} v
 */
function toEpochMs(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1e12 ? v * 1000 : v;
}

/**
 * Validate and normalize a credential object (ours, or Codex's Keychain JSON)
 * into the file shape. Throws naming the missing field, never a value.
 * @param {any} raw
 * @param {string} origin label for error messages
 */
export function normalizeCredentials(raw, origin) {
  if (!raw || typeof raw !== 'object') throw new Error(`jobs-search: ${origin} is not a JSON object`);
  const tokens = raw.tokens ?? raw.token_response;
  if (!tokens || typeof tokens !== 'object') throw new Error(`jobs-search: ${origin} has no tokens`);
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new Error(`jobs-search: ${origin} has no access_token`);
  }
  const clientId = typeof raw.client_id === 'string' && raw.client_id ? raw.client_id : CODEX_CLIENT_ID;
  return {
    version: 1,
    client_id: clientId,
    tokens: {
      access_token: tokens.access_token,
      token_type: typeof tokens.token_type === 'string' ? tokens.token_type : 'Bearer',
      ...(typeof tokens.refresh_token === 'string' && tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      ...(typeof tokens.scope === 'string' ? { scope: tokens.scope } : {}),
    },
    expires_at: toEpochMs(raw.expires_at) ?? 0,
  };
}

/** @param {string} file */
export function loadCredentials(file) {
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') {
      throw new Error(
        `jobs-search: no credential file at ${file} — run \`node providers/_jobs-search-auth.mjs seed-from-codex\` once (after \`codex mcp login jobs-search\`)`,
      );
    }
    throw new Error(`jobs-search: cannot read credential file ${file}: ${/** @type {Error} */ (err).message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`jobs-search: credential file ${file} is not valid JSON`);
  }
  return normalizeCredentials(parsed, `credential file ${file}`);
}

/**
 * Atomic write (temp + rename in the same directory), file 0600, dir 0700.
 * @param {string} file
 * @param {ReturnType<typeof normalizeCredentials>} cred
 */
export function saveCredentials(file, cred) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * @typedef {object} AuthDeps
 * @property {typeof fetch} [fetchFn]  Transport for the token endpoint (tests inject a fake).
 * @property {() => number} [now]
 * @property {string} [endpoint]       MCP resource the token is bound to (RFC 8707).
 */

/**
 * Exchange the file's refresh token for a new access token and persist the
 * result BEFORE returning, so a rotated refresh token is never held only in
 * memory. Returns `{ cred, rotated }`; `rotated` reports whether the server
 * issued a new refresh token (a boolean, never the token).
 * @param {string} file
 * @param {ReturnType<typeof normalizeCredentials>} cred
 * @param {AuthDeps} [deps]
 */
export async function refreshCredentials(file, cred, deps = {}) {
  const now = deps.now ?? Date.now;
  const refreshToken = cred.tokens.refresh_token;
  if (!refreshToken) {
    throw new Error(`jobs-search: access token in ${file} expired and it holds no refresh token — run \`codex mcp login jobs-search\`, then \`node providers/_jobs-search-auth.mjs seed-from-codex --force\``);
  }
  let tokens;
  try {
    const metadata = await discoverAuthorizationServerMetadata(AUTH_SERVER, { fetchFn: deps.fetchFn });
    tokens = await refreshAuthorization(AUTH_SERVER, {
      metadata,
      clientInformation: { client_id: cred.client_id },
      refreshToken,
      resource: new URL(deps.endpoint ?? DEFAULT_ENDPOINT),
      fetchFn: deps.fetchFn,
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    const reason = [e?.errorCode ?? e?.name, e?.message].filter(Boolean).join(': ') || String(err);
    throw new Error(
      `jobs-search: token renewal failed (${reason}) — if the grant was revoked or its refresh token already used, run \`codex mcp login jobs-search\`, then \`node providers/_jobs-search-auth.mjs seed-from-codex --force\``,
    );
  }
  const expiresIn = Number(tokens.expires_in);
  const next = normalizeCredentials(
    {
      client_id: cred.client_id,
      tokens: { ...tokens, refresh_token: tokens.refresh_token || refreshToken },
      // No expires_in → treat as already stale so the next run renews again
      // instead of trusting a token of unknown lifetime.
      expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : 1,
    },
    'token endpoint response',
  );
  saveCredentials(file, next);
  return { cred: next, rotated: Boolean(tokens.refresh_token) && tokens.refresh_token !== refreshToken };
}

/**
 * Access token for one run: the stored one while it has more than
 * EXPIRY_SKEW_MS left, otherwise a renewed one (persisted first).
 * @param {string} file
 * @param {AuthDeps} [deps]
 */
export async function getAccessToken(file, deps = {}) {
  const now = deps.now ?? Date.now;
  const cred = loadCredentials(file);
  if (cred.expires_at - now() > EXPIRY_SKEW_MS) return cred.tokens.access_token;
  const { cred: next } = await refreshCredentials(file, cred, deps);
  return next.tokens.access_token;
}

/**
 * Read Codex's Keychain record with /usr/bin/security. macOS asks the logged-in
 * user to allow `security` to read an item Codex created (the item's ACL trusts
 * the codex binary only); click Allow — or Always Allow — in that dialog.
 * @param {string} account
 * @returns {Promise<string>}
 */
function readCodexKeychain(account) {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', CODEX_KEYCHAIN_SERVICE, '-a', account, '-w'],
      { timeout: 120_000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) {
          const reason = /** @type {any} */ (err).killed
            ? 'timed out waiting for the Keychain access dialog to be allowed'
            : `security exited ${/** @type {any} */ (err).code}`;
          reject(new Error(`jobs-search: cannot read Keychain item "${CODEX_KEYCHAIN_SERVICE}" / "${account}" (${reason}) — run \`codex mcp login jobs-search\` first if Codex has no grant`));
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') {
      opts.force = '1';
    } else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      opts[k] = inline ?? argv[++i] ?? '';
    } else positional.push(a);
  }
  return { cmd: positional[0], opts };
}

const USAGE = `usage: node providers/_jobs-search-auth.mjs <seed-from-codex|status|refresh> [--credentials FILE] [--endpoint URL] [--codex-server NAME] [--force]

  seed-from-codex  copy Codex's Keychain grant into the credential file (0600);
                   refuses to overwrite an existing file unless --force
  status           print the credential file's expiry (never the token)
  refresh          renew the access token now; reports whether the refresh token rotated`;

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const file = opts.credentials ? resolveUserPath(opts.credentials) : defaultCredentialsPath();
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  if (cmd === 'seed-from-codex') {
    // Once the file has renewed, Codex's copy holds a spent refresh token:
    // seeding over it would replace the one live grant with a dead one.
    if (existsSync(file) && !opts.force) {
      throw new Error(`jobs-search: ${file} already exists — after its first renewal Codex's Keychain copy is spent, so seeding over it would destroy the live grant. Re-seed only after \`codex mcp login jobs-search\`, with --force`);
    }
    const account = codexKeychainAccount(opts['codex-server'] || CODEX_SERVER_NAME, endpoint);
    const raw = await readCodexKeychain(account);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`jobs-search: Keychain item "${account}" is not JSON`);
    }
    const cred = normalizeCredentials(parsed, `Keychain item "${account}"`);
    saveCredentials(file, cred);
    console.log(`seeded ${file} from Keychain "${account}" (refresh token: ${cred.tokens.refresh_token ? 'yes' : 'no'}, access token expires ${new Date(cred.expires_at).toISOString()})`);
    return;
  }
  if (cmd === 'status') {
    const cred = loadCredentials(file);
    const left = Math.round((cred.expires_at - Date.now()) / 60_000);
    console.log(`${file}: client ${cred.client_id}, refresh token ${cred.tokens.refresh_token ? 'present' : 'absent'}, access token ${left > 0 ? `expires in ${left} min` : `expired ${-left} min ago`}`);
    return;
  }
  if (cmd === 'refresh') {
    const { cred, rotated } = await refreshCredentials(file, loadCredentials(file), { endpoint });
    console.log(`renewed ${file}: access token expires ${new Date(cred.expires_at).toISOString()}, refresh token ${rotated ? 'rotated' : 'unchanged'}`);
    return;
  }
  console.error(USAGE);
  process.exit(2);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
