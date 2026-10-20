/**
 * Bursts: the hours an account used its weekly limit far faster than the week
 * allows, and how much of its use they carried.
 */

import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import { WEEK_MS, readingAt, sameWindow } from './usageModel';
import type { Point, UsageWindow } from './usageModel';

/** Four times the even pace: a week's limit spent in under two days. */
export const BURST_LINE = (4 * 100) / (WEEK_MS / HOUR_MS);
/** A shorter, smaller run is noise rather than a burst worth naming. */
const MIN_BURST = 5;

export interface HourUse {
  start: number;
  /** Percent of the weekly limit used in the hour, or null with no reading. */
  used: number | null;
}

/**
 * Use per hour from `fromMs` to `toMs`. Each rise between readings lands in
 * the hour it was read; a rise across a silence longer than `staleMs` is
 * dropped, since nothing says when in the silence it happened.
 */
export function hourlyUse(
  points: readonly Point[],
  fromMs: number,
  toMs: number,
  staleMs: number
): HourUse[] {
  const hours: HourUse[] = [];
  for (let start = fromMs; start < toMs; start += HOUR_MS) {
    const end = Math.min(start + HOUR_MS, toMs) - 1;
    // Known when a reading falls in the hour or one before it still holds at its end.
    const latest = readingAt(points, end, Infinity);
    const known = latest !== null && (latest[0] >= start || end - latest[0] <= staleMs);
    hours.push({ start, used: known ? 0 : null });
  }
  for (let i = 1; i < points.length; i += 1) {
    const [prev, next] = [points[i - 1], points[i]];
    if (next[0] < fromMs || next[0] >= toMs || next[0] - prev[0] > staleMs) continue;
    // Across a reset, the new window's reading is all new use.
    const rise = sameWindow(prev[2], next[2]) ? Math.max(0, next[1] - prev[1]) : next[1];
    const hour = hours[Math.floor((next[0] - fromMs) / HOUR_MS)];
    if (hour) hour.used = (hour.used ?? 0) + rise;
  }
  return hours;
}

export interface Burst {
  start: number;
  end: number;
  /** Percent of the weekly limit used in it. */
  used: number;
  /** The busiest hour's use. */
  peak: number;
}

/** Runs of hours at or over the burst line; one quieter hour inside doesn't end a run. */
export function findBursts(hours: readonly HourUse[]): Burst[] {
  const runs: { start: number; end: number }[] = [];
  let quiet = Infinity;
  for (const hour of hours) {
    if ((hour.used ?? 0) < BURST_LINE) {
      quiet += 1;
      continue;
    }
    const open = runs[runs.length - 1];
    if (open && quiet <= 1) open.end = hour.start + HOUR_MS;
    else runs.push({ start: hour.start, end: hour.start + HOUR_MS });
    quiet = 0;
  }
  return runs
    .map((run) => {
      const inside = hours.filter((hour) => hour.start >= run.start && hour.start < run.end);
      return {
        ...run,
        used: inside.reduce((sum, hour) => sum + (hour.used ?? 0), 0),
        peak: Math.max(...inside.map((hour) => hour.used ?? 0)),
      };
    })
    .filter((burst) => burst.used >= MIN_BURST);
}

export interface BurstDay {
  dayStart: number;
  hours: HourUse[];
  /** Percent used that day, or null with no reading at all. */
  used: number | null;
  /** Stretches with nothing left, clipped to the day. */
  locked: { from: number; to: number }[];
  /** Window resets that fell in the day. */
  resets: number[];
}

/** Local days from `fromMs` through today, each with its hours, locks and resets. */
export function burstDays(
  hours: readonly HourUse[],
  windows: readonly UsageWindow[],
  fromMs: number,
  now: number
): BurstDay[] {
  const days: BurstDay[] = [];
  for (let day = new Date(fromMs).setHours(0, 0, 0, 0); day <= now;) {
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    const end = next.getTime();
    const own = hours.filter((hour) => hour.start >= day && hour.start < end);
    const known = own.filter((hour) => hour.used !== null);
    days.push({
      dayStart: day,
      hours: own,
      used: known.length ? known.reduce((sum, hour) => sum + (hour.used as number), 0) : null,
      locked: windows
        .filter((w) => w.lockedFrom !== null && w.lockedFrom < end && w.endMs > day)
        .map((w) => ({
          from: Math.max(w.lockedFrom as number, day),
          to: Math.min(w.endMs, end, now),
        })),
      resets: windows
        .filter((w) => !w.current && w.endMs >= day && w.endMs < end && w.endMs <= now)
        .map((w) => w.endMs),
    });
    day = end;
  }
  return days;
}

export interface WindowSplit {
  window: UsageWindow;
  /** What the window finished at, or has reached so far. */
  used: number;
  inBursts: number;
}

/** Each window's use, and how much of it came in bursts. */
export function windowSplits(
  windows: readonly UsageWindow[],
  bursts: readonly Burst[],
  hours: readonly HourUse[]
): WindowSplit[] {
  return windows.map((window) => {
    const inBursts = hours
      .filter(
        (hour) =>
          hour.start >= window.startMs &&
          hour.start < window.endMs &&
          bursts.some((burst) => hour.start >= burst.start && hour.start < burst.end)
      )
      .reduce((sum, hour) => sum + (hour.used ?? 0), 0);
    return { window, used: window.peak, inBursts: Math.min(inBursts, window.peak) };
  });
}

/** How far back the burst view reads: four weeks is enough to see a habit. */
export const BURST_DAYS = 28;
export const burstsFrom = (firstAt: number, now: number) =>
  Math.max(firstAt, now - (BURST_DAYS - 1) * DAY_MS);
