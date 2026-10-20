/**
 * Quota windows timeline.
 *
 * The cards answer "how much is left"; this answers "when does it come back,
 * and does it all come back at once". Four credentials resetting the same
 * evening is a very different position from four staggered across a week, and
 * no per-card percentage shows that.
 *
 * All projection maths lives in quotaTimelineModel.ts — this file is layout
 * only. (The model is named ...Model rather than matching this component,
 * because a case-insensitive filesystem cannot hold both QuotaTimeline.tsx and
 * quotaTimeline.ts.)
 */

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { formatRelativeInstant, TYPE_COLORS } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { useNow } from '@/hooks/useNow';
import type { ResolvedTheme, ThemeColors } from '@/types';
import {
  buildTimelineLane,
  laneHasWindow,
  projectLane,
  projectResetCredits,
  timelineSpan,
  DAY_MS,
} from '../quotaTimelineModel';
import type { TimelineLane, TimelineMode } from '../quotaTimelineModel';
import { forecastLane, providerGaps } from '../quotaForecastModel';
import type { LaneForecast } from '../quotaForecastModel';
import { providerLabel } from '@/features/dashboard/utils';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import styles from './QuotaTimeline.module.scss';

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const pad = (value: number) => String(value).padStart(2, '0');
const formatDay = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};
const formatTime = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

type Translate = ReturnType<typeof useTranslation>['t'];

/** Weekday and time within the coming week, where a date would only slow reading; the date beyond it. */
const formatWhen = (ms: number, now: number, t: Translate) => {
  if (ms - now >= 6 * DAY_MS) return `${formatDay(ms)} ${formatTime(ms)}`;
  const key = WEEKDAY_KEYS[new Date(ms).getDay()];
  return `${t(`quota_management.weekday_${key}`, { defaultValue: key })} ${formatTime(ms)}`;
};

export interface QuotaTimelineProps {
  entries: QuotaFileEntry[];
  /**
   * Quota state for an entry. An entry carries only the file and its provider —
   * loaded quota lives in the store — so the lookup is injected rather than read
   * off the entry, and lanes see exactly what the cards see.
   */
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  displayNameFor: (name: string) => string;
  resolvedTheme: ResolvedTheme;
  /** Injectable for tests/screenshots; defaults to the real clock. */
  now?: number;
  /** Injectable initial zoom for tests/screenshots; defaults to the weekly view. */
  initialMode?: TimelineMode;
  /** Injectable initial date offset for tests/screenshots; defaults to the current period. */
  initialOffset?: number;
}

