import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import { QuotaTimeline } from '../src/features/quota/components/QuotaTimeline';
import { forecastLane, providerGaps } from '../src/features/quota/quotaForecastModel';
import { HOUR_MS } from '../src/features/quota/quotaTimelineModel';
import type { TimelineLane } from '../src/features/quota/quotaTimelineModel';

const now = new Date(2026, 9, 20, 9, 30).getTime();
const WEEK_HOURS = 168;

/** A lane whose weekly window is `gone` of the way through with `remaining` percent left. */
const lane = (
  remaining: number | null,
  gone: number,
  overrides: Partial<TimelineLane> = {}
): TimelineLane => ({
  name: 'a.json',
  displayName: 'a',
  provider: 'claude',
  anchorMs: now + (1 - gone) * WEEK_HOURS * HOUR_MS,
  periodHours: WEEK_HOURS,
  remaining,
  limits: [],
  resetCredits: [],
  ...overrides,
});

describe('forecastLane', () => {
  test('runs out before the reset when the pace is above even', () => {
    // 90% used in 5.25 days: 1.2x pace, and the last 10% lasts 14 hours.
    const forecast = forecastLane(lane(10, 0.75), now);

    expect(forecast?.kind).toBe('runsOut');
    if (forecast?.kind !== 'runsOut') return;
    expect(forecast.pace).toBeCloseTo(1.2, 5);
    expect(forecast.lockedFromMs).toBeCloseTo(now + 14 * HOUR_MS, -3);
    expect(forecast.lockedFromMs).toBeLessThan(forecast.resetMs);
  });

  test('carries a slow pace forward to the reset', () => {
    // 22% used with 30% gone: 0.73x pace, about 73% gone by the reset.
    const forecast = forecastLane(lane(78, 0.3), now);

    expect(forecast?.kind).toBe('holds');
    if (forecast?.kind !== 'holds') return;
    expect(forecast.usedAtReset).toBeCloseTo(73.33, 1);
    expect(forecast.pace).toBeCloseTo(0.733, 2);
  });

  test('locks an exhausted window from now until its reset', () => {
    const forecast = forecastLane(lane(0, 0.85), now);

    expect(forecast).toEqual({
      kind: 'out',
      lockedFromMs: now,
      resetMs: now + 0.15 * WEEK_HOURS * HOUR_MS,
    });
  });

  test('declines rather than guessing', () => {
    // Too little of the window gone for a pace: 1% of a week is under 2 hours.
    expect(forecastLane(lane(95, 0.01), now)).toBeNull();
    // The reported window already reset.
    expect(forecastLane(lane(40, 1.1), now)).toBeNull();
    // Nothing to anchor or measure.
    expect(forecastLane(lane(40, 0.5, { anchorMs: null }), now)).toBeNull();
    expect(forecastLane(lane(null, 0.5), now)).toBeNull();
  });

  test('an unused window holds at zero', () => {
    const forecast = forecastLane(lane(100, 0.5), now);
    expect(forecast).toEqual({
      kind: 'holds',
      usedAtReset: 0,
      resetMs: lane(100, 0.5).anchorMs as number,
      pace: 0,
    });
  });
});

describe('providerGaps', () => {
  const entry = (
    remaining: number,
    gone: number,
    provider: TimelineLane['provider'] = 'claude'
  ) => {
    const l = lane(remaining, gone, { provider });
    return { lane: l, forecast: forecastLane(l, now) };
  };

  test('opens when the last account locks and closes at the first reset', () => {
    const runsOut = entry(10, 0.75); // locks in 14 hours, resets in 42

    // The exhausted account resets in 8.4 hours, before the other one locks.
    expect(providerGaps([entry(0, 0.95), runsOut])).toEqual([]);

    const out = entry(0, 0.85); // locked now, resets in 25.2 hours
    const [gap] = providerGaps([out, runsOut]);
    expect(gap.provider).toBe('claude');
    expect(gap.fromMs).toBe(
      runsOut.forecast?.kind === 'runsOut' ? runsOut.forecast.lockedFromMs : NaN
    );
    expect(gap.toMs).toBe(out.lane.anchorMs as number);
  });

  test('an account with room, or with no forecast, covers its provider', () => {
    expect(providerGaps([entry(0, 0.5), entry(78, 0.3)])).toEqual([]);
    expect(providerGaps([entry(0, 0.5), entry(95, 0.01)])).toEqual([]);
  });

  test('keeps providers apart', () => {
    const gaps = providerGaps([entry(0, 0.5), entry(78, 0.3, 'codex')]);
    expect(gaps.map((gap) => gap.provider)).toEqual(['claude']);
  });
});

describe('QuotaTimeline forecast rendering', () => {
  test('marks a lane forecast to run out', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaTimeline, {
        entries: [{ file: { name: 'max.json', type: 'claude' }, type: 'claude' }],
        displayNameFor: (name: string) => name,
        resolvedTheme: 'dark' as const,
        now,
        quotaFor: () => ({
          status: 'success',
          windows: [
            {
              label: '7-day',
              usedPercent: 90,
              resetAtMs: now + 0.25 * WEEK_HOURS * HOUR_MS,
              periodHours: WEEK_HOURS,
            },
          ],
        }),
      })
    );

    expect(markup).toContain('data-locked="1"');
    expect(markup).toContain('1.2×');
  });
});
