/**
 * Pace: every account's current window on one chart against the even pace.
 */

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ResolvedTheme } from '@/types';
import { HOUR_MS } from '@/utils/time/durations';
import {
  PROVIDER_NAMES,
  WEEK_MS,
  forecastAccount,
  projectedAt,
  seenRunOut,
  staleAfterMs,
  usedAt,
} from './usageModel';
import type { AccountForecast, AccountView, UsageHistory } from './usageModel';
import { formatDuration, formatWhen } from './format';
import { providerIconSrc } from './icons';
import { HatchPattern, LegendItem, ProviderIcon, Stat } from './parts';
import { useCrosshair } from './useCrosshair';
import { useWidth } from './useWidth';
import styles from './UsagePage.module.scss';

interface Props {
  history: UsageHistory;
  accounts: AccountView[];
  now: number;
  theme: ResolvedTheme;
}

/** Too early in a window for its pace to mean anything: one busy hour reads as 10×. */
const EARLY_MS = 12 * HOUR_MS;
/** Ahead by less than this is even, not ahead. */
const AHEAD = 1.05;

const paceText = (pace: number) => `${pace.toFixed(1)}×`;
/** What tells an account apart from others of its provider: "gmail", "Pro", or nothing. */
const tagOf = (account: AccountView) =>
  account.label.slice(PROVIDER_NAMES[account.provider].length).trim();