export function QuotaTimeline({
  entries,
  quotaFor,
  displayNameFor,
  resolvedTheme,
  now: nowProp,
  initialMode = 'weekly',
  initialOffset = 0,
}: QuotaTimelineProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TimelineMode>(initialMode);
  const [offset, setOffset] = useState(initialOffset);

  // The clock has to advance on its own: bars are classified past/live/next
  // against it and the marker is positioned by it, so a long-lived tab would
  // quietly go stale. Shared app-wide so the cards above tick in lockstep with
  // the chart rather than each running its own timer.
  const tick = useNow(nowProp === undefined); // fixed clock: tests and screenshots
  const now = nowProp ?? tick;

  const span = useMemo(() => timelineSpan(mode, offset, now), [mode, offset, now]);
  const todayLabel = t('quota_management.windows_today', { defaultValue: 'Today' });
  // This button doubles as the selected-period indicator and the shortcut back
  // to the current period. Keeping its visible text hard-coded to "Today" made
  // successful previous/next navigation look as though the date never changed.
  const navigationLabel = offset === 0 ? todayLabel : formatDay(span.startMs);

  const laneInputs = useMemo(
    () =>
      entries.map((entry) => ({
        name: getQuotaCacheKey(entry.file),
        displayName:
          entry.type === 'devin'
            ? getQuotaDisplayName(entry.file)
            : displayNameFor(entry.file.name),
        provider: entry.type,
        quota: quotaFor(entry),
      })),
    [entries, quotaFor, displayNameFor]
  );

  // Keep the timeline hidden until at least one loaded credential exposes a
  // real quota window. Once there is timeline data, however, changing zoom must
  // never remove the whole panel just because that mode has no matching lanes.
  const hasAnyLane = useMemo(
    () => laneInputs.some((input) => laneHasWindow(buildTimelineLane(input))),
    [laneInputs]
  );

  const lanes = useMemo(
    () =>
      laneInputs
        .map((input) =>
          buildTimelineLane({
            ...input,
            // Weekly mode prefers the longest readable window. Session mode
            // asks specifically for a real 5-hour window; longer periods must
            // not be reinterpreted as 5-hour resets.
            maxPeriodHours: mode === 'session' ? 5 : span.days * 24,
          })
        )
        .filter((lane) => laneHasWindow(lane) && (mode !== 'session' || lane.periodHours === 5)),
    [laneInputs, mode, span.days]
  );

  const forecasts = useMemo(
    () => lanes.map((lane) => ({ lane, forecast: forecastLane(lane, now) })),
    [lanes, now]
  );
  const gaps = useMemo(() => providerGaps(forecasts), [forecasts]);
  const unknownProvider = t('dashboard.provider_unknown');

  /** Weekly: one cell per day. Session: one per 6 hours. */
  const cells = useMemo(() => {
    const zoomed = mode === 'session';
    const count = zoomed ? span.days * 4 : span.days;
    const cellMs = (span.endMs - span.startMs) / count;
    const todayStart = new Date(now).setHours(0, 0, 0, 0);

    return Array.from({ length: count }, (_, index) => {
      const at = span.startMs + index * cellMs;
      const date = new Date(at);
      const isDayStart = !zoomed || date.getHours() === 0;
      return {
        at,
        isDayStart,
        isToday: new Date(at).setHours(0, 0, 0, 0) === todayStart,
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
        weekday: t(`quota_management.weekday_${WEEKDAY_KEYS[date.getDay()]}`, {
          defaultValue: WEEKDAY_KEYS[date.getDay()],
        }),
        label: isDayStart ? formatDay(at) : `${pad(date.getHours())}:00`,
      };
    });
  }, [mode, span, now, t]);

  // Only draw the marker when the current moment is actually on screen.
  const nowPercent =
    now >= span.startMs && now < span.endMs
      ? ((now - span.startMs) / (span.endMs - span.startMs)) * 100
      : null;

  if (!hasAnyLane) return null;

  return (
    <section className={styles.timeline}>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>
            {t('quota_management.windows_title', { defaultValue: 'Quota windows' })}
          </h2>
          <p className={styles.range}>
            {formatDay(span.startMs)} – {formatDay(span.endMs - DAY_MS)}
            {' · '}
            {mode === 'weekly'
              ? t('quota_management.windows_span_weekly', { defaultValue: 'two weeks' })
              : t('quota_management.windows_span_session', { defaultValue: 'three days' })}
            {offset === 0 &&
              ` · ${t('quota_management.windows_current', { defaultValue: 'current' })}`}
          </p>
          {gaps.map((gap) => (
            <p key={gap.provider} className={styles.gap}>
              {gap.fromMs <= now
                ? t('quota_management.windows_forecast_gap_now', {
                    defaultValue: 'No {{provider}} account free until {{to}}',
                    provider: providerLabel(gap.provider, unknownProvider),
                    to: formatWhen(gap.toMs, now, t),
                  })
                : t('quota_management.windows_forecast_gap', {
                    defaultValue: 'No {{provider}} account free {{from}} – {{to}}',
                    provider: providerLabel(gap.provider, unknownProvider),
                    from: formatWhen(gap.fromMs, now, t),
                    to: formatWhen(gap.toMs, now, t),
                  })}
            </p>
          ))}
        </div>

        <div className={styles.controls}>
          <div className={styles.nav}>
            <button
              type="button"
              onClick={() => setOffset((value) => value - 1)}
              aria-label={t('quota_management.windows_prev', { defaultValue: 'Previous' })}
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => setOffset(0)}
              disabled={offset === 0}
              aria-label={todayLabel}
              title={offset === 0 ? undefined : todayLabel}
            >
              {navigationLabel}
            </button>
            <button
              type="button"
              onClick={() => setOffset((value) => value + 1)}
              aria-label={t('quota_management.windows_next', { defaultValue: 'Next' })}
            >
              ›
            </button>
          </div>

          <div className={styles.modes} role="group">
            {(['weekly', 'session'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  setOffset(0); // spans differ in size; an old offset means nothing
                }}
              >
                {value === 'weekly'
                  ? t('quota_management.windows_mode_weekly', { defaultValue: 'Weekly' })
                  : t('quota_management.windows_mode_session', { defaultValue: '5-hour' })}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className={styles.chart}>
        {lanes.length === 0 ? (
          <div className={styles.empty} role="status">
            {t('quota_management.windows_empty_session', {
              defaultValue: 'No credentials on this page report a 5-hour quota window.',
            })}
          </div>
        ) : (
          <>
            <div className={styles.axis}>
              <div className={styles.axisLabel}>
                {t('quota_management.windows_credential', { defaultValue: 'Credential' })}
              </div>
              <div className={styles.axisCells}>
                {cells.map((cell) => (
                  <div
                    key={cell.at}
                    className={styles.axisCell}
                    data-today={cell.isToday ? 1 : 0}
                    data-weekend={cell.isWeekend ? 1 : 0}
                    data-daystart={cell.isDayStart ? 1 : 0}
                  >
                    <span className={styles.axisWeekday}>
                      {cell.isDayStart ? cell.weekday : ''}
                    </span>
                    <span className={styles.axisDate}>{cell.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {forecasts.map(({ lane, forecast }) => (
              <Lane
                key={lane.name}
                lane={lane}
                forecast={forecast}
                span={span}
                now={now}
                mode={mode}
                cells={cells}
                nowPercent={nowPercent}
                resolvedTheme={resolvedTheme}
              />
            ))}
          </>
        )}
      </div>

      {lanes.length > 0 && (
        <footer className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.swatchLive}`} />
            {t('quota_management.windows_legend_current', { defaultValue: 'current window' })}
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.swatchNext}`} />
            {t('quota_management.windows_legend_upcoming', { defaultValue: 'upcoming' })}
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.swatchPast}`} />
            {t('quota_management.windows_legend_elapsed', { defaultValue: 'elapsed' })}
          </span>
          <span className={styles.legendItem}>
            <span className={styles.swatchCredit} />
            {t('quota_management.windows_legend_reset_credit', {
              defaultValue: 'manual reset expiry',
            })}
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.swatchLocked}`} />
            {t('quota_management.windows_legend_locked', {
              defaultValue: 'locked until reset (forecast)',
            })}
          </span>
          <span className={styles.legendNote}>
            {mode === 'weekly'
              ? t('quota_management.windows_note_weekly', {
                  defaultValue:
                    'Each bar is one full quota window, drawn from when it opened to when it resets. Lanes ending together compete for the same days.',
                })
              : t('quota_management.windows_note_session', {
                  defaultValue:
                    'Each bar is one 5-hour window. Only credentials with a window counting down can be projected; the rest stay empty rather than invented.',
                })}
          </span>
        </footer>
      )}
    </section>
  );
}

