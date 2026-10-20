/**
 * Trends: whether an account uses more each week, and so runs out earlier.
 *
 * Each weekly window gets one rate, the percent of the limit it used a day
 * while it had room. A steady rise in that rate is what moves the run-out
 * earlier; the fit over finished windows carries it forward.
 */

import { DAY_MS } from '@/utils/time/durations';
import { WEEK_MS, readingAt } from './usageModel';
import type { UsageWindow } from './usageModel';

/** Fewer finished windows than this make a line through noise. */
export const MIN_TREND_WINDOWS = 3;
/** A rate needs at least a day of readings behind it. */
const MIN_SPAN_MS = DAY_MS;
/** Below this fit, the weeks vary too much to project. */
const MIN_FIT = 0.5;
/** Under this many percent a day an account is idle, and its growth is noise. */
const IDLE_RATE = 1;
const PROJECT_WINDOWS = 4;

export interface WindowTrend {
  window: UsageWindow;
  /** Percent of the limit used a day while it had room, or null on too little reading. */
  rate: number | null;
  /** How long into the window it ran out. */
  ranOutAfterMs: number | null;
}

export interface Projection {
  startMs: number;
  rate: number;
  ranOutAfterMs: number | null;
}

export interface AccountTrend {
  windows: WindowTrend[];
  /** Change in the rate per week: 0.06 is 6% more each week. Null with too few windows. */
  growth: number | null;
  /** The weeks vary too much for the growth to mean anything. */
  irregular: boolean;
  /** Used too little for a trend to mean anything. */
  idle: boolean;
  /** The latest run-out less the first, both measured into their windows; negative is earlier. */
  movedMs: number | null;
  movedWeeks: number;
  /** Windows after the current one, if the growth holds. */
  projections: Projection[];
}

export function rateOf(window: UsageWindow, now: number): number | null {
  // Out before the first reading: nothing was seen of how fast it got there.
  if (window.lockedFrom !== null && window.ranOutAt === null) return null;
  const end = window.ranOutAt ?? (window.current ? now : window.lastAt);
  const usedEnd =
    window.ranOutAt !== null ? 100 : (readingAt(window.points, end, Infinity)?.[1] ?? 0);
  const [from, usedFrom] = window.fromStart
    ? [window.startMs, 0]
    : [window.firstAt, window.points[0][1]];
  // A window read from its start to its run-out is known whole, however short.
  const whole = window.fromStart && window.ranOutAt !== null;
  if (!whole && end - from < MIN_SPAN_MS) return null;
  return Math.max(0, usedEnd - usedFrom) / ((end - from) / DAY_MS);
}

const ranOutAfter = (rate: number) => {
  const after = (100 / rate) * DAY_MS;
  return rate > 0 && after < WEEK_MS ? after : null;
};

export function accountTrend(windows: readonly UsageWindow[], now: number): AccountTrend {
  const trends: WindowTrend[] = windows.map((window) => ({
    window,
    rate: rateOf(window, now),
    ranOutAfterMs:
      window.ranOutAt !== null && window.fromStart ? window.ranOutAt - window.startMs : null,
  }));

  // A current window that already ran out is as settled as a finished one.
  const settled = (w: WindowTrend) => !w.window.current || w.window.lockedFrom !== null;
  const finished = trends.filter((w) => settled(w) && w.rate !== null);
  let growth: number | null = null;
  let irregular = false;
  let projections: Projection[] = [];
  const idle =
    finished.length >= MIN_TREND_WINDOWS &&
    finished.reduce((sum, w) => sum + (w.rate as number), 0) / finished.length < IDLE_RATE;
  if (idle) {
    growth = 0;
  } else if (finished.length >= MIN_TREND_WINDOWS) {
    // Least squares on the log of the rate, so the growth is a steady percent a week.
    const origin = finished[0].window.startMs;
    const xs = finished.map((w) => (w.window.startMs - origin) / WEEK_MS);
    const ys = finished.map((w) => Math.log(Math.max(w.rate as number, 0.1)));
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const [mx, my] = [mean(xs), mean(ys)];
    const sxx = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
    const sxy = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0);
    const syy = ys.reduce((sum, y) => sum + (y - my) ** 2, 0);
    const slope = sxx > 0 ? sxy / sxx : 0;
    const fit = syy > 0 && sxx > 0 ? (sxy * sxy) / (sxx * syy) : 1;
    growth = Math.exp(slope) - 1;
    irregular = fit < MIN_FIT && Math.abs(growth) > 0.02;
    if (!irregular) {
      const last = trends[trends.length - 1].window;
      projections = Array.from({ length: PROJECT_WINDOWS }, (_, i) => {
        const startMs = last.resetMs + i * WEEK_MS;
        const x = (startMs - origin) / WEEK_MS;
        const rate = Math.exp(my + slope * (x - mx));
        return { startMs, rate, ranOutAfterMs: ranOutAfter(rate) };
      });
    }
  }

  const ranOut = trends.filter((w) => settled(w) && w.ranOutAfterMs !== null);
  const [first, latest] = [ranOut[0], ranOut[ranOut.length - 1]];
  const moved = ranOut.length >= 2;

  return {
    windows: trends,
    growth,
    irregular,
    idle,
    movedMs: moved ? (latest.ranOutAfterMs as number) - (first.ranOutAfterMs as number) : null,
    movedWeeks: moved ? Math.round((latest.window.startMs - first.window.startMs) / WEEK_MS) : 0,
    projections,
  };
}
