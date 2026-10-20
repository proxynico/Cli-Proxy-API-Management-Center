/**
 * Usage forecast and weekly cover, from the history the mini's usage recorder
 * keeps (usage-recorder/recorder.ts).
 *
 * Pure functions with `now` always passed in. A series is change points: the
 * recorder keeps a reading when it changes and at least every heartbeat, so a
 * reading holds until the next one, and a silence longer than the heartbeat
 * means the recorder was down rather than nothing changed.
 */

import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

export type UsageProvider = 'claude' | 'codex' | 'xai';
export type WindowId = '5h' | '7d';
/** [reading time ms, percent used, reset time ms] */
export type Point = readonly [number, number, number];

export interface UsageAccount {
  provider: UsageProvider;
  email: string;
  lastReadingAt: number | null;
  lastError: string | null;
}

export interface UsageHistory {
  version: 1;
  updatedAt: number;
  pollMinutes: number;
  heartbeatMinutes: number;
  accounts: Record<string, UsageAccount>;
  series: Record<string, Partial<Record<WindowId, Point[]>>>;
}

const MINUTE_MS = 60_000;
export const WEEK_MS = 7 * DAY_MS;
export const CELL_MS = 6 * HOUR_MS;
/** Sampling step for cover: fine enough that a short gap still shows. */
const STEP_MS = 10 * MINUTE_MS;

/** Weekdays 09:00 to 19:00, local time. */
export const WORK_HOURS = { firstDay: 1, lastDay: 5, startHour: 9, endHour: 19 } as const;

export const isWorkTime = (ms: number) => {
  const date = new Date(ms);
  const day = date.getDay();
  const hour = date.getHours();
  return (
    day >= WORK_HOURS.firstDay &&
    day <= WORK_HOURS.lastDay &&
    hour >= WORK_HOURS.startHour &&
    hour < WORK_HOURS.endHour
  );
};

export const PROVIDER_ORDER: UsageProvider[] = ['claude', 'codex', 'xai'];
export const PROVIDER_NAMES: Record<UsageProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  xai: 'Grok',
};

/* ------------------------------------------------------------ parsing */

const isProvider = (value: unknown): value is UsageProvider =>
  value === 'claude' || value === 'codex' || value === 'xai';

const isPoint = (value: unknown): value is Point =>
  Array.isArray(value) && value.length === 3 && value.every((n) => Number.isFinite(n));

/** Narrow the recorder's JSON; drops anything malformed rather than trusting it. */
export function parseUsageHistory(value: unknown): UsageHistory | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;

  const accounts: UsageHistory['accounts'] = {};
  for (const [name, entry] of Object.entries((raw.accounts ?? {}) as Record<string, unknown>)) {
    const account = entry as Record<string, unknown>;
    if (!isProvider(account?.provider)) continue;
    accounts[name] = {
      provider: account.provider,
      email: typeof account.email === 'string' ? account.email : name,
      lastReadingAt: typeof account.lastReadingAt === 'number' ? account.lastReadingAt : null,
      lastError: typeof account.lastError === 'string' ? account.lastError : null,
    };
  }

  const series: UsageHistory['series'] = {};
  for (const [name, entry] of Object.entries((raw.series ?? {}) as Record<string, unknown>)) {
    if (!accounts[name] || !entry || typeof entry !== 'object') continue;
    const windows: Partial<Record<WindowId, Point[]>> = {};
    for (const id of ['5h', '7d'] as const) {
      const points = (entry as Record<string, unknown>)[id];
      if (Array.isArray(points)) windows[id] = points.filter(isPoint);
    }
    series[name] = windows;
  }

  const number = (key: string, fallback: number) =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? (raw[key] as number) : fallback;

  return {
    version: 1,
    updatedAt: number('updatedAt', 0),
    pollMinutes: number('pollMinutes', 5),
    heartbeatMinutes: number('heartbeatMinutes', 30),
    accounts,
    series,
  };
}

/* ------------------------------------------------------------ readings */

/** A reading older than this before `t` says nothing about `t`: the recorder was down. */
export const staleAfterMs = (history: UsageHistory) =>
  (history.heartbeatMinutes + 2 * history.pollMinutes) * MINUTE_MS;