export function PacePanel({ history, accounts, now, theme }: Props) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);

  const forecasts = useMemo(
    () =>
      accounts
        .map((account) => forecastAccount(history, account, now))
        .filter((forecast): forecast is AccountForecast => forecast !== null)
        // A window that just began has no pace yet, so it sorts last.
        .sort(
          (a, b) =>
            Number(a.startMs > now - EARLY_MS) - Number(b.startMs > now - EARLY_MS) ||
            b.pace - a.pace
        ),
    [history, accounts, now]
  );

  const early = (f: AccountForecast) => now - f.startMs < EARLY_MS;
  const running = forecasts.filter((f) => f.kind !== 'out' && !early(f));
  const out = forecasts.filter((f) => f.kind === 'out');
  const ahead = running.filter((f) => f.pace >= AHEAD);
  const lead = ahead[0] ?? null;
  const current =
    forecasts.find((f) => f.account.name === selected) ?? lead ?? out[0] ?? forecasts[0] ?? null;

  let headline: string;
  const sub: string[] = [];
  if (lead) {
    headline = t('usage.pace_headline_ahead', {
      account: lead.account.label,
      pace: lead.pace.toFixed(1),
    });
    sub.push(
      lead.kind === 'runsOut'
        ? t('usage.pace_sub_runs_out', { time: formatWhen(lead.runOutMs as number, now, t) })
        : t('usage.pace_sub_holds', { percent: Math.round(lead.usedAtReset) })
    );
    if (out[0]) {
      sub.push(
        t('usage.pace_sub_out', {
          account: out[0].account.label,
          time: formatWhen(out[0].resetMs, now, t),
        })
      );
    }
    const behind = running.length - ahead.length;
    if (ahead.length > 1) sub.push(t('usage.pace_sub_more_ahead', { count: ahead.length - 1 }));
    else if (behind > 0) sub.push(t('usage.pace_sub_behind', { count: behind }));
  } else if (out[0]) {
    headline = t('usage.pace_headline_out', {
      account: out[0].account.label,
      time: formatWhen(out[0].resetMs, now, t),
    });
    if (running.length) sub.push(t('usage.pace_sub_rest_behind'));
  } else {
    headline = t('usage.pace_headline_behind');
    if (running[0]) {
      sub.push(
        t('usage.pace_sub_fastest', {
          account: running[0].account.label,
          pace: running[0].pace.toFixed(1),
        })
      );
    }
  }

  return (
    <section className={styles.card}>
      <header className={styles.cardHead}>
        <div>
          <h2 className={styles.headline}>{headline}</h2>
          {sub.filter(Boolean).length > 0 && (
            <p className={styles.subline}>{sub.filter(Boolean).join(' ')}</p>
          )}
        </div>
      </header>

      <div className={styles.layout}>
        <div className={styles.main}>
          <PaceChart
            forecasts={forecasts}
            selected={current}
            history={history}
            now={now}
            theme={theme}
            t={t}
          />
        </div>
        {current && (
          <PaceDetail
            forecasts={forecasts}
            current={current}
            early={early}
            now={now}
            onSelect={setSelected}
            theme={theme}
            t={t}
          />
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- chart */

const MARGIN = { left: 40, right: 18, top: 34, bottom: 30 };

function PaceChart({
  forecasts,
  selected,
  history,
  now,
  theme,
  t,
}: {
  forecasts: AccountForecast[];
  selected: AccountForecast | null;
  history: UsageHistory;
  now: number;
  theme: ResolvedTheme;
  t: TFunction;
}) {
  const hatchId = useId().replace(/:/g, '');
  const [ref, width] = useWidth<HTMLDivElement>(640);
  const height = Math.round(Math.min(380, Math.max(250, width * 0.56)));
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const { fraction, onMove, onLeave } = useCrosshair(MARGIN.left, plotW, width);
  const staleMs = staleAfterMs(history);

  const fx = (f: number) => MARGIN.left + f * plotW;
  const y = (percent: number) => MARGIN.top + plotH - (Math.min(100, percent) / 100) * plotH;
  const xOf = (forecast: AccountForecast, ms: number) => fx((ms - forecast.startMs) / WEEK_MS);
  const path = (pairs: (readonly [number, number])[]) =>
    pairs.map(([x, v], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  // The selected account draws last, on top.
  const order = [...forecasts.filter((f) => f !== selected), ...(selected ? [selected] : [])];
  const dayStep = plotW / 7 >= 40 ? 1 : 2;
  const evenAngle = (Math.atan2(-plotH, plotW) * 180) / Math.PI;

  // Labels beside each account's latest reading, nudged apart where they'd overlap.
  const labels = forecasts
    .map((f) => ({ f, x: xOf(f, now), y: y(f.used) }))
    .sort((a, b) => b.y - a.y);
  labels.forEach((label, i) => {
    for (let j = 0; j < i; j += 1) {
      const other = labels[j];
      if (Math.abs(other.x - label.x) < 96 && other.y - label.y < 16) label.y = other.y - 16;
    }
  });

  const hoverMs = selected && fraction !== null ? selected.startMs + fraction * WEEK_MS : null;
  const hoverValue =
    hoverMs === null || !selected
      ? null
      : hoverMs <= now
        ? usedAt(selected.points, hoverMs, Infinity)
        : projectedAt(selected, now, hoverMs);

  return (
    <div className={styles.paceChart} ref={ref}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={t('usage.pace_chart_label')}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      >
        <HatchPattern id={hatchId} />
        <path
          className={styles.aheadArea}
          d={`M${fx(0)},${y(0)} L${fx(1)},${y(100)} L${fx(0)},${y(100)} Z`}
        />
        <text className={styles.axisTextMuted} x={fx(0) + 10} y={y(100) + 18}>
          {t('usage.pace_ahead_area')}
        </text>
        <text className={styles.axisTextMuted} x={fx(1) - 10} y={y(0) - 10} textAnchor="end">
          {t('usage.pace_behind_area')}
        </text>
        {[0, 25, 50, 75, 100].map((pct) => (
          <g key={pct}>
            <line
              className={styles.gridLine}
              x1={fx(0)}
              x2={fx(1)}
              y1={y(pct)}
              y2={y(pct)}
              data-faint={pct % 50 ? 1 : 0}
            />
            <text className={styles.axisText} x={fx(0) - 7} y={y(pct) + 3.5} textAnchor="end">
              {pct}%
            </text>
          </g>
        ))}
        {Array.from({ length: 8 }, (_, day) => day)
          .filter((day) => day === 7 || (day % dayStep === 0 && 7 - day >= dayStep))
          .map((day) => (
            <text
              key={day}
              className={day === 7 ? styles.axisTextStrong : styles.axisText}
              x={fx(day / 7)}
              y={height - 8}
              textAnchor={day === 0 ? 'start' : day === 7 ? 'end' : 'middle'}
            >
              {day === 0
                ? t('usage.pace_axis_start')
                : day === 7
                  ? t('usage.pace_axis_reset')
                  : t('usage.days_short', { count: day })}
            </text>
          ))}
        <line className={styles.resetLine} x1={fx(1)} x2={fx(1)} y1={y(0)} y2={y(100)} />
        <line className={styles.evenLine} x1={fx(0)} y1={y(0)} x2={fx(1)} y2={y(100)} />
        <text
          className={styles.axisTextMuted}
          transform={`translate(${fx(0.8)},${y(80) - 7}) rotate(${evenAngle})`}
          textAnchor="middle"
        >
          {t('usage.legend_even_pace')}
        </text>

        {selected && selected.kind !== 'holds' && (
          <PaceLock
            forecast={selected}
            xOf={xOf}
            y={y}
            hatchId={hatchId}
            staleMs={staleMs}
            now={now}
            t={t}
          />
        )}

        {order.map((f) => {
          const isSelected = f === selected;
          const first = f.points[0];
          const unreadStart = first[0] - f.startMs > staleMs;
          const used = path([
            ...f.points.map((p) => [xOf(f, p[0]), p[1]] as const),
            [xOf(f, now), f.used] as const,
          ]);
          const projection =
            f.kind === 'runsOut'
              ? [xOf(f, f.runOutMs as number), 100]
              : f.kind === 'holds'
                ? [xOf(f, f.resetMs), f.usedAtReset]
                : null;
          const seen = f.kind === 'out' ? seenRunOut(f.points, f.startMs, staleMs) : null;
          return (
            <g
              key={f.account.name}
              data-selected={isSelected ? 1 : 0}
              className={styles.paceSeries}
            >
              <path
                className={unreadStart ? styles.unreadLine : styles.accountLine}
                d={path([
                  [fx(0), 0],
                  [xOf(f, first[0]), first[1]],
                ])}
              />
              <path className={styles.accountLine} d={used} />
              {projection && (
                <line
                  className={styles.paceLine}
                  x1={xOf(f, now)}
                  y1={y(f.used)}
                  x2={projection[0]}
                  y2={y(projection[1])}
                />
              )}
              {f.kind === 'runsOut' && (
                <circle
                  className={styles.dangerDot}
                  cx={xOf(f, f.runOutMs as number)}
                  cy={y(100)}
                  r={4.5}
                />
              )}
              {seen !== null && (
                <circle className={styles.dangerDot} cx={xOf(f, seen)} cy={y(100)} r={4.5} />
              )}
              <circle className={styles.paceMarker} cx={xOf(f, now)} cy={y(f.used)} r={4} />
            </g>
          );
        })}

        {labels.map(({ f, x, y: labelY }) => {
          const src = providerIconSrc(f.account.provider, theme);
          const flip = x > width - 110;
          const text = [tagOf(f.account), `${Math.round(f.used)}%`].filter(Boolean).join(' ');
          return (
            <g
              key={f.account.name}
              className={styles.paceLabel}
              data-selected={f === selected ? 1 : 0}
              transform={`translate(${flip ? x - 9 : x + 9},${labelY})`}
            >
              {src && <image href={src} x={flip ? -14 : 0} y={-7} width={13} height={13} />}
              <text x={flip ? -18 : 17} y={4} textAnchor={flip ? 'end' : 'start'}>
                {text}
              </text>
            </g>
          );
        })}

        {hoverMs !== null && hoverValue !== null && selected && (
          <g pointerEvents="none">
            <line
              className={styles.crosshair}
              x1={xOf(selected, hoverMs)}
              x2={xOf(selected, hoverMs)}
              y1={MARGIN.top}
              y2={MARGIN.top + plotH}
            />
            <circle
              className={styles.hoverDot}
              cx={xOf(selected, hoverMs)}
              cy={y(hoverValue)}
              r={3.5}
            />
            <text
              className={styles.hoverText}
              x={Math.min(xOf(selected, hoverMs) + 6, width - 170)}
              y={Math.max(y(hoverValue) - 10, MARGIN.top + 10)}
            >
              {`${selected.account.label} · ${formatWhen(hoverMs, now, t)} · ${Math.round(hoverValue)}%${hoverMs > now ? ` ${t('usage.projected')}` : ''}`}
            </text>
          </g>
        )}
      </svg>
      <div className={styles.legend}>
        <LegendItem swatch={styles.swatchUsed}>{t('usage.legend_used_so_far')}</LegendItem>
        <LegendItem swatch={styles.swatchPace}>{t('usage.legend_if_pace_holds')}</LegendItem>
        <LegendItem swatch={styles.swatchUnread}>{t('usage.legend_unread_start')}</LegendItem>
        <LegendItem swatch={styles.swatchEven}>{t('usage.legend_even_pace')}</LegendItem>
        <LegendItem swatch={styles.swatchRunsOutDot}>{t('usage.legend_runs_out')}</LegendItem>
        <LegendItem swatch={styles.swatchLocked}>{t('usage.legend_locked')}</LegendItem>
      </div>
    </div>
  );
}

/** The selected account's run-out, and the stretch it then spends locked, along the top. */
function PaceLock({
  forecast,
  xOf,
  y,
  hatchId,
  staleMs,
  now,
  t,
}: {
  forecast: AccountForecast;
  xOf: (forecast: AccountForecast, ms: number) => number;
  y: (percent: number) => number;
  hatchId: string;
  staleMs: number;
  now: number;
  t: TFunction;
}) {
  // Out before the first reading: the lock is drawn from that reading, and no length is claimed.
  const seen =
    forecast.kind === 'out' ? seenRunOut(forecast.points, forecast.startMs, staleMs) : null;
  const from =
    forecast.kind === 'out'
      ? (seen ?? forecast.points.find((p) => p[1] >= 100)?.[0] ?? now)
      : (forecast.runOutMs as number);
  const [x1, x2] = [xOf(forecast, from), xOf(forecast, forecast.resetMs)];
  return (
    <g>
      <rect
        x={x1}
        y={y(100) - 8}
        width={Math.max(0, x2 - x1)}
        height={8}
        fill={`url(#${hatchId})`}
      />
      <text className={styles.chartLabelDanger} x={x2} y={y(100) - 14} textAnchor="end">
        {forecast.kind === 'out' && seen === null
          ? t('usage.out_until', { time: formatWhen(forecast.resetMs, now, t) })
          : t('usage.locked_for', { duration: formatDuration(forecast.resetMs - from, t, true) })}
      </text>
      {forecast.kind === 'runsOut' && x2 - x1 > 150 && (
        <text className={styles.chartLabelDanger} x={x1} y={y(100) - 14} textAnchor="middle">
          {t('usage.runs_out_at', { time: formatWhen(from, now, t) })}
        </text>
      )}
    </g>
  );
}

/* ------------------------------------------------------------- detail */

function PaceDetail({
  forecasts,
  current,
  early,
  now,
  onSelect,
  theme,
  t,
}: {
  forecasts: AccountForecast[];
  current: AccountForecast;
  early: (f: AccountForecast) => boolean;
  now: number;
  onSelect: (name: string) => void;
  theme: ResolvedTheme;
  t: TFunction;
}) {
  const evenByNow = Math.min(100, ((now - current.startMs) / WEEK_MS) * 100);
  return (
    <aside className={styles.detail}>
      <div className={styles.detailHead}>
        <ProviderIcon provider={current.account.provider} theme={theme} size={26} />
        <div>
          <h3>{current.account.label}</h3>
          <p>{t('usage.pace_window_meta', { time: formatWhen(current.resetMs, now, t) })}</p>
        </div>
      </div>

      <div className={styles.bigPace}>
        {current.kind === 'out' ? (
          <b data-tone="danger">
            {t('usage.out_until', { time: formatWhen(current.resetMs, now, t) })}
          </b>
        ) : early(current) ? (
          <b>{t('usage.pace_just_reset')}</b>
        ) : (
          <>
            <b>{paceText(current.pace)}</b>
            <span>{t('usage.pace_big_unit')}</span>
          </>
        )}
      </div>

      <div className={styles.stats} data-columns="2">
        <Stat label={t('usage.stat_used_now')} value={`${Math.round(current.used)}%`} />
        <Stat label={t('usage.stat_even_by_now')} value={`${Math.round(evenByNow)}%`} />
      </div>
      {current.kind !== 'out' && (
        <>
          <h4 className={styles.detailCaption}>{t('usage.legend_if_pace_holds')}</h4>
          <div className={styles.stats} data-columns="2">
            {current.kind === 'runsOut' ? (
              <Stat
                label={t('usage.stat_runs_out')}
                value={formatWhen(current.runOutMs as number, now, t)}
                tone="danger"
              />
            ) : (
              <Stat
                label={t('usage.stat_at_reset')}
                value={`~${Math.round(current.usedAtReset)}%`}
              />
            )}
            <Stat
              label={t('usage.stat_locked')}
              value={current.lockedMs > 0 ? formatDuration(current.lockedMs, t, true) : '–'}
              tone={current.lockedMs > 0 ? 'danger' : undefined}
            />
          </div>
        </>
      )}

      <div className={styles.subChart}>
        <h4>
          {t('usage.pace_all_accounts')} <span>· {t('usage.pace_fastest_first')}</span>
        </h4>
        <ol className={styles.paceList}>
          {forecasts.map((f) => (
            <li key={f.account.name}>
              <button
                type="button"
                aria-pressed={f === current}
                onClick={() => onSelect(f.account.name)}
              >
                <ProviderIcon provider={f.account.provider} theme={theme} />
                <span className={styles.paceListName}>{f.account.label}</span>
                <span className={styles.paceListPace}>{early(f) ? '–' : paceText(f.pace)}</span>
                <span
                  className={styles.paceListOutcome}
                  data-tone={f.kind === 'holds' ? undefined : 'danger'}
                >
                  {f.kind === 'out'
                    ? t('usage.out_until', { time: formatWhen(f.resetMs, now, t) })
                    : f.kind === 'runsOut'
                      ? formatWhen(f.runOutMs as number, now, t)
                      : t('usage.at_reset', { percent: Math.round(f.usedAtReset) })}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}
