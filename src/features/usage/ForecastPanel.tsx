/**
 * Forecast: when each account runs out at the pace of the last day, laid over
 * the coming week, with one account's window in detail.
 */

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ResolvedTheme } from '@/types';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import {
  CELL_MS,
  PROVIDER_NAMES,
  dailyPace,
  forecastAccount,
  projectedAt,
  sortForecasts,
  staleAfterMs,
  usedAt,
} from './usageModel';
import type { AccountForecast, AccountView, UsageHistory, UseLevel } from './usageModel';
import { formatDate, formatDuration, formatTime, formatWhen, weekday } from './format';
import { HatchPattern, LegendItem, ProviderIcon, Segmented, Stat } from './parts';
import { useCrosshair } from './useCrosshair';
import styles from './UsagePage.module.scss';

interface Props {
  history: UsageHistory;
  accounts: AccountView[];
  now: number;
  theme: ResolvedTheme;
}

type TrackState = 'use' | 'runsOut' | 'locked' | 'next' | 'none';

const HORIZON_DAYS = 7;
const levelOf = (used: number) => Math.min(3, Math.floor(used / 25)) as UseLevel;

export function ForecastPanel({ history, accounts, now, theme }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<'forecast' | 'table'>('forecast');
  const [selected, setSelected] = useState<string | null>(null);

  const forecasts = useMemo(
    () =>
      sortForecasts(
        accounts
          .map((account) => forecastAccount(history, account, now))
          .filter((forecast): forecast is AccountForecast => forecast !== null)
      ),
    [history, accounts, now]
  );
  const unread = accounts.filter((a) => !forecasts.some((f) => f.account.name === a.name));
  const current = forecasts.find((f) => f.account.name === selected) ?? forecasts[0] ?? null;

  const short = forecasts.filter((f) => f.kind !== 'holds');
  const first = short[0];
  const headline =
    short.length > 0
      ? t('usage.forecast_headline', { count: short.length })
      : t('usage.forecast_headline_none');
  const sub = !first
    ? forecasts[0] &&
      t('usage.forecast_sub_closest', {
        account: forecasts[0].account.label,
        percent: Math.round(forecasts[0].usedAtReset),
      })
    : first.kind === 'out'
      ? t('usage.forecast_sub_out', {
          account: first.account.label,
          time: formatWhen(first.resetMs, now, t),
        })
      : t('usage.forecast_sub_runs_out', {
          account: first.account.label,
          time: formatWhen(first.runOutMs as number, now, t),
          locked: formatDuration(first.lockedMs, t),
        });

  const horizonStart = new Date(now).setHours(0, 0, 0, 0);
  const horizonEnd = horizonStart + HORIZON_DAYS * DAY_MS;
  const toPercent = (ms: number) => ((ms - horizonStart) / (horizonEnd - horizonStart)) * 100;
  const days = Array.from({ length: HORIZON_DAYS }, (_, i) => horizonStart + i * DAY_MS);

  return (
    <section className={styles.card}>
      <header className={styles.cardHead}>
        <div>
          <h2 className={styles.headline}>{headline}</h2>
          {sub && <p className={styles.subline}>{sub}</p>}
        </div>
        <Segmented
          label={t('usage.view')}
          value={view}
          onChange={setView}
          options={[
            { value: 'forecast', label: t('usage.view_forecast') },
            { value: 'table', label: t('usage.view_table') },
          ]}
        />
      </header>

      {view === 'table' ? (
        <ForecastTable forecasts={forecasts} unread={unread} now={now} t={t} />
      ) : (
        <div className={styles.layout}>
          <div className={styles.main}>
            <div className={styles.scroller}>
              <div className={styles.forecastGrid}>
                <div className={styles.axisRow}>
                  <span />
                  <div className={styles.axisDays}>
                    <span className={styles.nowLabel} style={{ left: `${toPercent(now)}%` }}>
                      {t('usage.now')}
                    </span>
                    {days.map((day) => (
                      <span key={day}>{weekday(day, t)}</span>
                    ))}
                  </div>
                  <span />
                </div>

                {forecasts.map((forecast) => (
                  <ForecastRow
                    key={forecast.account.name}
                    forecast={forecast}
                    history={history}
                    now={now}
                    horizonStart={horizonStart}
                    toPercent={toPercent}
                    selected={forecast === current}
                    onSelect={() => setSelected(forecast.account.name)}
                    theme={theme}
                    t={t}
                  />
                ))}
                {unread.map((account) => (
                  <div key={account.name} className={styles.row} data-muted="1">
                    <span className={styles.rowLabel}>
                      <ProviderIcon provider={account.provider} theme={theme} />
                      <span className={styles.rowName}>{account.label}</span>
                    </span>
                    <div className={styles.track}>
                      {Array.from({ length: HORIZON_DAYS * 4 }, (_, i) => (
                        <span key={i} className={styles.cell} data-state="none" />
                      ))}
                    </div>
                    <span className={styles.rowSummary}>
                      <span className={styles.muted}>{t('usage.no_reading')}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <footer className={styles.legend}>
              <span className={styles.legendGroup}>
                {t('usage.legend_projected')}
                {[0, 1, 2, 3].map((level) => (
                  <span key={level} className={styles.cell} data-state="use" data-level={level} />
                ))}
                {t('usage.legend_levels')}
              </span>
              <LegendItem swatch={styles.swatchRunsOut}>{t('usage.legend_runs_out')}</LegendItem>
              <LegendItem swatch={styles.swatchLocked}>{t('usage.legend_locked')}</LegendItem>
              <LegendItem swatch={styles.swatchReset}>{t('usage.legend_reset')}</LegendItem>
              <LegendItem swatch={styles.swatchNone}>{t('usage.legend_new_window')}</LegendItem>
              <span className={styles.legendNote}>{t('usage.legend_forecast_note')}</span>
            </footer>
          </div>

          {current && (
            <ForecastDetail forecast={current} history={history} now={now} theme={theme} t={t} />
          )}
        </div>
      )}
    </section>
  );
}

function ForecastRow({
  forecast,
  history,
  now,
  horizonStart,
  toPercent,
  selected,
  onSelect,
  theme,
  t,
}: {
  forecast: AccountForecast;
  history: UsageHistory;
  now: number;
  horizonStart: number;
  toPercent: (ms: number) => number;
  selected: boolean;
  onSelect: () => void;
  theme: ResolvedTheme;
  t: TFunction;
}) {
  const staleMs = staleAfterMs(history);
  const allPoints = history.series[forecast.account.name]?.['7d'] ?? [];
  const cells = Array.from({ length: HORIZON_DAYS * 4 }, (_, i) => {
    const start = horizonStart + i * CELL_MS;
    const end = start + CELL_MS;
    let state: TrackState;
    let level: UseLevel = 0;
    let value: number | null = null;
    if (end <= now) {
      value = usedAt(allPoints, end - 1, staleMs);
      state = value === null ? 'none' : value >= 100 ? 'locked' : 'use';
    } else if (start >= forecast.resetMs) {
      state = 'next';
    } else if (forecast.kind === 'out') {
      state = 'locked';
      value = 100;
    } else if (forecast.runOutMs !== null && forecast.runOutMs < end) {
      state = forecast.runOutMs >= start ? 'runsOut' : 'locked';
      value = 100;
    } else {
      value = projectedAt(forecast, now, Math.min(end, forecast.resetMs));
      state = 'use';
    }
    if (value !== null) level = levelOf(value);
    const range = `${weekday(start, t)} ${formatTime(start)}–${formatTime(end)}`;
    const title =
      state === 'next'
        ? `${range}\n${t('usage.legend_new_window')}`
        : state === 'none'
          ? `${range}\n${t('usage.no_reading')}`
          : `${range}\n${t('usage.cell_used', { percent: Math.round(value ?? 0) })}`;
    return { start, state, level, title };
  });

  const resetPercent = toPercent(forecast.resetMs);
  const runOutPercent = forecast.runOutMs !== null ? toPercent(forecast.runOutMs) : null;

  return (
    <div className={styles.row} data-selected={selected ? 1 : 0}>
      <button type="button" className={styles.rowLabel} onClick={onSelect} aria-pressed={selected}>
        <ProviderIcon provider={forecast.account.provider} theme={theme} />
        <span className={styles.rowName}>{forecast.account.label}</span>
      </button>
      <div className={styles.track} onClick={onSelect}>
        {cells.map((cell) => (
          <span
            key={cell.start}
            className={styles.cell}
            data-state={cell.state}
            data-level={cell.level}
            title={cell.title}
          />
        ))}
        <span className={styles.nowTick} style={{ left: `${toPercent(now)}%` }} />
        {resetPercent > 0 && resetPercent < 100 && (
          <span
            className={styles.resetTick}
            style={{ left: `${resetPercent}%` }}
            data-flip={resetPercent > 80 ? 1 : 0}
          >
            <span>{t('usage.reset')}</span>
          </span>
        )}
        {runOutPercent !== null && runOutPercent >= 0 && runOutPercent <= 100 && (
          <span
            className={styles.runOutDot}
            style={{ left: `${runOutPercent}%` }}
            title={t('usage.runs_out_at', {
              time: formatWhen(forecast.runOutMs as number, now, t),
            })}
          />
        )}
      </div>
      <span className={styles.rowSummary}>
        <ForecastSummary forecast={forecast} now={now} t={t} />
      </span>
    </div>
  );
}

function ForecastSummary({
  forecast,
  now,
  t,
}: {
  forecast: AccountForecast;
  now: number;
  t: TFunction;
}) {
  const resets = t('usage.resets_at', { time: formatWhen(forecast.resetMs, now, t) });
  if (forecast.kind === 'out') {
    return (
      <>
        <b data-tone="danger">
          {t('usage.out_until', { time: formatWhen(forecast.resetMs, now, t) })}
        </b>
        <span className={styles.muted}>
          {t('usage.locked_for', { duration: formatDuration(forecast.lockedMs, t) })}
        </span>
      </>
    );
  }
  if (forecast.kind === 'runsOut') {
    return (
      <>
        <b>{t('usage.runs_out_at', { time: formatWhen(forecast.runOutMs as number, now, t) })}</b>
        <span className={styles.muted}>{resets}</span>
      </>
    );
  }
  return (
    <>
      <span>{t('usage.at_reset', { percent: Math.round(forecast.usedAtReset) })}</span>
      <span className={styles.muted}>{resets}</span>
    </>
  );
}

/* ------------------------------------------------------------- detail */

const CHART = { width: 360, height: 200, left: 38, right: 10, top: 22, bottom: 26 };
const PLOT_W = CHART.width - CHART.left - CHART.right;
const PLOT_H = CHART.height - CHART.top - CHART.bottom;

function ForecastDetail({
  forecast,
  history,
  now,
  theme,
  t,
}: {
  forecast: AccountForecast;
  history: UsageHistory;
  now: number;
  theme: ResolvedTheme;
  t: TFunction;
}) {
  const hatchId = useId().replace(/:/g, '');
  const { fraction, onMove, onLeave } = useCrosshair(CHART.left, PLOT_W, CHART.width);
  const { startMs, resetMs, points } = forecast;
  const x = (ms: number) => CHART.left + ((ms - startMs) / (resetMs - startMs)) * PLOT_W;
  const y = (percent: number) => CHART.top + PLOT_H - (Math.min(100, percent) / 100) * PLOT_H;
  const gone = Math.round(((now - startMs) / (resetMs - startMs)) * 100);

  const used = [...points.map((p) => [p[0], p[1]] as const), [now, forecast.used] as const];
  const usedPath = used
    .map(([ms, pct], i) => `${i ? 'L' : 'M'}${x(ms).toFixed(1)},${y(pct).toFixed(1)}`)
    .join(' ');
  const firstAt = points[0]?.[0] ?? now;
  const lockFrom = forecast.kind === 'out' ? now : forecast.runOutMs;
  const paceEnd: [number, number] | null =
    forecast.kind === 'runsOut'
      ? [forecast.runOutMs as number, 100]
      : forecast.kind === 'holds'
        ? [resetMs, forecast.usedAtReset]
        : null;

  const hoverMs = fraction === null ? null : startMs + fraction * (resetMs - startMs);
  const hoverValue =
    hoverMs === null
      ? null
      : hoverMs <= now
        ? usedAt(points, hoverMs, Infinity)
        : projectedAt(forecast, now, hoverMs);

  const days = dailyPace(history.series[forecast.account.name]?.['7d'] ?? [], now);
  const accountMeta = `${PROVIDER_NAMES[forecast.account.provider]} · ${forecast.account.email}`;

  return (
    <aside className={styles.detail}>
      <div className={styles.detailHead}>
        <ProviderIcon provider={forecast.account.provider} theme={theme} size={26} />
        <div>
          <h3>{forecast.account.label}</h3>
          <p>{accountMeta}</p>
        </div>
      </div>
      <p className={styles.detailLead}>
        {t('usage.used_in_window', { used: Math.round(forecast.used), gone })}
      </p>

      <svg
        className={styles.chart}
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-label={t('usage.chart_window_label', { account: forecast.account.label })}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      >
        <HatchPattern id={hatchId} />
        {[0, 50, 100].map((pct) => (
          <g key={pct}>
            <line
              className={styles.gridLine}
              x1={CHART.left}
              x2={CHART.width - CHART.right}
              y1={y(pct)}
              y2={y(pct)}
            />
            <text className={styles.axisText} x={CHART.left - 6} y={y(pct) + 3.5} textAnchor="end">
              {pct}%
            </text>
          </g>
        ))}
        {lockFrom !== null && (
          <rect
            x={x(lockFrom)}
            y={CHART.top}
            width={Math.max(0, x(resetMs) - x(lockFrom))}
            height={PLOT_H}
            fill={`url(#${hatchId})`}
            className={styles.lockedArea}
          >
            <title>
              {t('usage.locked_for', { duration: formatDuration(forecast.lockedMs, t) })}
            </title>
          </rect>
        )}
        {firstAt - startMs > 2 * HOUR_MS && (
          <g>
            <rect
              className={styles.noReadings}
              x={x(startMs)}
              y={CHART.top}
              width={x(firstAt) - x(startMs)}
              height={PLOT_H}
            />
            {x(firstAt) - x(startMs) > 70 && (
              <text
                className={styles.axisTextMuted}
                x={(x(startMs) + x(firstAt)) / 2}
                y={CHART.top + PLOT_H / 2}
                textAnchor="middle"
              >
                {t('usage.no_readings')}
              </text>
            )}
          </g>
        )}
        <line className={styles.evenLine} x1={x(startMs)} y1={y(0)} x2={x(resetMs)} y2={y(100)} />
        <path className={styles.usedLine} d={usedPath} />
        {paceEnd && (
          <line
            className={styles.paceLine}
            x1={x(now)}
            y1={y(forecast.used)}
            x2={x(paceEnd[0])}
            y2={y(paceEnd[1])}
          />
        )}
        <line
          className={styles.nowLine}
          x1={x(now)}
          x2={x(now)}
          y1={CHART.top}
          y2={CHART.top + PLOT_H}
        />
        {forecast.kind === 'runsOut' && (
          <g>
            <circle
              className={styles.dangerDot}
              cx={x(forecast.runOutMs as number)}
              cy={y(100)}
              r={4.5}
            />
            <text
              className={styles.chartLabel}
              x={x(forecast.runOutMs as number)}
              y={CHART.top - 8}
              textAnchor="middle"
            >
              {formatWhen(forecast.runOutMs as number, now, t)}
            </text>
          </g>
        )}
        <text className={styles.axisText} x={CHART.left} y={CHART.height - 6}>
          {formatDate(startMs)}
        </text>
        <text
          className={styles.axisText}
          x={CHART.width - CHART.right}
          y={CHART.height - 6}
          textAnchor="end"
        >
          {t('usage.reset_on', { date: formatDate(resetMs) })}
        </text>
        {hoverMs !== null && hoverValue !== null && (
          <g pointerEvents="none">
            <line
              className={styles.crosshair}
              x1={x(hoverMs)}
              x2={x(hoverMs)}
              y1={CHART.top}
              y2={CHART.top + PLOT_H}
            />
            <circle className={styles.hoverDot} cx={x(hoverMs)} cy={y(hoverValue)} r={3.5} />
            <text
              className={styles.hoverText}
              x={Math.min(x(hoverMs) + 6, CHART.width - 96)}
              y={Math.max(y(hoverValue) - 8, CHART.top + 10)}
            >
              {`${formatWhen(hoverMs, now, t)} · ${Math.round(hoverValue)}%${hoverMs > now ? ` ${t('usage.projected')}` : ''}`}
            </text>
          </g>
        )}
      </svg>

      <div className={styles.legend}>
        <LegendItem swatch={styles.swatchUsed}>{t('usage.legend_used')}</LegendItem>
        <LegendItem swatch={styles.swatchPace}>{t('usage.legend_current_pace')}</LegendItem>
        <LegendItem swatch={styles.swatchEven}>{t('usage.legend_even_pace')}</LegendItem>
        <LegendItem swatch={styles.swatchRunsOutDot}>{t('usage.legend_runs_out')}</LegendItem>
        <LegendItem swatch={styles.swatchLocked}>{t('usage.legend_locked')}</LegendItem>
      </div>

      <div className={styles.stats}>
        <Stat
          label={t('usage.stat_pace')}
          value={t('usage.pace_value', { pace: forecast.pace.toFixed(1) })}
        />
        {forecast.kind === 'holds' ? (
          <Stat label={t('usage.stat_at_reset')} value={`~${Math.round(forecast.usedAtReset)}%`} />
        ) : (
          <Stat
            label={t('usage.stat_runs_out')}
            value={
              forecast.kind === 'out'
                ? t('usage.now')
                : formatWhen(forecast.runOutMs as number, now, t)
            }
            tone="danger"
          />
        )}
        <Stat
          label={t('usage.stat_locked')}
          value={forecast.lockedMs > 0 ? formatDuration(forecast.lockedMs, t, true) : '–'}
          tone={forecast.lockedMs > 0 ? 'danger' : undefined}
        />
      </div>

      <DailyPaceChart days={days} allowed={forecast.allowedPerDay} now={now} t={t} />
    </aside>
  );
}

const BARS = { width: 360, height: 150, left: 8, right: 8, top: 22, bottom: 24 };

function DailyPaceChart({
  days,
  allowed,
  now,
  t,
}: {
  days: ReturnType<typeof dailyPace>;
  allowed: number;
  now: number;
  t: TFunction;
}) {
  const plotW = BARS.width - BARS.left - BARS.right;
  const plotH = BARS.height - BARS.top - BARS.bottom;
  const max = Math.max(allowed * 1.3, ...days.map((d) => d.points ?? 0), 1);
  const slot = plotW / days.length;
  const barW = Math.min(28, slot * 0.55);
  const y = (value: number) => BARS.top + plotH - (value / max) * plotH;
  const today = new Date(now).setHours(0, 0, 0, 0);

  return (
    <div className={styles.subChart}>
      <h4>
        {t('usage.recent_pace')} <span>· {t('usage.recent_pace_unit')}</span>
      </h4>
      <p className={styles.subChartLead}>
        {allowed > 0
          ? t('usage.allowed_per_day', { value: allowed.toFixed(1) })
          : t('usage.allowed_none')}
      </p>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${BARS.width} ${BARS.height}`}
        role="img"
        aria-label={t('usage.recent_pace')}
      >
        {days.map((day, i) => {
          const cx = BARS.left + slot * i + slot / 2;
          const label = day.dayStart === today ? t('usage.today') : weekday(day.dayStart, t);
          if (day.points === null) {
            return (
              <g key={day.dayStart}>
                <text className={styles.axisText} x={cx} y={BARS.height - 6} textAnchor="middle">
                  {label}
                </text>
                <text
                  className={styles.axisTextMuted}
                  x={cx}
                  y={BARS.top + plotH - 4}
                  textAnchor="middle"
                >
                  –
                </text>
              </g>
            );
          }
          const over = day.points > allowed;
          const top = y(day.points);
          return (
            <g key={day.dayStart}>
              <rect
                className={over ? styles.barOver : styles.barWithin}
                x={cx - barW / 2}
                y={top}
                width={barW}
                height={Math.max(1, BARS.top + plotH - top)}
                rx={3}
              >
                <title>{`${label}: ${day.points.toFixed(1)} ${t('usage.recent_pace_unit')}`}</title>
              </rect>
              <text className={styles.barValue} x={cx} y={top - 5} textAnchor="middle">
                {Math.round(day.points)}
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
          y1={y(allowed)}
          y2={y(allowed)}
        />
      </svg>
      <div className={styles.legend}>
        <LegendItem swatch={styles.swatchWithin}>{t('usage.legend_within')}</LegendItem>
        <LegendItem swatch={styles.swatchOver}>{t('usage.legend_over')}</LegendItem>
        <LegendItem swatch={styles.swatchAllowed}>{t('usage.legend_allowed')}</LegendItem>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- table */

function ForecastTable({
  forecasts,
  unread,
  now,
  t,
}: {
  forecasts: AccountForecast[];
  unread: AccountView[];
  now: number;
  t: TFunction;
}) {
  return (
    <div className={styles.scroller}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t('usage.col_account')}</th>
            <th>{t('usage.col_used')}</th>
            <th>{t('usage.stat_pace')}</th>
            <th>{t('usage.col_forecast')}</th>
            <th>{t('usage.col_resets')}</th>
          </tr>
        </thead>
        <tbody>
          {forecasts.map((f) => (
            <tr key={f.account.name}>
              <td>{f.account.label}</td>
              <td>{Math.round(f.used)}%</td>
              <td>{t('usage.pace_value', { pace: f.pace.toFixed(1) })}</td>
              <td data-tone={f.kind === 'holds' ? undefined : 'danger'}>
                {f.kind === 'out'
                  ? t('usage.out_until', { time: formatWhen(f.resetMs, now, t) })
                  : f.kind === 'runsOut'
                    ? t('usage.runs_out_at', { time: formatWhen(f.runOutMs as number, now, t) })
                    : t('usage.at_reset', { percent: Math.round(f.usedAtReset) })}
              </td>
              <td>{formatWhen(f.resetMs, now, t)}</td>
            </tr>
          ))}
          {unread.map((a) => (
            <tr key={a.name}>
              <td>{a.label}</td>
              <td colSpan={4} className={styles.muted}>
                {t('usage.no_reading')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