/** The reading in force at `t`, or null when there is none or it went stale. */
export function readingAt(points: readonly Point[], t: number, staleMs: number): Point | null {
  let low = 0;
  let high = points.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (points[mid][0] <= t) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found < 0) return null;
  const point = points[found];
  return t - point[0] > staleMs ? null : point;
}

/** Percent used at `t`; a window that reset after its reading starts again from zero. */
export function usedAt(points: readonly Point[], t: number, staleMs: number): number | null {
  const point = readingAt(points, t, staleMs);
  if (!point) return null;
  return t >= point[2] ? 0 : point[1];
}

/** Whether an account has nothing left at `t`: any window at 100%. Null with no reading. */
export function lockedAt(
  series: Partial<Record<WindowId, Point[]>> | undefined,
  t: number,
  staleMs: number
): boolean | null {
  let known = false;
  for (const points of Object.values(series ?? {})) {
    const used = usedAt(points ?? [], t, staleMs);
    if (used === null) continue;
    known = true;
    if (used >= 100) return true;
  }
  return known ? false : null;
}

/* ------------------------------------------------------------ accounts */

export interface AccountView {
  name: string;
  provider: UsageProvider;
  email: string;
  label: string;
}

const planOf = (name: string) => {
  const match = /-(pro|plus|team|max)\.json$/i.exec(name);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase() : '';
};

const shortEmail = (email: string) => {
  const [local, domain = ''] = email.split('@');
  return domain === 'gmail.com' ? 'gmail' : domain || local;
};

/** Accounts in provider order, named the way they're told apart: by provider, then by email. */
export function accountViews(history: UsageHistory): AccountView[] {
  const views: AccountView[] = [];
  for (const provider of PROVIDER_ORDER) {
    const names = Object.keys(history.accounts)
      .filter((name) => history.accounts[name].provider === provider)
      .sort(
        (a, b) =>
          shortEmail(history.accounts[a].email).localeCompare(
            shortEmail(history.accounts[b].email)
          ) || history.accounts[a].email.localeCompare(history.accounts[b].email)
      );
    const shorts = names.map((name) => shortEmail(history.accounts[name].email));
    names.forEach((name, index) => {
      const email = history.accounts[name].email;
      const clash = shorts.filter((short) => short === shorts[index]).length > 1;
      const tag = names.length === 1 ? planOf(name) : clash ? email.split('@')[0] : shorts[index];
      views.push({
        name,
        provider,
        email,
        label: [PROVIDER_NAMES[provider], tag].filter(Boolean).join(' '),
      });
    });
  }
  return views;
}

/* ------------------------------------------------------------ forecast */

export type ForecastKind = 'out' | 'runsOut' | 'holds';

export interface AccountForecast {
  account: AccountView;
  used: number;
  startMs: number;
  resetMs: number;
  /** Percent used over percent of the window gone; 1 spends the window evenly. */
  pace: number;
  /** Percent per millisecond the projection carries forward. */
  rate: number;
  kind: ForecastKind;
  runOutMs: number | null;
  /** How long it stays locked before the reset. */
  lockedMs: number;
  usedAtReset: number;
  /** Percentage points a day still affordable until the reset. */
  allowedPerDay: number;
  /** Readings in the current window, oldest first. */
  points: Point[];
}

/** Recent pace needs this much recorded span; below it the window average is all there is. */
const RECENT_MIN_MS = 6 * HOUR_MS;

/**
 * Forecast an account's weekly window at the pace of the last day.
 *
 * The last day, not the window average, because cover moves: when one account
 * runs out the other takes all the traffic, and its average since the window
 * opened would understate that for days.
 */
