/**
 * Trends: one account's weekly windows side by side, so a run-out creeping
 * earlier week after week shows, with the growth that moves it.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ResolvedTheme } from '@/types';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import {
  CELL_MS,
  PROVIDER_NAMES,
  WEEK_MS,
  forecastAccount,
  projectedAt,
  staleAfterMs,
  usedAt,
  windowsOf,
} from './usageModel';
import type {
  AccountForecast,
  AccountView,
  UsageHistory,
  UseLevel,
  UsageWindow,
} from './usageModel';
import { MIN_TREND_WINDOWS, accountTrend } from './trendsModel';
import type { AccountTrend, WindowTrend } from './trendsModel';
import { formatDuration, formatMonthDay, formatTime, formatWhen, weekday } from './format';
import { AccountSelect, LegendItem, ProviderIcon, Stat } from './parts';
import styles from './UsagePage.module.scss';

interface Props {
  history: UsageHistory;
  accounts: AccountView[];
  now: number;
  theme: ResolvedTheme;
}

/** Rows shown: the latest finished windows and the current one. */
const MAX_ROWS = 8;
const CELLS = WEEK_MS / CELL_MS;
const ALLOWED_PER_DAY = 100 / 7;
const levelOf = (used: number) => Math.min(3, Math.floor(used / 25)) as UseLevel;

interface Entry {
  account: AccountView;
  trend: AccountTrend;
  forecast: AccountForecast | null;
}

export function TrendsPanel({ history, accounts, now, theme }: Props) {
  const { t, i18n } = useTranslation();
  const entries = useMemo<Entry[]>(() => {
    const staleMs = staleAfterMs(history);
    return accounts.map((account) => ({
      account,
      trend: accountTrend(windowsOf(history.series[account.name]?.['7d'] ?? [], now, staleMs), now),
      forecast: forecastAccount(history, account, now),
    }));
  }, [history, accounts, now]);

  // Start on the account with the most run-outs to compare; the most finished weeks after that.
  const ranOutCount = (e: Entry) =>
    e.trend.windows.filter((w) => w.window.lockedFrom !== null).length;
  const finishedCount = (e: Entry) =>
    e.trend.windows.filter((w) => !w.window.current && w.rate !== null).length;
  const fallback = [...entries].sort(
    (a, b) => ranOutCount(b) - ranOutCount(a) || finishedCount(b) - finishedCount(a)
  )[0];
  const [selected, setSelected] = useState<string | null>(null);
  const entry = entries.find((e) => e.account.name === selected) ?? fallback;
  if (!entry) return null;

  const { headline, sub } = trendHeadline(entry, t, i18n.language);
  const rows = entry.trend.windows.slice(-MAX_ROWS);
  const reference = rows[rows.length - 1]?.window.startMs ?? now;

  return (
    <section className={styles.card}>
      <header className={styles.cardHead}>
        <div>
          <h2 className={styles.headline}>{headline}</h2>
          {sub && <p className={styles.subline}>{sub}</p>}
        </div>
        <AccountSelect
          label={t('usage.account')}
          accounts={entries.map((e) => e.account)}
          value={entry.account.name}
          onChange={setSelected}
        />
      </header>

      <div className={styles.layout}>
        <div className={styles.main}>
          <div className={styles.scroller}>
            <div className={styles.forecastGrid}>
              <div className={styles.axisRow}>
                <span className={styles.axisCaption}>{t('usage.trend_window_from')}</span>
                <div className={styles.axisDays}>
                  {Array.from({ length: 7 }, (_, day) => (
                    <span key={day}>{weekday(reference + day * DAY_MS, t)}</span>
                  ))}
                </div>
                <span className={styles.axisCaption}>{t('usage.trend_run_out')}</span>
              </div>
              {rows.length === 0 && (
                <div className={styles.row}>
                  <span className={styles.muted}>{t('usage.no_readings')}</span>
                </div>
              )}
              {rows.map((row, i) => (
                <TrendRow
                  key={row.window.resetMs}
                  row={row}
                  previous={rows
                    .slice(0, i)
                    .reverse()
                    .find((r) => r.ranOutAfterMs !== null)}
                  forecast={row.window.current ? entry.forecast : null}
                  history={history}
                  now={now}
                  t={t}
                  language={i18n.language}
                />
              ))}
            </div>
          </div>
          <footer className={styles.legend}>
            <span className={styles.legendGroup}>
              {t('usage.legend_use')}
              {[0, 1, 2, 3].map((level) => (
                <span key={level} className={styles.cell} data-state="use" data-level={level} />
              ))}
              {t('usage.legend_levels')}
            </span>
            <LegendItem swatch={styles.swatchRunsOut}>{t('usage.legend_runs_out')}</LegendItem>
            <LegendItem swatch={styles.swatchLocked}>{t('usage.legend_locked')}</LegendItem>
            <LegendItem swatch={styles.swatchProjected}>{t('usage.legend_forecast')}</LegendItem>
            <LegendItem swatch={styles.swatchNone}>{t('usage.legend_no_reading')}</LegendItem>
            <span className={styles.legendNote}>{t('usage.trend_note')}</span>
          </footer>
        </div>

        <TrendDetail entry={entry} theme={theme} t={t} language={i18n.language} />
      </div>
    </section>
  );
}

