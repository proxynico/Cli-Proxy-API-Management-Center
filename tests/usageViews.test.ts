import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { BurstsPanel } from '../src/features/usage/BurstsPanel';
import { PacePanel } from '../src/features/usage/PacePanel';
import { BURST_LINE, findBursts, hourlyUse } from '../src/features/usage/burstsModel';
import { accountViews, windowsOf } from '../src/features/usage/usageModel';
import type { Point, UsageHistory } from '../src/features/usage/usageModel';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const WEEK = 7 * DAY;
const STALE = 40 * MIN;
/** October 2026, local time; the 19th is a Monday. */
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

/**
 * Readings every 30 minutes for weekly windows starting at `firstStart`. Each
 * window spends `rates[i]` percent a day and locks at 100 until its reset.
 */
const weeks = (firstStart: number, rates: number[], until: number): Point[] => {
  const points: Point[] = [];
  rates.forEach((rate, i) => {
    const start = firstStart + i * WEEK;
    for (let t = start; t < Math.min(start + WEEK, until + 1); t += 30 * MIN) {
      points.push([t, Math.min(100, ((t - start) / DAY) * rate), start + WEEK]);
    }
  });
  return points;
};

describe('windowsOf', () => {
  test('one window per reset, a minute of drift included, and an early reset noticed', () => {
    const points: Point[] = [
      [at(19, 9), 10, at(25, 7)],
      [at(19, 10), 20, at(25, 7, 1)],
      // The provider began a new window on the 20th, five days early.
      [at(20, 14, 36), 0, at(27, 14, 36)],
      [at(20, 15), 1, at(27, 14, 35)],
    ];
    const windows = windowsOf(points, at(20, 16), STALE);
    expect(windows).toHaveLength(2);
    expect(windows[0].endedEarly).toBe(true);
    expect(windows[0].endMs).toBe(at(20, 14, 36));
    expect(windows[0].peak).toBe(20);
    expect(windows[0].fromStart).toBe(false);
    expect(windows[1].current).toBe(true);
    expect(windows[1].fromStart).toBe(true);
  });
});

describe('a run-out before the first reading', () => {
  test('is a lock, with no moment claimed for it', () => {
    // The recorder started on Tuesday; the window began the Wednesday before and was already out.
    const points: Point[] = [
      [at(20, 12, 11), 100, at(21, 11)],
      [at(20, 12, 41), 100, at(21, 11)],
    ];
    const [window] = windowsOf(points, at(20, 13), STALE);
    expect(window.lockedFrom).toBe(at(20, 12, 11));
    expect(window.ranOutAt).toBeNull();
  });
});

describe('bursts', () => {
  const readings = (values: [number, number][], reset = at(25)): Point[] =>
    values.map(([t, used]) => [t, used, reset]);

  test('each rise lands in its hour, and a rise across a silence is dropped', () => {
    const points = readings([
      [at(20, 9), 10],
      [at(20, 9, 30), 12],
      [at(20, 10, 10), 20],
      // Three hours of silence, then a jump nothing can place.
      [at(20, 13, 10), 40],
      [at(20, 13, 40), 41],
    ]);
    const hours = hourlyUse(points, at(20, 9), at(20, 14), STALE);
    expect(hours.map((h) => h.used)).toEqual([2, 8, null, null, 1]);
  });

  test("a quiet hour inside a run doesn't split the burst", () => {
    const hour = (h: number, used: number) => ({ start: at(20, h), used });
    const bursts = findBursts([
      hour(9, 0.2),
      hour(10, 6),
      hour(11, 1),
      hour(12, 8),
      hour(13, 0.1),
      hour(14, 0.1),
      hour(15, BURST_LINE),
    ]);
    expect(bursts).toHaveLength(1);
    expect(bursts[0].start).toBe(at(20, 10));
    expect(bursts[0].end).toBe(at(20, 13));
    expect(bursts[0].used).toBe(15);
  });
});

describe('panels', () => {
  // gmail runs out each Thursday and sudx.io takes the work in bursts while it's out.
  const now = at(22, 12);
  const gmailStart = at(19, 0) - 3 * WEEK;
  const gmail = weeks(gmailStart, [25, 27, 29, 31], now);
  const sudx: Point[] = [];
  for (let t = gmailStart; t <= now; t += 30 * MIN) {
    const sinceReset = (t - gmailStart) % WEEK;
    const gmailOut = sinceReset >= (100 / 25) * DAY - 12 * H;
    const busy = gmailOut && new Date(t).getHours() >= 14 && new Date(t).getHours() < 17;
    const last = sudx[sudx.length - 1];
    // sudx.io's week turns over on Wednesdays.
    const wednesday = gmailStart + 2 * DAY;
    const reset = wednesday + (Math.floor((t - wednesday) / WEEK) + 1) * WEEK;
    const base = last && last[2] === reset ? last[1] : 0;
    sudx.push([t, Math.min(100, base + (busy ? 4 : 0.02)), reset]);
  }
  const history: UsageHistory = {
    version: 1,
    updatedAt: now,
    pollMinutes: 5,
    heartbeatMinutes: 30,
    accounts: {
      'a.json': { provider: 'claude', email: 'a@gmail.com', lastReadingAt: now, lastError: null },
      'b.json': { provider: 'claude', email: 'b@sudx.io', lastReadingAt: now, lastError: null },
    },
    series: { 'a.json': { '7d': gmail }, 'b.json': { '7d': sudx } },
  };
  const props = { history, accounts: accountViews(history), now, theme: 'dark' as const };
  const original = i18n.language;
  beforeAll(() => i18n.changeLanguage('en'));
  afterAll(() => i18n.changeLanguage(original));

  test('every usage page renders from the same history', () => {
    const pace = renderToStaticMarkup(createElement(PacePanel, props));
    expect(pace).toContain('even pace');
    expect(pace).toContain('data-selected="1"');

    const bursts = renderToStaticMarkup(createElement(BurstsPanel, props));
    expect(bursts).toContain('while Claude gmail was out');
  });
});