export function forecastAccount(
  history: UsageHistory,
  account: AccountView,
  now: number
): AccountForecast | null {
  const all = history.series[account.name]?.['7d'] ?? [];
  const last = readingAt(all, now, staleAfterMs(history));
  if (!last || last[2] <= now) return null;

  const resetMs = last[2];
  const startMs = resetMs - WEEK_MS;
  const points = all.filter((point) => point[2] === resetMs);
  const used = last[1];
  const elapsed = Math.max(now - startMs, 1);
  const pace = used / ((elapsed / WEEK_MS) * 100);

  const firstAt = points[0]?.[0] ?? now;
  let rate = used / elapsed;
  if (now - firstAt >= RECENT_MIN_MS) {
    const from = Math.max(now - DAY_MS, firstAt);
    const before = readingAt(points, from, Infinity) ?? points[0];
    rate = Math.max(0, (used - before[1]) / (now - from));
  }

  const remaining = Math.max(0, 100 - used);
  const left = resetMs - now;
  const base = {
    account,
    used,
    startMs,
    resetMs,
    pace,
    rate,
    points,
    allowedPerDay: remaining / (left / DAY_MS),
  };

  if (used >= 100) {
    return { ...base, kind: 'out', runOutMs: null, lockedMs: left, usedAtReset: 100 };
  }
  const runOutMs = rate > 0 ? now + remaining / rate : Infinity;
  if (runOutMs < resetMs) {
    return { ...base, kind: 'runsOut', runOutMs, lockedMs: resetMs - runOutMs, usedAtReset: 100 };
  }
  return {
    ...base,
    kind: 'holds',
    runOutMs: null,
    lockedMs: 0,
    usedAtReset: Math.min(100, used + rate * left),
  };
}

/** Accounts that run out first lead; then the fullest at reset. */
export function sortForecasts(forecasts: AccountForecast[]): AccountForecast[] {
  const lockStart = (f: AccountForecast) =>
    f.kind === 'out' ? -Infinity : f.kind === 'runsOut' ? (f.runOutMs as number) : Infinity;
  return [...forecasts].sort(
    (a, b) => lockStart(a) - lockStart(b) || b.usedAtReset - a.usedAtReset
  );
}

/** Projected percent used at `t`, or null past the reset, where a new window starts unforecast. */
export function projectedAt(forecast: AccountForecast, now: number, t: number): number | null {
  if (t >= forecast.resetMs) return null;
  if (t <= now) return forecast.used;
  return Math.min(100, forecast.used + forecast.rate * (t - now));
}

export interface DailyPace {
  dayStart: number;
  /** Percentage points used that day, or null with no readings. */
  points: number | null;
}

const startOfLocalDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** Percentage points used per local day over the last `days`, today last. */
export function dailyPace(points: readonly Point[], now: number, days = 7): DailyPace[] {
  const today = startOfLocalDay(now);
  const out: DailyPace[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(today);
    day.setDate(day.getDate() - i);
    out.push({ dayStart: day.getTime(), points: null });
  }
  const indexOf = (ms: number) =>
    out.findIndex((d, i) => ms >= d.dayStart && (i === out.length - 1 || ms < out[i + 1].dayStart));

  for (let i = 1; i < points.length; i += 1) {
    const [prev, next] = [points[i - 1], points[i]];
    const index = indexOf(next[0]);
    if (index < 0) continue;
    // Across a reset the new window's reading is all new use.
    const delta = prev[2] === next[2] ? Math.max(0, next[1] - prev[1]) : next[1];
    out[index].points = (out[index].points ?? 0) + delta;
  }
  for (const point of points) {
    const index = indexOf(point[0]);
    if (index >= 0 && out[index].points === null) out[index].points = 0;
  }
  return out;
}

/* --------------------------------------------------------------- weeks */

export type UseLevel = 0 | 1 | 2 | 3;
export type CellState = 'use' | 'runsOut' | 'locked' | 'none' | 'future';
export type FreeState =
  | 'all'
  | 'some'
  | 'none'
  | 'noneWork'
  | 'unknown'
  | 'future'
  /** Forecast: no account free if the pace holds. */
  | 'forecastNone';

export interface AccountCell {
  start: number;
  state: CellState;
  level: UseLevel;
  /** Fraction 0..1 into the cell where the weekly window resets, if it does. */
  resetAt: number | null;
}

