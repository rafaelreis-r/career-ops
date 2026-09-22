#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

export const DEFAULT_TRIAGE_THRESHOLD = 3.0;
export const APPLY_WORTHY_FLOOR = 3.3;

export function resolveTriageThreshold(profile = {}) {
  const value = Number(profile?.pipeline?.triage_threshold);
  return Number.isFinite(value) && value >= 0 && value <= 5
    ? value
    : DEFAULT_TRIAGE_THRESHOLD;
}

export function parseTriageScore(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = String(value ?? '');
  const labeled = text.match(/\brank:\s*cal-v1\s+([0-5](?:\.\d+)?)\s*\/\s*5\b/i);
  if (labeled) return Number(labeled[1]);
  const plain = Number(text.trim());
  return Number.isFinite(plain) ? plain : NaN;
}

export function decideTriage(score, threshold = DEFAULT_TRIAGE_THRESHOLD, priorityOverride = false) {
  const numericScore = Number(score);
  const numericThreshold = Number(threshold);
  if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 5) {
    throw new TypeError('triage score must be a number from 0 to 5');
  }
  if (!Number.isFinite(numericThreshold) || numericThreshold < 0 || numericThreshold > 5) {
    throw new TypeError('triage threshold must be a number from 0 to 5');
  }
  const forward = priorityOverride || numericScore >= numericThreshold;
  const verdict = forward
    ? 'pass'
    : numericThreshold > DEFAULT_TRIAGE_THRESHOLD && numericScore >= DEFAULT_TRIAGE_THRESHOLD
      ? 'marginal'
      : 'fail';
  return {
    score: numericScore,
    threshold: numericThreshold,
    applyWorthyFloor: APPLY_WORTHY_FLOOR,
    applyWorthy: numericScore >= APPLY_WORTHY_FLOOR,
    priorityOverride: Boolean(priorityOverride),
    verdict,
    forward,
  };
}

export function loadTriageThreshold() {
  const profilePath = join(getCareerOpsRoot(), 'config', 'profile.yml');
  if (!existsSync(profilePath)) return DEFAULT_TRIAGE_THRESHOLD;
  try {
    return resolveTriageThreshold(yaml.load(readFileSync(profilePath, 'utf8')) || {});
  } catch {
    return DEFAULT_TRIAGE_THRESHOLD;
  }
}

function main(args) {
  const threshold = loadTriageThreshold();
  if (hasFlag(args, '--show-config')) {
    console.log(JSON.stringify({ triageThreshold: threshold, applyWorthyFloor: APPLY_WORTHY_FLOOR }));
    return 0;
  }
  const raw = flagValue(args, '--score') ?? flagValue(args, '--line');
  const score = parseTriageScore(raw);
  try {
    console.log(JSON.stringify(decideTriage(score, threshold, hasFlag(args, '--priority-override'))));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
