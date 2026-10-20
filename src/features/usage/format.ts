/**
 * Time and duration wording shared by the usage panels.
 */

import type { TFunction } from 'i18next';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const pad = (value: number) => String(value).padStart(2, '0');

export const formatTime = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const formatDate = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};

export const weekday = (ms: number, t: TFunction) => {
  const key = WEEKDAY_KEYS[new Date(ms).getDay()];
  return t(`quota_management.weekday_${key}`, { defaultValue: key });
};

/** "Oct 13" in the reader's language. */
export const formatMonthDay = (ms: number, language: string | undefined) =>
  new Intl.DateTimeFormat(language || undefined, { month: 'short', day: 'numeric' }).format(ms);

/** Weekday and time within the coming week; the date beyond it. */
export const formatWhen = (ms: number, now: number, t: TFunction) =>
  Math.abs(ms - now) < 6 * DAY_MS
    ? `${weekday(ms, t)} ${formatTime(ms)}`
    : `${formatDate(ms)} ${formatTime(ms)}`;

/** "45 min", "8 h", "1 day 19 h"; `compact` gives "1 d 19 h" for tight tiles. */
export const formatDuration = (ms: number, t: TFunction, compact = false) => {
  if (ms < HOUR_MS) {
    return t('usage.minutes', { count: Math.max(1, Math.round(ms / 60_000)) });
  }
  const hours = Math.round(ms / HOUR_MS);
  if (hours < 24) return t('usage.hours', { count: hours });
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const dayText = t(compact ? 'usage.days_short' : 'usage.days', { count: days });
  return rest === 0 ? dayText : `${dayText} ${t('usage.hours', { count: rest })}`;
};

/** Whole hours for tallies, "<1 h" for a sliver rather than a misleading 0. */
export const formatHours = (ms: number, t: TFunction) =>
  ms <= 0
    ? t('usage.hours', { count: 0 })
    : ms < HOUR_MS
      ? t('usage.under_an_hour')
      : t('usage.hours', { count: Math.round(ms / HOUR_MS) });