export interface WeekRow {
  weekStart: number;
  isCurrent: boolean;
  hasData: boolean;
  accounts: { account: AccountView; cells: AccountCell[]; peak: number | null }[];
  free: FreeState[];
  noneFreeMs: number;
  noneFreeWorkMs: number;
  /** Work time with at least one account locked and another covering. */
  coveredWorkMs: number;
  /** Time each account was the only one with anything left. */
  soleCoverMs: Record<string, number>;
  /** First stretch with no account free. */
  firstGap: { from: number; to: number } | null;
  /** This week only: work hours with no account free, counting the forecast for the rest. */
  forecastNoneFreeWorkMs: number | null;
  forecastGapFrom: number | null;
}

/** Monday 00:00 local of the week containing `ms`. */
export function startOfWeek(ms: number): number {
  const date = new Date(startOfLocalDay(ms));
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}

const CELLS_PER_WEEK = WEEK_MS / CELL_MS;
const STEPS_PER_CELL = CELL_MS / STEP_MS;

/**
 * Week rows for one provider's accounts, newest last.
 *
 * Each 6-hour cell shows an account's highest weekly use in it; the cover row
 * shows whether any account had room. Past cells come from readings; the rest
 * of the current week comes from each account's forecast.
 */
export function weekRows(
  history: UsageHistory,
  accounts: AccountView[],
  now: number,
  weeks = 5
): WeekRow[] {
  const staleMs = staleAfterMs(history);
  const forecasts = new Map(
    accounts.map((account) => [account.name, forecastAccount(history, account, now)])
  );
  const currentWeek = startOfWeek(now);

  /** Locked at `t`: readings before now, the forecast after. */
  const lockedFor = (account: AccountView, t: number): boolean | null => {
    if (t <= now) return lockedAt(history.series[account.name], t, staleMs);
    const forecast = forecasts.get(account.name);
    if (!forecast) return null;
    if (t >= forecast.resetMs) return false;
    return forecast.kind === 'out' || (forecast.runOutMs !== null && t >= forecast.runOutMs);
  };

  const rows: WeekRow[] = [];
  for (let w = weeks - 1; w >= 0; w -= 1) {
    const start = new Date(currentWeek);
    start.setDate(start.getDate() - 7 * w);
    const weekStart = start.getTime();
    const isCurrent = w === 0;

    let noneFreeMs = 0;
    let noneFreeWorkMs = 0;
    let coveredWorkMs = 0;
    let forecastNoneWork = 0;
    let forecastGapFrom: number | null = null;
    let firstGap: WeekRow['firstGap'] = null;
    let gapOpen = false;
    let hasData = false;
    const soleCoverMs: Record<string, number> = Object.fromEntries(
      accounts.map((a) => [a.name, 0])
    );
    const free: FreeState[] = [];
    const cells = accounts.map(() => [] as AccountCell[]);
    const peaks: (number | null)[] = accounts.map(() => null);

    for (let c = 0; c < CELLS_PER_WEEK; c += 1) {
      const cellStart = weekStart + c * CELL_MS;
      let cellFree: FreeState | null = null;
      let cellForecastNone = false;
      let cellKnown = false;
      let cellAllFree = true;
      const cellUsed = accounts.map(() => null as number | null);
      const cellLocked = accounts.map(() => [] as boolean[]);

      for (let s = 0; s < STEPS_PER_CELL; s += 1) {
        const t = cellStart + s * STEP_MS;
        const future = t > now;
        const locks = accounts.map((account) => lockedFor(account, t));
        if (!future) {
          accounts.forEach((account, i) => {
            const used = usedAt(history.series[account.name]?.['7d'] ?? [], t, staleMs);
            if (used !== null) cellUsed[i] = Math.max(cellUsed[i] ?? 0, used);
            if (locks[i] !== null) cellLocked[i].push(locks[i] as boolean);
          });
        }
        if (locks.some((lock) => lock === null)) continue;
        if (!future) {
          cellKnown = true;
          hasData = true;
        }

        const freeCount = locks.filter((lock) => !lock).length;
        const work = isWorkTime(t);
        if (freeCount === 0) {
          if (future) {
            if (work) forecastNoneWork += STEP_MS;
            forecastGapFrom ??= t;
            cellForecastNone = true;
          } else {
            noneFreeMs += STEP_MS;
            if (work) noneFreeWorkMs += STEP_MS;
            if (!firstGap) firstGap = { from: t, to: t + STEP_MS };
            else if (gapOpen) firstGap.to = t + STEP_MS;
            gapOpen = true;
            cellFree = work || cellFree === 'noneWork' ? 'noneWork' : 'none';
          }
          cellAllFree = false;
        } else {
          if (!future) {
            gapOpen = false;
            if (freeCount < accounts.length && work) coveredWorkMs += STEP_MS;
            if (freeCount === 1 && accounts.length > 1) {
              const sole = accounts[locks.findIndex((lock) => !lock)].name;
              soleCoverMs[sole] += STEP_MS;
            }
          }
          if (freeCount < accounts.length) cellAllFree = false;
        }
      }

      const cellEnd = cellStart + CELL_MS;
      free.push(
        cellStart > now
          ? cellForecastNone
            ? 'forecastNone'
            : 'future'
          : (cellFree ?? (!cellKnown ? 'unknown' : cellAllFree ? 'all' : 'some'))
      );

      accounts.forEach((account, i) => {
        const resets = (history.series[account.name]?.['7d'] ?? [])
          .map((point) => point[2])
          .find((reset) => reset >= cellStart && reset < cellEnd);
        const forecastReset = forecasts.get(account.name)?.resetMs;
        const resetMs =
          resets ??
          (forecastReset && forecastReset >= cellStart && forecastReset < cellEnd
            ? forecastReset
            : null);
        const locks = cellLocked[i];
        const used = cellUsed[i];
        if (used !== null) peaks[i] = Math.max(peaks[i] ?? 0, used);
        const state: CellState =
          cellStart > now
            ? 'future'
            : locks.length === 0 && used === null
              ? 'none'
              : locks.length > 0 && locks.every(Boolean)
                ? 'locked'
                : locks.some(Boolean)
                  ? 'runsOut'
                  : 'use';
        cells[i].push({
          start: cellStart,
          state,
          level: Math.min(3, Math.floor((used ?? 0) / 25)) as UseLevel,
          resetAt: resetMs === null ? null : (resetMs - cellStart) / CELL_MS,
        });
      });
    }

    rows.push({
      weekStart,
      isCurrent,
      hasData,
      accounts: accounts.map((account, i) => ({ account, cells: cells[i], peak: peaks[i] })),
      free,
      noneFreeMs,
      noneFreeWorkMs,
      coveredWorkMs,
      soleCoverMs,
      firstGap,
      forecastNoneFreeWorkMs: isCurrent ? noneFreeWorkMs + forecastNoneWork : null,
      forecastGapFrom: isCurrent ? forecastGapFrom : null,
    });
  }
  return rows;
}