function trendHeadline(entry: Entry, t: TFunction, language: string) {
  const { account, trend } = entry;
  const finished = trend.windows.filter(
    (w) => (!w.window.current || w.window.lockedFrom !== null) && w.rate !== null
  ).length;
  if (trend.idle) {
    return {
      headline: t('usage.trend_headline_idle', { account: account.label }),
      sub: t('usage.trend_sub_idle'),
    };
  }
  if (trend.growth === null) {
    // The current window counts once it ends, if it was read from its start.
    const current = trend.windows.find((w) => w.window.current)?.window;
    const pending = current?.fromStart && current.lockedFrom === null ? 1 : 0;
    const ready = current
      ? current.resetMs + Math.max(0, MIN_TREND_WINDOWS - finished - pending) * WEEK_MS
      : null;
    return {
      headline: t('usage.trend_headline_wait', { count: MIN_TREND_WINDOWS }),
      sub: [
        t('usage.trend_sub_have', { account: account.label, count: finished }),
        ready ? t('usage.trend_sub_ready', { date: formatMonthDay(ready, language) }) : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  const percent = Math.round(Math.abs(trend.growth) * 100);
  const growthText = trend.irregular
    ? t('usage.trend_sub_irregular')
    : percent < 2
      ? t('usage.trend_sub_steady')
      : t(trend.growth > 0 ? 'usage.trend_sub_rises' : 'usage.trend_sub_falls', { percent });
  const projected = trend.projections.find((p) => p.ranOutAfterMs !== null);
  const projectionText = trend.irregular
    ? ''
    : projected
      ? t('usage.trend_sub_projected', {
          time: `${weekday(projected.startMs + (projected.ranOutAfterMs as number), t)} ${formatTime(projected.startMs + (projected.ranOutAfterMs as number))}`,
          date: formatMonthDay(projected.startMs, language),
        })
      : t('usage.trend_sub_lasts');

  const moved = trend.movedMs;
  const headline =
    moved !== null && Math.abs(moved) >= HOUR_MS
      ? t(moved < 0 ? 'usage.trend_headline_earlier' : 'usage.trend_headline_later', {
          account: account.label,
          duration: formatDuration(Math.abs(moved), t),
          count: trend.movedWeeks,
        })
      : trend.irregular
        ? t('usage.trend_headline_irregular', { account: account.label })
        : percent < 2
          ? t('usage.trend_headline_steady', { account: account.label })
          : t(trend.growth > 0 ? 'usage.trend_headline_more' : 'usage.trend_headline_less', {
              account: account.label,
              percent,
            });
  return { headline, sub: [growthText, projectionText].filter(Boolean).join(' ') };
}

/* --------------------------------------------------------------- rows */

interface TrendCell {
  start: number;
  state: 'use' | 'runsOut' | 'locked' | 'none' | 'next';
  level: UseLevel;
  projected: boolean;
}

function windowCells(
  w: UsageWindow,
  forecast: AccountForecast | null,
  now: number,
  staleMs: number
): TrendCell[] {
  return Array.from({ length: CELLS }, (_, c) => {
    const start = w.startMs + c * CELL_MS;
    const end = start + CELL_MS;
    if (start >= w.endMs) return { start, state: 'next', level: 0, projected: false };
    if (w.current && start >= now) {
      if (!forecast) return { start, state: 'none', level: 0, projected: true };
      const lockFrom = forecast.kind === 'out' ? now : forecast.runOutMs;
      const state =
        lockFrom !== null && lockFrom < end ? (lockFrom >= start ? 'runsOut' : 'locked') : 'use';
      const value = projectedAt(forecast, now, Math.min(end, forecast.resetMs)) ?? 0;
      return { start, state, level: levelOf(value), projected: true };
    }
    const inside = w.points.filter((p) => p[0] >= start && p[0] < end).map((p) => p[1]);
    const before = usedAt(w.points, start, staleMs);
    const values = before === null ? inside : [before, ...inside];
    if (values.length === 0) return { start, state: 'none', level: 0, projected: false };
    const state =
      w.lockedFrom !== null && w.lockedFrom <= start
        ? 'locked'
        : w.ranOutAt !== null && w.ranOutAt < end
          ? 'runsOut'
          : w.lockedFrom !== null && w.lockedFrom < end
            ? 'locked'
            : 'use';
    return { start, state, level: levelOf(Math.max(...values)), projected: false };
  });
}

function TrendRow({
  row,
  previous,
  forecast,
  history,
  now,
  t,
  language,
}: {
  row: WindowTrend;
  previous: WindowTrend | undefined;
  forecast: AccountForecast | null;
  history: UsageHistory;
  now: number;
  t: TFunction;
  language: string;
}) {
  const w = row.window;
  const cells = windowCells(w, forecast, now, staleAfterMs(history));
  const toPercent = (ms: number) => ((ms - w.startMs) / WEEK_MS) * 100;
  const projectedRunOut = w.current && forecast?.kind === 'runsOut' ? forecast.runOutMs : null;
  const dotAt = w.ranOutAt ?? projectedRunOut;
  const offset = dotAt !== null ? dotAt - w.startMs : null;
  const change =
    offset !== null && previous && previous.ranOutAfterMs !== null && w.fromStart
      ? offset - previous.ranOutAfterMs
      : null;
  const changeText =
    change === null
      ? null
      : Math.abs(change) < HOUR_MS
        ? t('usage.trend_same_time')
        : t(change < 0 ? 'usage.trend_earlier' : 'usage.trend_later', {
            duration: formatDuration(Math.abs(change), t, true),
          });

  return (
    <div className={styles.row} data-current={w.current ? 1 : 0}>
      <span className={styles.weekLabel} data-static="1">
        <span>{formatMonthDay(w.startMs, language)}</span>
        <small>
          {w.current
            ? t('usage.this_window')
            : !w.fromStart
              ? t('usage.from_time', { time: formatWhen(w.firstAt, now, t) })
              : w.endedEarly
                ? t('usage.past_window_early')
                : ''}
        </small>
      </span>
      <div className={styles.track} data-static="1">
        {cells.map((cell) => (
          <span
            key={cell.start}
            className={styles.cell}
            data-state={cell.state}
            data-level={cell.level}
            data-projected={cell.projected ? 1 : 0}
          />
        ))}
        {w.current && now < w.endMs && (
          <span className={styles.nowTick} style={{ left: `${toPercent(now)}%` }} />
        )}
        {w.endedEarly && (
          <span
            className={styles.resetTick}
            style={{ left: `${toPercent(w.endMs)}%` }}
            data-flip="1"
          >
            <span>{t('usage.reset')}</span>
          </span>
        )}
        {dotAt !== null && (
          <span
            className={styles.runOutDot}
            data-projected={w.ranOutAt === null ? 1 : 0}
            style={{ left: `${toPercent(dotAt)}%` }}
          />
        )}
      </div>
      <span className={styles.rowSummary}>
        {w.ranOutAt !== null ? (
          <>
            <b data-tone="danger">
              {t('usage.trend_ran_out', { time: formatWhen(w.ranOutAt, now, t) })}
            </b>
            <span className={styles.muted}>
              {changeText ??
                t('usage.locked_for', { duration: formatDuration(w.endMs - w.ranOutAt, t, true) })}
            </span>
          </>
        ) : w.lockedFrom !== null ? (
          <>
            <b data-tone="danger">
              {w.current
                ? t('usage.out_until', { time: formatWhen(w.endMs, now, t) })
                : t('usage.past_hit')}
            </b>
            <span className={styles.muted}>{t('usage.ran_out_unread')}</span>
          </>
        ) : w.current ? (
          forecast?.kind === 'runsOut' ? (
            <>
              <b>
                {t('usage.trend_on_pace', {
                  time: formatWhen(forecast.runOutMs as number, now, t),
                })}
              </b>
              <span className={styles.muted}>
                {[changeText, t('usage.legend_forecast').toLowerCase()].filter(Boolean).join(' · ')}
              </span>
            </>
          ) : (
            <>
              <span>
                {forecast
                  ? t('usage.at_reset', { percent: Math.round(forecast.usedAtReset) })
                  : '–'}
              </span>
              <span className={styles.muted}>{t('usage.legend_forecast')}</span>
            </>
          )
        ) : (
          <>
            <span>{t('usage.trend_peaked', { peak: Math.round(w.peak) })}</span>
            <span className={styles.muted}>
              {w.toEnd
                ? t('usage.trend_left', { left: Math.round(100 - w.peak) })
                : t('usage.no_reading')}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------- detail */

/** Every few slots and the last one, skipping a step label that would crowd the last. */
const labelAt = (i: number, count: number) => {
  const step = Math.ceil(count / 6);
  return i === count - 1 || (i % step === 0 && count - 1 - i >= step);
};

const RUN = { width: 360, height: 190, left: 40, right: 12, top: 18, bottom: 26 };
const BARS = { width: 360, height: 150, left: 8, right: 8, top: 22, bottom: 24 };

function TrendDetail({
  entry,
  theme,
  t,
  language,
}: {
  entry: Entry;
  theme: ResolvedTheme;
  t: TFunction;
  language: string;
}) {
  const { account, trend, forecast } = entry;
  const windows = trend.windows.slice(-MAX_ROWS);
  // Until a window has a measured rate or run-out, the charts would be empty axes.
  const charted = windows.some((w) => w.rate !== null || w.ranOutAfterMs !== null);
  const percent = trend.growth === null ? null : Math.round(trend.growth * 100);

  return (
    <aside className={styles.detail}>
      <div className={styles.detailHead}>
        <ProviderIcon provider={account.provider} theme={theme} size={26} />
        <div>
          <h3>{account.label}</h3>
          <p>{`${PROVIDER_NAMES[account.provider]} · ${account.email}`}</p>
        </div>
      </div>

      {charted ? (
        <RunOutChart
          windows={windows}
          forecast={forecast}
          projections={trend.projections}
          t={t}
          language={language}
        />
      ) : (
        <p className={styles.detailLead}>{t('usage.trend_charts_wait')}</p>
      )}

      <div className={styles.stats} data-columns="2">
        <Stat
          label={t('usage.stat_growth')}
          value={
            percent === null || trend.irregular
              ? '–'
              : t('usage.growth_value', { sign: percent > 0 ? '+' : '', percent })
          }
        />
        <Stat
          label={t(
            trend.movedMs !== null && trend.movedMs > 0
              ? 'usage.stat_moved_later'
              : 'usage.stat_moved_earlier'
          )}
          value={
            trend.movedMs === null
              ? '–'
              : Math.abs(trend.movedMs) < HOUR_MS
                ? '0'
                : formatDuration(Math.abs(trend.movedMs), t, true)
          }
          tone={trend.movedMs !== null && trend.movedMs <= -HOUR_MS ? 'danger' : undefined}
        />
      </div>

      {charted && (
        <RateBars windows={windows} projections={trend.projections} t={t} language={language} />
      )}
    </aside>
  );
}

function RunOutChart({
  windows,
  forecast,
  projections,
  t,
  language,
}: {
  windows: WindowTrend[];
  forecast: AccountForecast | null;
  projections: AccountTrend['projections'];
  t: TFunction;
  language: string;
}) {
  const plotW = RUN.width - RUN.left - RUN.right;
  const plotH = RUN.height - RUN.top - RUN.bottom;
  const measured = windows.map((w) => ({
    startMs: w.window.startMs,
    offset:
      w.ranOutAfterMs ??
      (w.window.current && forecast?.kind === 'runsOut'
        ? (forecast.runOutMs as number) - w.window.startMs
        : null),
    projected: w.window.current && w.window.lockedFrom === null,
    hit: w.window.lockedFrom !== null,
  }));
  const ahead = projections.map((p) => ({
    startMs: p.startMs,
    offset: p.ranOutAfterMs,
    projected: true,
    hit: false,
  }));
  const all = [...measured, ...ahead];
  const offsets = all.map((p) => p.offset).filter((o): o is number => o !== null);
  if (all.length === 0) return null;

  const minDay = offsets.length ? Math.max(0, Math.floor(Math.min(...offsets) / DAY_MS - 0.25)) : 4;
  const top = 7;
  const slot = plotW / Math.max(all.length, 2);
  const x = (i: number) => RUN.left + slot * i + slot / 2;
  const y = (offsetMs: number) =>
    RUN.top + plotH - ((offsetMs / DAY_MS - minDay) / (top - minDay)) * plotH;
  const reference = windows[windows.length - 1]?.window.startMs ?? 0;
  // Measured points draw solid; from the last of them on, the line is a forecast.
  const solidEnd = Math.max(0, all.map((p) => !p.projected).lastIndexOf(true));
  const days = Array.from({ length: top - minDay + 1 }, (_, i) => minDay + i);
  const line = (points: typeof all, from: number) =>
    points
      .map((p, i) => (p.offset === null ? null : `${x(from + i)},${y(p.offset)}`))
      .filter(Boolean)
      .join(' ');

  return (
    <div className={styles.subChart} data-flush="1">
      <h4>
        {t('usage.run_out_time')} <span>· {t('usage.run_out_time_unit')}</span>
      </h4>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${RUN.width} ${RUN.height}`}
        role="img"
        aria-label={t('usage.run_out_time')}
      >
        {days.map((day) => (
          <g key={day}>
            <line
              className={styles.gridLine}
              x1={RUN.left}
              x2={RUN.width - RUN.right}
              y1={y(day * DAY_MS)}
              y2={y(day * DAY_MS)}
            />
            <text
              className={styles.axisText}
              x={RUN.left - 6}
              y={y(day * DAY_MS) + 3.5}
              textAnchor="end"
            >
              {day === 7 ? t('usage.reset') : weekday(reference + day * DAY_MS, t)}
            </text>
          </g>
        ))}
        <polyline
          className={styles.accountLine}
          points={line(all.slice(0, solidEnd + 1), 0)}
          fill="none"
        />
        {all.length - solidEnd > 1 && (
          <polyline
            className={styles.paceLine}
            points={line(all.slice(solidEnd), solidEnd)}
            fill="none"
          />
        )}
        {all.map((p, i) =>
          p.offset === null && p.hit ? null : p.offset === null ? (
            <circle key={p.startMs} className={styles.lastedDot} cx={x(i)} cy={y(7 * DAY_MS)} r={3}>
              <title>{t('usage.trend_lasted')}</title>
            </circle>
          ) : (
            <circle
              key={p.startMs}
              className={p.projected ? styles.projectedDot : styles.measuredDot}
              cx={x(i)}
              cy={y(p.offset)}
              r={p.projected ? 3.5 : 4}
            >
              <title>{`${formatMonthDay(p.startMs, language)}: ${weekday(p.startMs + p.offset, t)} ${formatTime(p.startMs + p.offset)}`}</title>
            </circle>
          )
        )}
        {all.map((p, i) =>
          labelAt(i, all.length) ? (
            <text
              key={p.startMs}
              className={styles.axisText}
              x={x(i)}
              y={RUN.height - 6}
              textAnchor="middle"
            >
              {formatMonthDay(p.startMs, language)}
            </text>
          ) : null
        )}
      </svg>
      <div className={styles.legend}>
        <LegendItem swatch={styles.swatchMeasured}>{t('usage.legend_measured')}</LegendItem>
        <LegendItem swatch={styles.swatchPace}>{t('usage.legend_trend_holds')}</LegendItem>
        <LegendItem swatch={styles.swatchLasted}>{t('usage.trend_lasted')}</LegendItem>
      </div>
    </div>
  );
}

function RateBars({
  windows,
  projections,
  t,
  language,
}: {
  windows: WindowTrend[];
  projections: AccountTrend['projections'];
  t: TFunction;
  language: string;
}) {
  const bars = [
    ...windows.map((w) => ({
      startMs: w.window.startMs,
      rate: w.rate,
      projected: false,
      current: w.window.current,
    })),
    ...projections.map((p) => ({
      startMs: p.startMs,
      rate: p.rate as number | null,
      projected: true,
      current: false,
    })),
  ];
  const plotW = BARS.width - BARS.left - BARS.right;
  const plotH = BARS.height - BARS.top - BARS.bottom;
  const max = Math.max(ALLOWED_PER_DAY * 1.4, ...bars.map((b) => b.rate ?? 0));
  const slot = plotW / Math.max(bars.length, 1);
  const barW = Math.min(26, slot * 0.6);
  const y = (value: number) => BARS.top + plotH - (value / max) * plotH;

  return (
    <div className={styles.subChart}>
      <h4>
        {t('usage.rate_title')} <span>· {t('usage.rate_unit')}</span>
      </h4>
      <p className={styles.subChartLead}>
        {t('usage.rate_allowed', { value: ALLOWED_PER_DAY.toFixed(1) })}
      </p>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${BARS.width} ${BARS.height}`}
        role="img"
        aria-label={t('usage.rate_title')}
      >
        {bars.map((bar, i) => {
          const cx = BARS.left + slot * i + slot / 2;
          const label = labelAt(i, bars.length) ? formatMonthDay(bar.startMs, language) : '';
          if (bar.rate === null) {
            return (
              <g key={bar.startMs}>
                <text
                  className={styles.axisTextMuted}
                  x={cx}
                  y={BARS.top + plotH - 4}
                  textAnchor="middle"
                >
                  –
                </text>
                <text className={styles.axisText} x={cx} y={BARS.height - 6} textAnchor="middle">
                  {label}
                </text>
              </g>
            );
          }
          const top = y(bar.rate);
          const over = bar.rate > ALLOWED_PER_DAY;
          return (
            <g key={bar.startMs}>
              <rect
                className={over ? styles.barOver : styles.barWithin}
                data-projected={bar.projected || bar.current ? 1 : 0}
                x={cx - barW / 2}
                y={top}
                width={barW}
                height={Math.max(1, BARS.top + plotH - top)}
                rx={3}
              >
                <title>{`${formatMonthDay(bar.startMs, language)}: ${bar.rate.toFixed(1)} ${t('usage.rate_unit')}`}</title>
              </rect>
              <text className={styles.barValue} x={cx} y={top - 5} textAnchor="middle">
                {`${bar.projected ? '~' : ''}${Math.round(bar.rate)}`}
              </text>
              <text className={styles.axisText} x={cx} y={BARS.height - 6} textAnchor="middle">
                {label}
              </text>
            </g>
          );
        })}
        <line
          className={styles.allowedLine}
          x1={BARS.left}
          x2={BARS.width - BARS.right}
          y1={y(ALLOWED_PER_DAY)}
          y2={y(ALLOWED_PER_DAY)}
        />
      </svg>
      <div className={styles.legend}>
        <LegendItem swatch={styles.swatchWithin}>{t('usage.legend_within')}</LegendItem>
        <LegendItem swatch={styles.swatchOver}>{t('usage.legend_over')}</LegendItem>
        <LegendItem swatch={styles.swatchProjected}>{t('usage.legend_forecast')}</LegendItem>
        <LegendItem swatch={styles.swatchAllowed}>{t('usage.legend_allowed_even')}</LegendItem>
      </div>
    </div>
  );
}
