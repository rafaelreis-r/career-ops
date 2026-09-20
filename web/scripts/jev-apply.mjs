#!/usr/bin/env node
// jev-apply.mjs — thin CLI over the apply router (lib/apply-route.mjs) and the
// typed Jev helpers (lib/jev-apply-helpers.mjs), so a shell-driven, LLM-owned
// apply worker can take one bounded typed decision per call instead of spending
// an LLM turn on it.
//
// Subcommands read JSON from --input <json> or from stdin, and print one JSON
// object to stdout:
//
//   jev-apply.mjs route <url>              -> {"route":"fast"|"llm"}
//   jev-apply.mjs match  [--input <json>]  -> {"match":<label>|null,"value":<value>|null,"confidence":n}
//       input:  {"field":{"label","placeholder","nearbyText","type"}}
//   jev-apply.mjs pick   [--input <json>]  -> {"index":<n>|null,"confidence":n}
//       input:  {"options":[...],"label":"...","desiredValue":"..."}
//   jev-apply.mjs bool   [--input <json>]  -> {"bool":true|false|null,"confidence":n,"probability":p|null}
//       input:  {"question":"..."}
//   jev-apply.mjs ready  [--input <json>]  -> {"ready":true|false,"confidence":n,"abstained":bool}
//       input:  {"fields":[{"label","required","value"}, ...]}
//   jev-apply.mjs block  [--input <json>]  -> {"block":<class>|null,"confidence":n}
//       input:  {"pageState":{...}}  (or the whole JSON object is the page state)
//
// EXIT CODES: 0 on a decision — INCLUDING a NONE/null decision (Jev abstained,
// was below the confidence threshold, or is disabled). Non-zero ONLY on a real
// transport error (2) or a usage/argument error (1). A NONE decision is a
// decision; a transport error is not.
//
// Canonical answers come from config/profile.yml through ab-jev-apply.mjs's
// answersFromProfile() (dynamically imported by the `match` subcommand, never
// re-implemented — the PT-BR aliases and consent answers live there once).
// That module pulls in playwright-core at module scope, so it is loaded LAZILY,
// only when `match` actually runs; it needs no browser.
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { applyRoute } from '../../lib/apply-route.mjs';
import { matchField, pickOption, answerBool, readyToSubmit, classifyBlock } from '../../lib/jev-apply-helpers.mjs';

// js-yaml, path-resolver and ab-jev-apply (which pulls in playwright-core at
// module scope) are imported LAZILY, only inside the subcommands that read the
// profile — so `route`, `pick` and `block` stay dependency-light and fast for a
// shell worker calling one decision per process.

/** @returns {Promise<string>} Path to config/profile.yml, honoring CAREER_OPS_PROFILE (same as jev-pregate). */
async function profilePath() {
  if (process.env.CAREER_OPS_PROFILE) return process.env.CAREER_OPS_PROFILE;
  const { getCareerOpsRoot } = await import('../../path-resolver.mjs');
  return path.join(getCareerOpsRoot(), 'config', 'profile.yml');
}

/** Load and parse config/profile.yml, or null when missing/unreadable. */
async function loadProfile() {
  const p = await profilePath();
  if (!fs.existsSync(p)) return null;
  try {
    const yaml = await import('js-yaml');
    return yaml.load(fs.readFileSync(p, 'utf8')) || null;
  } catch {
    return null;
  }
}

/** The candidate's own facts a yes/no question may be judged against (trusted). */
function profileFactsFromConfig(profile) {
  return {
    candidate: profile?.candidate ?? null,
    location: profile?.location ?? null,
    application_answers: profile?.application_answers ?? null,
  };
}

/** Read the command's JSON input from --input <json>, else from stdin. */
function readInput(args) {
  const flagIdx = args.indexOf('--input');
  const raw = flagIdx >= 0 ? args[flagIdx + 1] : fs.readFileSync(0, 'utf8');
  const text = (raw ?? '').trim();
  if (!text) return {};
  return JSON.parse(text);
}

/** Print a JSON object and stop; exit code is set by the caller. */
function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function usage() {
  return [
    'Usage:',
    '  jev-apply.mjs route <url>',
    '  jev-apply.mjs match  [--input <json>]   # {"field":{label,placeholder,nearbyText,type}}',
    '  jev-apply.mjs pick   [--input <json>]   # {"options":[...],"label":...,"desiredValue":...}',
    '  jev-apply.mjs bool   [--input <json>]   # {"question":"..."}',
    '  jev-apply.mjs ready  [--input <json>]   # {"fields":[{label,required,value}, ...], profileFacts?}',
    '  jev-apply.mjs block  [--input <json>]   # {"pageState":{...}}',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = cmd ? 0 : 1;
    return;
  }

  // route: pure, no Jev, no profile.
  if (cmd === 'route') {
    const url = rest.find((a) => !a.startsWith('-'));
    if (!url) {
      process.stderr.write('route requires a <url> argument\n');
      process.exitCode = 1;
      return;
    }
    emit({ route: applyRoute(url) });
    return;
  }

  let input;
  try {
    input = readInput(rest);
  } catch (err) {
    process.stderr.write(`invalid JSON input: ${err?.message || String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  if (cmd === 'match') {
    const profile = await loadProfile();
    const { answersFromProfile } = await import('./ab-jev-apply.mjs');
    const canonicalAnswers = profile ? answersFromProfile(profile) : [];
    const res = await matchField(input.field ?? {}, canonicalAnswers);
    if (res.error) {
      process.stderr.write(`jev transport error: ${res.error}\n`);
      process.exitCode = 2;
      return;
    }
    const value = res.match ? (canonicalAnswers.find((a) => a.label === res.match)?.value ?? null) : null;
    emit({ match: res.match, value, confidence: res.confidence });
    return;
  }

  if (cmd === 'pick') {
    const res = await pickOption(input.options ?? [], { label: input.label, desiredValue: input.desiredValue });
    if (res.error) {
      process.stderr.write(`jev transport error: ${res.error}\n`);
      process.exitCode = 2;
      return;
    }
    emit({ index: res.index, confidence: res.confidence });
    return;
  }

  if (cmd === 'bool') {
    const profile = await loadProfile();
    const facts = profileFactsFromConfig(profile);
    const res = await answerBool(input.question ?? '', facts);
    if (res.error) {
      process.stderr.write(`jev transport error: ${res.error}\n`);
      process.exitCode = 2;
      return;
    }
    emit({ bool: res.bool, confidence: res.confidence, probability: res.probability });
    return;
  }

  if (cmd === 'ready') {
    const profile = await loadProfile();
    const fields = Array.isArray(input.fields) ? input.fields : (Array.isArray(input) ? input : []);
    const res = await readyToSubmit({ fields, profileFacts: profileFactsFromConfig(profile) });
    if (res.error) {
      process.stderr.write(`jev transport error: ${res.error}\n`);
      process.exitCode = 2;
      return;
    }
    emit({ ready: res.ready, confidence: res.confidence, abstained: res.abstained });
    return;
  }

  if (cmd === 'block') {
    const pageState = 'pageState' in input ? input.pageState : input;
    const res = await classifyBlock(pageState);
    if (res.error) {
      process.stderr.write(`jev transport error: ${res.error}\n`);
      process.exitCode = 2;
      return;
    }
    emit({ block: res.block, confidence: res.confidence });
    return;
  }

  process.stderr.write(`unknown subcommand "${cmd}"\n${usage()}\n`);
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
    process.exitCode = 1;
  });
}

export { main };
