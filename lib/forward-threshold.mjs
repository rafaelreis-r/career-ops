/**
 * forward-threshold.mjs — the rank_forward_threshold cutoff in config/profile.yml.
 * Shared by the forwarding gate (eval-queue.mjs) and the initial rank (rank-pipeline.mjs).
 */

import { existsSync, readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { DEFAULT_FORWARD_THRESHOLD } from './rank-calibration.mjs';

/**
 * A cutoff on the cal-v3 score scale. Blank means "not configured".
 * @param {unknown} raw
 * @param {string} source - where the value came from, for the error message.
 * @returns {number | null}
 */
export function parseForwardThreshold(raw, source) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value) || value < 0 || value > 5) {
    throw new Error(`${source}: forwarding cutoff must be a number from 0 to 5 on the cal-v3 scale, got "${raw}"`);
  }
  return value;
}

/**
 * The configured cutoff: `rank_forward_threshold` in config/profile.yml, or the default.
 * @param {string} profilePath
 * @returns {number}
 */
export function loadForwardThreshold(profilePath) {
  if (!existsSync(profilePath)) return DEFAULT_FORWARD_THRESHOLD;
  const profile = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  return parseForwardThreshold(profile.rank_forward_threshold, `${profilePath} rank_forward_threshold`)
    ?? DEFAULT_FORWARD_THRESHOLD;
}
