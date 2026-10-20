/**
 * Pace forecast for the quota windows timeline.
 *
 * The timeline shows when capacity comes back; this says whether it runs out
 * first. A lane's current window reports how much is used and when it resets,
 * which is enough to read the pace so far and carry it forward: no stored
 * history is needed.
 *
 * Pure functions over timeline lanes, with `now` always passed in, so every
 * case is directly testable. Kept apart from quotaTimelineModel.ts so the
 * upstream model merges cleanly.
 */

import { HOUR_MS } from '@/utils/time/durations';
import type { QuotaProviderType } from './providers/types';
import type { TimelineLane } from './quotaTimelineModel';

/** Below this much of a window, one burst would read as a runaway pace. */
const MIN_ELAPSED_MS = 30 * 60 * 1000;
const MIN_ELAPSED_FRACTION = 0.02;

export type LaneForecast =
  /** Nothing left now; locked until the window resets. */
  | { kind: 'out'; lockedFromMs: number; resetMs: number }
  /** At the pace so far, runs out at `lockedFromMs`, before the reset. */
  | { kind: 'runsOut'; lockedFromMs: number; resetMs: number; pace: number }
  /** At the pace so far, `usedAtReset` percent is gone when the window resets. */
  | { kind: 'holds'; usedAtReset: number; resetMs: number; pace: number };

/**
 * Forecast a lane's current window at the pace used so far.
 *
 * `pace` is percent used over percent of the window gone: 1 spends the window
 * evenly, above 1 runs out before the reset. Null when the lane has no current
 * window, its reported reset has passed, or too little of it has gone.
 */
export function forecastLane(lane: TimelineLane, now: number): LaneForecast | null {
  const { anchorMs, periodHours, remaining } = lane;
  if (anchorMs === null || !periodHours || remaining === null) return null;
  // The payload's window already reset; its usage says nothing about the next.
  if (anchorMs <= now) return null;

  const periodMs = periodHours * HOUR_MS;
  const elapsedMs = now - (anchorMs - periodMs);
  if (elapsedMs < 0) return null;

  if (remaining <= 0) return { kind: 'out', lockedFromMs: now, resetMs: anchorMs };
  if (elapsedMs < Math.max(MIN_ELAPSED_MS, periodMs * MIN_ELAPSED_FRACTION)) return null;

  const used = 100 - remaining;
  const pace = used / ((elapsedMs / periodMs) * 100);
  const usedPerMs = used / elapsedMs;

  if (usedPerMs > 0) {
    const runOutMs = now + remaining / usedPerMs;
    if (runOutMs < anchorMs) {
      return { kind: 'runsOut', lockedFromMs: runOutMs, resetMs: anchorMs, pace };
    }
  }

  return {
    kind: 'holds',
    usedAtReset: Math.min(100, used + usedPerMs * (anchorMs - now)),
    resetMs: anchorMs,
    pace,
  };
}

/** A stretch when every account of one provider is forecast locked. */
export interface ProviderGap {
  provider: QuotaProviderType;
  fromMs: number;
  toMs: number;
}

/**
 * Stretches when no account of a provider has anything left.
 *
 * A provider counts only when every one of its lanes has a lock forecast; a
 * lane with no forecast might cover the gap, so it is not assumed away. The gap
 * opens when the last account locks and closes when the first one resets.
 */
export function providerGaps(
  lanes: readonly { lane: TimelineLane; forecast: LaneForecast | null }[]
): ProviderGap[] {
  const byProvider = new Map<QuotaProviderType, (LaneForecast | null)[]>();
  for (const { lane, forecast } of lanes) {
    byProvider.set(lane.provider, [...(byProvider.get(lane.provider) ?? []), forecast]);
  }

  const gaps: ProviderGap[] = [];
  for (const [provider, forecasts] of byProvider) {
    const locks = forecasts.filter(
      (forecast): forecast is Extract<LaneForecast, { lockedFromMs: number }> =>
        forecast !== null && forecast.kind !== 'holds'
    );
    if (locks.length === 0 || locks.length !== forecasts.length) continue;

    const fromMs = Math.max(...locks.map((lock) => lock.lockedFromMs));
    const toMs = Math.min(...locks.map((lock) => lock.resetMs));
    if (fromMs < toMs) gaps.push({ provider, fromMs, toMs });
  }
  return gaps;
}