interface LaneProps {
  lane: TimelineLane;
  forecast: LaneForecast | null;
  span: { startMs: number; endMs: number; days: number };
  now: number;
  mode: TimelineMode;
  cells: { at: number; isWeekend: boolean; isDayStart: boolean }[];
  nowPercent: number | null;
  resolvedTheme: ResolvedTheme;
}

function Lane({ lane, forecast, span, now, mode, cells, nowPercent, resolvedTheme }: LaneProps) {
  const { t, i18n } = useTranslation();

  // The forecast lock drawn over the current window, clipped to the span.
  const toSpanPercent = (ms: number) => ((ms - span.startMs) / (span.endMs - span.startMs)) * 100;
  const lock =
    forecast && forecast.kind !== 'holds'
      ? {
          left: Math.max(0, toSpanPercent(forecast.lockedFromMs)),
          right: Math.min(100, toSpanPercent(forecast.resetMs)),
          title: t('quota_management.windows_forecast_locked', {
            defaultValue: 'Locked {{from}} – {{to}}',
            from: formatWhen(forecast.lockedFromMs, now, t),
            to: formatWhen(forecast.resetMs, now, t),
          }),
        }
      : null;
  const runOutPercent = forecast?.kind === 'runsOut' ? toSpanPercent(forecast.lockedFromMs) : null;

  const forecastText = !forecast
    ? null
    : forecast.kind === 'out'
      ? t('quota_management.windows_forecast_out', {
          defaultValue: 'Out until {{time}}',
          time: formatWhen(forecast.resetMs, now, t),
        })
      : forecast.kind === 'runsOut'
        ? t('quota_management.windows_forecast_runs_out', {
            defaultValue: 'Runs out {{time}}',
            time: formatWhen(forecast.lockedFromMs, now, t),
          })
        : t('quota_management.windows_forecast_holds', {
            defaultValue: '~{{percent}}% used at reset',
            percent: Math.round(forecast.usedAtReset),
          });

  const windows = useMemo(
    () => projectLane(lane, span.startMs, span.endMs, now, mode),
    [lane, span, now, mode]
  );
  const resetCredits = useMemo(
    () => projectResetCredits(lane, span.startMs, span.endMs, now),
    [lane, span, now]
  );

  const colorSet = TYPE_COLORS[lane.provider] || TYPE_COLORS.unknown;
  const color: ThemeColors =
    resolvedTheme === 'dark' && colorSet.dark ? colorSet.dark : colorSet.light;

  // Sub-day windows are labelled in hours — rounding 5h to days gives "0d".
  const periodLabel =
    mode === 'session'
      ? '5h'
      : !lane.periodHours
        ? ''
        : lane.periodHours < 24
          ? `${Math.round(lane.periodHours)}h`
          : `${Math.round(lane.periodHours / 24)}d`;

  return (
    <div className={styles.lane} style={{ '--provider-accent': color.text } as CSSProperties}>
      <div className={styles.laneHead}>
        <div className={styles.laneTop}>
          <span className={styles.laneDot} />
          <span className={styles.laneName} title={lane.displayName}>
            {lane.displayName}
          </span>
          {periodLabel && <span className={styles.lanePeriod}>{periodLabel}</span>}
        </div>
        <div className={styles.laneLimits}>
          {lane.limits.map((limit) => (
            <span key={limit.label} className={styles.laneLimit}>
              {lane.provider === 'meta' ? t(limit.label) : limit.label} <b>{limit.remaining}%</b>
            </span>
          ))}
        </div>
        {forecast && forecastText && (
          <div className={styles.laneForecast} data-locked={forecast.kind === 'holds' ? 0 : 1}>
            {forecastText}
            {forecast.kind !== 'out' && (
              <span
                className={styles.lanePace}
                title={t('quota_management.windows_forecast_pace_hint', {
                  defaultValue:
                    'Use so far compared with an even spread over the window. Above 1× runs out before the reset.',
                })}
              >
                {t('quota_management.windows_forecast_pace', {
                  defaultValue: '{{pace}}× pace',
                  pace: forecast.pace.toFixed(1),
                })}
              </span>
            )}
          </div>
        )}
      </div>

      <div className={styles.track}>
        <div className={styles.trackGrid}>
          {cells.map((cell) => (
            <span
              key={cell.at}
              data-weekend={cell.isWeekend ? 1 : 0}
              data-daystart={cell.isDayStart ? 1 : 0}
            />
          ))}
        </div>

        {nowPercent !== null && (
          <div className={styles.nowLine} style={{ left: `${nowPercent}%` }} />
        )}

        {windows.length === 0 ? (
          <span className={styles.laneIdle}>
            {t('quota_management.windows_idle', {
              defaultValue: 'no window counting down',
            })}
          </span>
        ) : (
          windows.map((window) => {
            // A label needs room to read; below that the bar speaks for itself
            // and the detail lives in the tooltip.
            const showLabel = window.widthPercent > (mode === 'session' ? 4.5 : 9);
            const endText =
              mode === 'session'
                ? formatTime(window.endMs)
                : `${formatDay(window.endMs)} ${formatTime(window.endMs)}`;

            return (
              <div
                key={window.startMs}
                className={`${styles.window} ${styles[`window${capitalize(window.state)}`]}`}
                style={{ left: `${window.leftPercent}%`, width: `${window.widthPercent}%` }}
                title={`${lane.displayName}\n${formatDay(window.startMs)} ${formatTime(
                  window.startMs
                )} → ${formatDay(window.endMs)} ${formatTime(window.endMs)}${
                  window.remaining !== null ? `\n${window.remaining}% remaining` : ''
                }`}
              >
                {/* Only the API-reported current window has meaningful usage;
                    projected windows intentionally have no fill. */}
                {window.remaining !== null && (
                  <span
                    className={styles.windowFill}
                    style={{ width: `${100 - window.remaining}%` }}
                  />
                )}
                {showLabel && (
                  <span className={styles.windowLabel}>
                    {window.remaining !== null ? `${window.remaining}% · ` : ''}
                    {endText}
                  </span>
                )}
              </div>
            );
          })
        )}

        {lock && lock.right > lock.left && (
          <span
            className={styles.locked}
            style={{ left: `${lock.left}%`, width: `${lock.right - lock.left}%` }}
            title={lock.title}
            role="img"
            aria-label={lock.title}
          />
        )}
        {runOutPercent !== null && runOutPercent >= 0 && runOutPercent <= 100 && (
          <span className={styles.runOutDot} style={{ left: `${runOutPercent}%` }} />
        )}

        {resetCredits.map((credit, index) => {
          const grantedLabel = t('quota_management.windows_credit_granted', {
            defaultValue: 'Granted',
          });
          const expiresLabel = t('quota_management.windows_credit_expires', {
            defaultValue: 'Expires',
          });
          const title = [
            t('quota_management.windows_reset_credit', { defaultValue: 'Manual reset' }),
            credit.grantedAtMs !== null
              ? `${grantedLabel}: ${formatDay(credit.grantedAtMs)} ${formatTime(credit.grantedAtMs)}`
              : null,
            `${expiresLabel}: ${formatDay(credit.expiresAtMs)} ${formatTime(credit.expiresAtMs)}`,
            formatRelativeInstant(credit.expiresAtMs, now, i18n.resolvedLanguage),
          ]
            .filter((line): line is string => line !== null)
            .join('\n');

          return (
            <span
              key={credit.id || `${credit.expiresAtMs}-${index}`}
              className={styles.resetCreditTick}
              style={{ left: `${credit.leftPercent}%` }}
              title={title}
              role="img"
              aria-label={title.split('\n').join(', ')}
            />
          );
        })}
      </div>
    </div>
  );
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
