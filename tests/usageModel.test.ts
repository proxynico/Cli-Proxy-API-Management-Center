import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import { ForecastPanel } from '../src/features/usage/ForecastPanel';
import { WeeksPanel } from '../src/features/usage/WeeksPanel';
import {
  accountViews,
  dailyPace,
  forecastAccount,
  handOffEvents,
  parseUsageHistory,
  usedAt,
  weekRows,
} from '../src/features/usage/usageModel';
import type { Point, UsageHistory, WindowId } from '../src/features/usage/usageModel';

const H = 3_600_000;
const DAY = 24 * H;
/** October 2026, local time; the 19th is a Monday. */
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

/** Readings every 30 minutes, as the recorder's heartbeat would keep them. */
const series = (from: number, to: number, read: (t: number) => [number, number]): Point[] => {
  const points: Point[] = [];
  for (let t = from; t <= to; t += 30 * 60_000) points.push([t, ...read(t)]);
  return points;
};

const makeHistory = (
  accounts: Record<string, { provider: 'claude' | 'codex' | 'xai'; email: string }>,
  windows: Record<string, Partial<Record<WindowId, Point[]>>>
): UsageHistory => ({
  version: 1,
  updatedAt: 0,
  pollMinutes: 5,
  heartbeatMinutes: 30,
  accounts: Object.fromEntries(
    Object.entries(accounts).map(([name, a]) => [
      name,
      { ...a, lastReadingAt: null, lastError: null },
    ])
  ),
  series: windows,
});

describe('parseUsageHistory', () => {
  test('keeps well-formed accounts and points, drops the rest', () => {
    const parsed = parseUsageHistory({
      version: 1,
      updatedAt: 5,
      accounts: {
        'a.json': { provider: 'claude', email: 'a@x.io' },
        'b.json': { provider: 'gemini', email: 'b@x.io' },
      },
      series: {
        'a.json': { '7d': [[1, 2, 3], [1, 'x', 3], [4]] },
        'b.json': { '7d': [[1, 2, 3]] },
      },
    });
    expect(Object.keys(parsed?.accounts ?? {})).toEqual(['a.json']);
    expect(parsed?.series['a.json']['7d']).toEqual([[1, 2, 3]]);
    expect(parsed?.heartbeatMinutes).toBe(30);
  });

  test('refuses another version', () => {
    expect(parseUsageHistory({ version: 2 })).toBeNull();
    expect(parseUsageHistory(null)).toBeNull();
  });
});

describe('usedAt', () => {
  const points: Point[] = [[at(20, 10), 40, at(20, 12)]];
  const stale = 40 * 60_000;

  test('a reading holds until it goes stale', () => {
    expect(usedAt(points, at(20, 10, 30), stale)).toBe(40);
    expect(usedAt(points, at(20, 10, 41), stale)).toBeNull();
    expect(usedAt(points, at(20, 9), stale)).toBeNull();
  });

  test('a window that reset since its reading starts from zero', () => {
    expect(usedAt([[at(20, 11, 50), 90, at(20, 12)]], at(20, 12, 5), stale)).toBe(0);
  });
});

describe('forecastAccount', () => {
  const resetMs = at(25, 6);
  const now = at(20, 12);
  const one = (points: Point[]) =>
    makeHistory(
      { 'a.json': { provider: 'claude', email: 'a@x.io' } },
      { 'a.json': { '7d': points } }
    );
  const forecastOf = (points: Point[]) => {
    const history = one(points);
    return forecastAccount(history, accountViews(history)[0], now);
  };

  test("runs out at the last day's pace even when the window average looks even", () => {
    // Idle since the window opened, then 24 points in the last day.
    const forecast = forecastOf(
      series(at(19, 12), now, (t) => [Math.max(0, ((t - at(19, 12)) / DAY) * 24), resetMs])
    );
    expect(forecast?.kind).toBe('runsOut');
    expect(forecast?.pace).toBeLessThan(1);
    expect(forecast?.runOutMs).toBeCloseTo(now + (76 / 24) * DAY, -4);
    expect(forecast?.lockedMs).toBeCloseTo(resetMs - (forecast?.runOutMs ?? 0), -4);
  });

  test('locks an exhausted account until its reset', () => {
    const forecast = forecastOf(series(at(20, 6), now, () => [100, resetMs]));
    expect(forecast?.kind).toBe('out');
    expect(forecast?.lockedMs).toBe(resetMs - now);
  });

  test('carries a slow pace to the reset', () => {
    const forecast = forecastOf(
      series(at(19, 12), now, (t) => [((t - at(19, 12)) / DAY) * 5, resetMs])
    );
    expect(forecast?.kind).toBe('holds');
    expect(forecast?.usedAtReset).toBeCloseTo(5 + 5 * ((resetMs - now) / DAY), 1);
  });

  test('says nothing without a current reading', () => {
    expect(forecastOf(series(at(19, 0), at(19, 12), () => [10, resetMs]))).toBeNull();
  });
});