/* ------------------------------------------------------------ hand-off */

export interface HandOffEvent {
  at: number;
  kind: 'ranOut' | 'reset' | 'noneFree' | 'freeAgain';
  account: AccountView | null;
}

/** The moments cover changed hands in a week: who ran out, who reset, when none was left. */
export function handOffEvents(
  history: UsageHistory,
  accounts: AccountView[],
  weekStart: number,
  now: number
): HandOffEvent[] {
  const staleMs = staleAfterMs(history);
  const end = Math.min(weekStart + WEEK_MS, now);
  const events: HandOffEvent[] = [];
  let previous: (boolean | null)[] = accounts.map(() => null);
  let previousNone: boolean | null = null;

  for (let t = weekStart; t <= end; t += STEP_MS) {
    const locks = accounts.map((account) => lockedAt(history.series[account.name], t, staleMs));
    locks.forEach((lock, i) => {
      if (lock === null || previous[i] === null || lock === previous[i]) return;
      events.push({ at: t, kind: lock ? 'ranOut' : 'reset', account: accounts[i] });
    });
    const none = locks.every((lock) => lock === true);
    if (locks.every((lock) => lock !== null) && previousNone !== null && none !== previousNone) {
      events.push({ at: t, kind: none ? 'noneFree' : 'freeAgain', account: null });
    }
    if (locks.every((lock) => lock !== null)) previousNone = none;
    previous = locks;
  }
  return events;
}
