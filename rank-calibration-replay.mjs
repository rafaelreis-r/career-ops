#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { flagValue } from './lib/cli-flags.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { calibrateRankScore } from './lib/rank-calibration.mjs';

export const DEFAULT_REPLAY_DIR = join(getCareerOpsRoot(), 'data', 'rank-calibration');
export const DEFAULT_FIXTURE_PATH = join(DEFAULT_REPLAY_DIR, 'rank-final-2026-09-21.json');
export const DEFAULT_OUTPUT_PATH = join(DEFAULT_REPLAY_DIR, 'rank-final-2026-09-21.replay.json');
export const APPLY_WORTHY_FLOOR = 3.3;
export const REPLAY_THRESHOLDS = Object.freeze([4.0, 3.6, 3.3, 3.0, 2.8]);

const block = (rank, finals) => finals.map(final => ({ rank, final }));

export function canonicalReplayPairs() {
  const pairs = [
    ...block(3.3, [1.2, 1.5, 1.7, 1.8, 2.0, 2.2, 2.7]),
    ...block(3.4, [2.1]),
    ...block(3.5, [2.2]),
    ...block(3.6, [1.4, 1.5, 1.6, 1.7, 1.8, 2.0]),
    ...block(3.7, [2.2, 2.3, 2.4, 2.5, 2.6]),
    ...block(3.8, [2.7, 2.8, 3.0, 3.3, 3.3]),
    ...block(3.9, [1.5, 2.0, 2.3, 2.8, 3.3]),
    ...block(4.0, Array(9).fill(1.8)),
    ...block(4.1, Array(9).fill(1.8)),
    ...block(4.2, [1.8, 2.8, ...Array(7).fill(3.1)]),
    ...block(4.3, Array(9).fill(3.1)),
    ...block(4.4, [...Array(2).fill(3.1), ...Array(7).fill(3.3)]),
    ...block(4.5, [2.4, 2.5, 2.6, 2.7]),
    ...block(4.6, [2.5, 2.7, 3.0, 3.3]),
    ...block(4.7, [4.1]),
  ];
  return pairs.map((pair, index) => ({ id: index + 1, ...pair }));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values) {
  const avg = mean(values);
  return Math.sqrt(mean(values.map(value => (value - avg) ** 2)));
}

function tiedRanks(values) {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = Array(values.length);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end++;
    const rank = (start + 1 + end) / 2;
    for (let i = start; i < end; i++) ranks[sorted[i].index] = rank;
    start = end;
  }
  return ranks;
}

function correlation(left, right) {
  const leftMean = mean(left);
  const rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftDenominator = left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0);
  const rightDenominator = right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0);
  return numerator / Math.sqrt(leftDenominator * rightDenominator);
}

export function replayCalibration(pairs, thresholds = REPLAY_THRESHOLDS) {
  if (!Array.isArray(pairs) || pairs.length !== 84) throw new TypeError('fixture must contain exactly 84 pairs');
  const rows = pairs.map(pair => {
    const rank = Number(pair.rank);
    const final = Number(pair.final);
    if (!Number.isFinite(rank) || !Number.isFinite(final)) throw new TypeError('every pair needs numeric rank and final scores');
    const calibrated = calibrateRankScore(rank);
    return { ...pair, calibrated, persisted: Number(calibrated.toFixed(1)) };
  });
  const calibrated = rows.map(row => row.calibrated);
  const finals = rows.map(row => row.final);
  const positives = rows.filter(row => row.final >= APPLY_WORTHY_FLOOR).length;
  const thresholdMetrics = thresholds.map(threshold => {
    const forwardedRows = rows.filter(row => row.persisted >= threshold);
    const truePositives = forwardedRows.filter(row => row.final >= APPLY_WORTHY_FLOOR).length;
    return {
      threshold,
      forwarded: forwardedRows.length,
      truePositives,
      precision: forwardedRows.length ? truePositives / forwardedRows.length : null,
      coverage: positives ? truePositives / positives : null,
    };
  });
  const calibratedStddev = stddev(calibrated);
  const finalStddev = stddev(finals);
  return {
    pairCount: rows.length,
    applyWorthyFloor: APPLY_WORTHY_FLOOR,
    applyWorthyCount: positives,
    bias: mean(rows.map(row => row.calibrated - row.final)),
    spearman: correlation(tiedRanks(calibrated), tiedRanks(finals)),
    calibratedStddev,
    finalStddev,
    stddevRatio: calibratedStddev / finalStddev,
    thresholds: thresholdMetrics,
    rows,
  };
}

export function writeCanonicalReplay(fixturePath = DEFAULT_FIXTURE_PATH, outputPath = DEFAULT_OUTPUT_PATH) {
  const fixture = { asOf: '2026-09-21', pairCount: 84, pairs: canonicalReplayPairs() };
  mkdirSync(dirname(fixturePath), { recursive: true });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  const replay = replayCalibration(fixture.pairs);
  writeFileSync(outputPath, `${JSON.stringify(replay, null, 2)}\n`);
  return replay;
}

function main(args) {
  const fixturePath = resolve(flagValue(args, '--fixture') || DEFAULT_FIXTURE_PATH);
  const outputPath = resolve(flagValue(args, '--output') || DEFAULT_OUTPUT_PATH);
  let replay;
  if (args.includes('--write-canonical')) {
    replay = writeCanonicalReplay(fixturePath, outputPath);
  } else {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    replay = replayCalibration(fixture.pairs);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(replay, null, 2)}\n`);
  }
  console.log(JSON.stringify({
    fixture: fixturePath,
    output: outputPath,
    pairCount: replay.pairCount,
    bias: replay.bias,
    spearman: replay.spearman,
    calibratedStddev: replay.calibratedStddev,
    finalStddev: replay.finalStddev,
    stddevRatio: replay.stddevRatio,
    thresholds: replay.thresholds,
  }));
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
