/**
 * Final-score floor for an evaluated role to count as apply-worthy. Raised from
 * 3.3 to 3.5 on 2026-09-22, after 246 applications produced no offer.
 */
export const APPLY_WORTHY_FLOOR = 3.5;

/**
 * Default cal-v1 forwarding cutoff: a pending pipeline row needs at least this
 * calibrated rank to enter the long A-G evaluation. The cutoff used on
 * 2026-09-23; `eval-queue.mjs` reads the override from `config/profile.yml`.
 */
export const DEFAULT_FORWARD_THRESHOLD = 2.5;

export const RANK_CALIBRATION_KNOTS = Object.freeze([
  Object.freeze({ input: 0, base: 0 }),
  Object.freeze({ input: 3.3, base: 1.8714285714 }),
  Object.freeze({ input: 3.4, base: 2.15 }),
  Object.freeze({ input: 3.5, base: 2.15 }),
  Object.freeze({ input: 3.6, base: 2.31875 }),
  Object.freeze({ input: 3.7, base: 2.31875 }),
  Object.freeze({ input: 3.8, base: 2.31875 }),
  Object.freeze({ input: 3.9, base: 2.38 }),
  Object.freeze({ input: 4.0, base: 2.5755555556 }),
  Object.freeze({ input: 4.1, base: 2.5755555556 }),
  Object.freeze({ input: 4.2, base: 2.5755555556 }),
  Object.freeze({ input: 4.3, base: 2.5755555556 }),
  Object.freeze({ input: 4.4, base: 2.5755555556 }),
  Object.freeze({ input: 4.5, base: 2.7125 }),
  Object.freeze({ input: 4.6, base: 2.7125 }),
  Object.freeze({ input: 4.7, base: 4.1 }),
  Object.freeze({ input: 5.0, base: 4.1 }),
]);

export const RANK_CALIBRATION_CENTER = 409 / 166;
export const RANK_CALIBRATION_SPREAD = 2.8;

export function calibrateRankScore(score) {
  const raw = Number(score);
  if (!Number.isFinite(raw)) return NaN;
  const input = Math.min(5, Math.max(0, raw));
  const first = RANK_CALIBRATION_KNOTS[0];
  const last = RANK_CALIBRATION_KNOTS[RANK_CALIBRATION_KNOTS.length - 1];
  let base = input <= first.input ? first.base : last.base;
  for (let i = 1; i < RANK_CALIBRATION_KNOTS.length && input > first.input; i++) {
    const current = RANK_CALIBRATION_KNOTS[i];
    const previous = RANK_CALIBRATION_KNOTS[i - 1];
    if (input > current.input) continue;
    const fraction = (input - previous.input) / (current.input - previous.input);
    base = previous.base + fraction * (current.base - previous.base);
    break;
  }
  const calibrated = RANK_CALIBRATION_CENTER
    + (base - RANK_CALIBRATION_CENTER) * RANK_CALIBRATION_SPREAD;
  return Math.min(5, Math.max(0, calibrated));
}