describe('dailyPace', () => {
  test('counts the new window across a reset and leaves days without readings empty', () => {
    const points: Point[] = [
      [at(19, 9), 80, at(19, 12)],
      [at(19, 11), 95, at(19, 12)],
      [at(19, 13), 4, at(26, 12)],
      [at(20, 10), 10, at(26, 12)],
    ];
    const days = dailyPace(points, at(20, 12), 3);
    expect(days.map((d) => d.points)).toEqual([null, 15 + 4, 6]);
  });
});

describe('weekRows and hand-off', () => {
  // A runs out Wed 10:00 until its reset Fri 12:00; B runs out Thu 10:00 until Thu 16:00.
  const weekStart = at(19);
  const now = at(26, 12);
  const aReset = (t: number) => (t < at(23, 12) ? at(23, 12) : at(30, 12));
  const history = makeHistory(
    {
      'a.json': { provider: 'claude', email: 'a@gmail.com' },
      'b.json': { provider: 'claude', email: 'b@sudx.io' },
    },
    {
      'a.json': {
        '7d': series(weekStart, now, (t) => [
          t >= at(21, 10) && t < at(23, 12) ? 100 : 40,
          aReset(t),
        ]),
      },
      'b.json': {
        '7d': series(weekStart, now, (t) => [
          t >= at(22, 10) && t < at(22, 16) ? 100 : 20,
          t < at(22, 16) ? at(22, 16) : at(29, 16),
        ]),
      },
    }
  );
  const accounts = accountViews(history);

  test('names accounts by what tells them apart', () => {
    expect(accounts.map((a) => a.label)).toEqual(['Claude gmail', 'Claude sudx.io']);
  });

  test('counts the stretch with no account free, in and out of work hours', () => {
    const rows = weekRows(history, accounts, now, 2);
    const week = rows[0];
    expect(week.weekStart).toBe(weekStart);
    expect(week.noneFreeMs).toBe(6 * H);
    expect(week.noneFreeWorkMs).toBe(6 * H);
    expect(week.firstGap).toEqual({ from: at(22, 10), to: at(22, 16) });
    // B alone carried the work from Wed 10:00 to Thu 10:00 and from Thu 16:00 to Fri 12:00.
    expect(week.soleCoverMs['b.json']).toBe((24 + 20) * H);
    // Thursday 10:00-16:00 is the 4th day's second and third cells: both show the gap in work hours.
    expect(week.free[3 * 4 + 1]).toBe('noneWork');
    expect(week.free[3 * 4 + 2]).toBe('noneWork');
    expect(week.accounts[0].cells[2 * 4 + 1].state).toBe('runsOut');
  });

  test('lists who ran out and who reset, in order', () => {
    const events = handOffEvents(history, accounts, weekStart, now).map(
      (e) =>
        `${e.kind}:${e.account?.name ?? '-'}@${new Date(e.at).getDate()}-${new Date(e.at).getHours()}`
    );
    expect(events).toEqual([
      'ranOut:a.json@21-10',
      'ranOut:b.json@22-10',
      'noneFree:-@22-10',
      'reset:b.json@22-16',
      'freeAgain:-@22-16',
      'reset:a.json@23-12',
    ]);
  });

  test('both panels render the gap and the lock', () => {
    const props = { history, accounts, now: at(26, 12), theme: 'dark' as const };
    const weeks = renderToStaticMarkup(createElement(WeeksPanel, props));
    expect(weeks).toContain('data-free="noneWork"');
    expect(weeks).toContain('data-state="locked"');

    const forecast = renderToStaticMarkup(
      createElement(ForecastPanel, { ...props, now: at(26, 12) })
    );
    expect(forecast).toContain('data-state="use"');
  });
});
