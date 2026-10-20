/**
 * Bursts: each account's use hour by hour, a line per day, so the few hours
 * that spend most of a week stand out, and whether they came while another
 * account was out. Every account shows at once, one card each.
 */

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ResolvedTheme } from '@/types';
import { HOUR_MS } from '@/utils/time/durations';
import { PROVIDER_NAMES, WORK_HOURS, lockedAt, staleAfterMs, windowsOf } from './usageModel';
import type { AccountView, UsageHistory, UsageWindow } from './usageModel';
import {
  BURST_LINE,
  burstDays,
  burstsFrom,
  findBursts,
  hourlyUse,
  windowSplits,
} from './burstsModel';
import type { Burst, BurstDay, HourUse, WindowSplit } from './burstsModel';
import { formatMonthDay, formatTime, formatWhen, weekday } from './format';
import { HatchPattern, LegendItem, ProviderIcon, Stat } from './parts';
import styles from './UsagePage.module.scss';

interface Props {
  history: UsageHistory;
  accounts: AccountView[];
  now: number;
  theme: ResolvedTheme;
}

/** A row's line may climb this many rows, into the days above it. */
const RISE_ROWS = 2.6;
/** Too little use to say anything about its shape. */
const QUIET = 5;

interface Entry {
  account: AccountView;
  windows: UsageWindow[];
  hours: HourUse[];
  days: BurstDay[];
  bursts: Burst[];
  splits: WindowSplit[];
  used: number;
  /** Bursts during which another account of the provider was out, by burst start. */
  covering: Map<number, AccountView>;
}

const pct = (value: number) => (value < 10 ? value.toFixed(1) : String(Math.round(value)));

export function BurstsPanel({ history, accounts, now, theme }: Props) {
  const { t, i18n } = useTranslation();
  const entries = useMemo<Entry[]>(() => {
    const staleMs = staleAfterMs(history);
    return accounts.map((account) => {
      const points = history.series[account.name]?.['7d'] ?? [];
      const windows = windowsOf(points, now, staleMs);
      // Every recorded hour feeds the per-window split; the chart and headline keep to recent weeks.
      const firstDay = new Date(points[0]?.[0] ?? now).setHours(0, 0, 0, 0);
      const allHours = hourlyUse(points, firstDay, now, staleMs);
      const allBursts = findBursts(allHours);
      const from = new Date(burstsFrom(points[0]?.[0] ?? now, now)).setHours(0, 0, 0, 0);
      const hours = allHours.filter((hour) => hour.start >= from);
      const bursts = allBursts.filter((burst) => burst.end > from);
      const others = accounts.filter((a) => a.provider === account.provider && a !== account);
      const covering = new Map<number, AccountView>();
      for (const burst of bursts) {
        const middle = (burst.start + burst.end) / 2;
        const out = others.find((other) => lockedAt(history.series[other.name], middle, staleMs));
        if (out) covering.set(burst.start, out);
      }
      return {
        account,
        windows,
        hours,
        days: burstDays(hours, windows, from, now),
        bursts,
        // A window that began before the readings would undercount its bursts.
        splits: windowSplits(
          windows.filter((w) => w.startMs >= firstDay),
          allBursts,
          allHours
        ),
        used: hours.reduce((sum, hour) => sum + (hour.used ?? 0), 0),
        covering,
      };
    });
  }, [history, accounts, now]);

  // One scale for every account, so a tall line means the same use on each card.
  const scale = Math.max(
    BURST_LINE * 2,
    Math.ceil(Math.max(0, ...entries.flatMap((e) => e.hours.map((h) => h.used ?? 0))) / RISE_ROWS)
  );
  const firstFull = entries.find((e) => e.used >= QUIET);

  return (
    <>
      {entries.map((entry) => (
        <BurstCard
          key={entry.account.name}
          entry={entry}
          scale={scale}
          showLegend={entry === firstFull}
          now={now}
          theme={theme}
          t={t}
          language={i18n.language}
        />
      ))}
    </>
  );
}

/** One account's card; an account barely used gets its headline alone. */
function BurstCard({
  entry,
  scale,
  showLegend,
  now,
  theme,
  t,
  language,
}: {
  entry: Entry;
  scale: number;
  showLegend: boolean;
  now: number;
  theme: ResolvedTheme;
  t: TFunction;
  language: string;
}) {
  const [burstAt, setBurstAt] = useState<number | null>(null);
  const biggest = [...entry.bursts].sort((a, b) => b.used - a.used)[0] ?? null;
  const burst = entry.bursts.find((b) => b.start === burstAt) ?? biggest;
  const { headline, sub } = burstHeadline(entry, biggest, now, t, language);
  const quiet = entry.used < QUIET;

  return (
    <section className={styles.card} data-compact={quiet ? 1 : 0}>
      <header className={styles.cardHead}>
        <div className={styles.cardTitle}>
          <ProviderIcon provider={entry.account.provider} theme={theme} size={22} />
          <div>
            <h2 className={styles.headline}>{headline}</h2>
            {sub && <p className={styles.subline}>{sub}</p>}
          </div>
        </div>
      </header>

      {!quiet && (
        <div className={styles.layout}>
          <div className={styles.main}>
            <div className={styles.drum}>
              <div className={styles.drumAxis}>
                <span />
                <div className={styles.drumHours}>
                  {[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => (
                    <span
                      key={hour}
                      style={{ left: `${(hour / 24) * 100}%` }}
                      data-minor={hour % 6 ? 1 : 0}
                    >
                      {String(hour).padStart(2, '0')}
                    </span>
                  ))}
                </div>
                <span className={styles.drumTotalHead}>{t('usage.bursts_per_day')}</span>
              </div>
              {entry.days.map((day) => (
                <DrumRow
                  key={day.dayStart}
                  day={day}
                  bursts={entry.bursts}
                  windows={entry.windows}
                  scale={scale}
                  selected={burst}
                  onSelect={setBurstAt}
                  now={now}
                  t={t}
                />
              ))}
            </div>
            {showLegend && (
              <footer className={styles.legend}>
                <LegendItem swatch={styles.swatchHourLine}>
                  {t('usage.legend_hour_line', { value: pct(scale) })}
                </LegendItem>
                <LegendItem swatch={styles.swatchUsed}>{t('usage.legend_burst')}</LegendItem>
                <LegendItem swatch={styles.swatchLocked}>
                  {t('usage.legend_locked_short')}
                </LegendItem>
                <LegendItem swatch={styles.swatchRunsOutDot}>
                  {t('usage.legend_ran_out')}
                </LegendItem>
                <LegendItem swatch={styles.swatchReset}>{t('usage.legend_reset')}</LegendItem>
                <LegendItem swatch={styles.swatchUnread}>{t('usage.legend_no_reading')}</LegendItem>
                <LegendItem swatch={styles.swatchWork}>{t('usage.legend_work_hours')}</LegendItem>
                <span className={styles.legendNote}>
                  {t('usage.bursts_note', { value: pct(BURST_LINE) })}
                </span>
              </footer>
            )}
          </div>

          <BurstDetail
            entry={entry}
            burst={burst}
            onSelect={setBurstAt}
            theme={theme}
            t={t}
            language={language}
          />
        </div>
      )}
    </section>
  );
}

function burstHeadline(
  entry: Entry,
  biggest: Burst | null,
  now: number,
  t: TFunction,
  language: string
) {
  const { account, bursts, used } = entry;
  const since = formatMonthDay(entry.days[0]?.dayStart ?? now, language);
  if (used < QUIET) {
    // Out of its limit is not the same as unused.
    const out = entry.windows.find((w) => w.current && w.lockedFrom !== null);
    return {
      headline: out
        ? t('usage.bursts_headline_out', {
            account: account.label,
            time: formatWhen(out.endMs, now, t),
          })
        : t('usage.bursts_headline_quiet', { account: account.label, date: since }),
      sub: '',
    };
  }
  if (!biggest) {
    return {
      headline: t('usage.bursts_headline_none', { account: account.label }),
      sub: t('usage.bursts_sub_none', { value: pct(BURST_LINE), date: since }),
    };
  }
  const share = Math.round((bursts.reduce((sum, b) => sum + b.used, 0) / used) * 100);
  const headline = t(share >= 50 ? 'usage.bursts_headline' : 'usage.bursts_headline_some', {
    account: account.label,
    count: bursts.length,
    share,
  });
  const covered = bursts.filter((b) => entry.covering.has(b.start));
  const other = covered[0] ? entry.covering.get(covered[0].start) : undefined;
  const sub = [
    other
      ? covered.length === bursts.length
        ? t('usage.bursts_sub_cover_all', { other: other.label })
        : t('usage.bursts_sub_cover', {
            covered: covered.length,
            total: bursts.length,
            other: other.label,
          })
      : '',
    t('usage.bursts_sub_biggest', {
      time: `${weekday(biggest.start, t)} ${formatTime(biggest.start)}`,
      used: pct(biggest.used),
      hours: t('usage.hours', { count: Math.round((biggest.end - biggest.start) / HOUR_MS) }),
    }),
  ];
  return { headline, sub: sub.filter(Boolean).join(' ') };
}

/* --------------------------------------------------------------- drum */

/**
 * A smooth line through each hour's use at the hour's centre, in hour and
 * percent units. Catmull-Rom, so it passes through every value instead of
 * rounding peaks off, and never dips below zero.
 */
function ridge(values: (number | null)[], from: number, to: number) {
  const points: [number, number][] = [[from, 0]];
  for (let h = from; h < to; h += 1) points.push([h + 0.5, values[h] ?? 0]);
  points.push([to, 0]);
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const [p1, p2] = [points[i], points[i + 1]];
    const p3 = points[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, Math.max(0, p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, Math.max(0, p2[1] - (p3[1] - p1[1]) / 6)];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/** Runs of hours with readings, so a silence draws as a gap rather than a flat zero. */
function readRuns(hours: HourUse[], dayStart: number) {
  const runs: [number, number][] = [];
  hours.forEach((hour) => {
    const h = Math.round((hour.start - dayStart) / HOUR_MS);
    if (hour.used === null) return;
    const open = runs[runs.length - 1];
    if (open && open[1] === h) open[1] = h + 1;
    else runs.push([h, h + 1]);
  });
  return runs;
}

function DrumRow({
  day,
  bursts,
  windows,
  scale,
  selected,
  onSelect,
  now,
  t,
}: {
  day: BurstDay;
  bursts: Burst[];
  windows: UsageWindow[];
  scale: number;
  selected: Burst | null;
  onSelect: (start: number) => void;
  now: number;
  t: TFunction;
}) {
  const clipId = useId().replace(/:/g, '');
  const dayEnd = day.dayStart + 24 * HOUR_MS;
  const values = Array.from({ length: 24 }, () => null as number | null);
  day.hours.forEach((hour) => {
    values[Math.round((hour.start - day.dayStart) / HOUR_MS)] = hour.used;
  });
  const runs = readRuns(day.hours, day.dayStart);
  const toPercent = (ms: number) => ((ms - day.dayStart) / (24 * HOUR_MS)) * 100;
  const own = bursts.filter((b) => b.end > day.dayStart && b.start < dayEnd);
  const ranOut = windows
    .map((w) => w.ranOutAt)
    .filter((ms): ms is number => ms !== null && ms >= day.dayStart && ms < dayEnd);
  const date = new Date(day.dayStart);
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  const isToday = now < dayEnd;
  const max = scale * RISE_ROWS;

  return (
    <div className={styles.drumRow} data-weekend={weekend ? 1 : 0}>
      <span className={styles.drumDate}>
        <b>{weekday(day.dayStart, t)}</b> {date.getDate()}
      </span>
      <div className={styles.drumTrack}>
        {!weekend && (
          <span
            className={styles.drumWork}
            style={{
              left: `${(WORK_HOURS.startHour / 24) * 100}%`,
              width: `${((WORK_HOURS.endHour - WORK_HOURS.startHour) / 24) * 100}%`,
            }}
          />
        )}
        <svg
          className={styles.drumLine}
          viewBox={`0 ${-max} 24 ${max}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line
            className={styles.drumUnread}
            x1={0}
            x2={isToday ? toPercent(now) * 0.24 : 24}
            y1={0}
            y2={0}
          />
          {runs.map(([from, to]) => (
            <path
              key={from}
              className={styles.drumRidge}
              d={ridge(values, from, to)}
              transform="scale(1,-1)"
            />
          ))}
          {own.map((b) => {
            // The burst is the same line, drawn bright over its own hours.
            const from = Math.max(0, Math.round((b.start - day.dayStart) / HOUR_MS));
            const to = Math.min(24, Math.round((b.end - day.dayStart) / HOUR_MS));
            const run = runs.find(([a, z]) => a <= from && z >= to) ?? [from, to];
            return (
              <g key={b.start}>
                <clipPath id={`${clipId}-${b.start}`}>
                  <rect x={from} y={-1} width={to - from} height={max + 2} />
                </clipPath>
                <path
                  className={styles.drumBurst}
                  data-selected={b === selected ? 1 : 0}
                  d={ridge(values, run[0], run[1])}
                  transform="scale(1,-1)"
                  clipPath={`url(#${clipId}-${b.start})`}
                />
              </g>
            );
          })}
        </svg>
        {day.locked.map((lock) => (
          <span
            key={lock.from}
            className={styles.drumLocked}
            style={{
              left: `${toPercent(lock.from)}%`,
              width: `${toPercent(lock.to) - toPercent(lock.from)}%`,
            }}
          />
        ))}
        {day.resets.map((ms) => (
          <span key={ms} className={styles.drumReset} style={{ left: `${toPercent(ms)}%` }}>
            <span>{t('usage.reset')}</span>
          </span>
        ))}
        {ranOut.map((ms) => (
          <span key={ms} className={styles.drumRanOut} style={{ left: `${toPercent(ms)}%` }} />
        ))}
        {isToday && <span className={styles.drumNow} style={{ left: `${toPercent(now)}%` }} />}
        {own
          .filter((b) => b.start >= day.dayStart)
          .map((b) => (
            <button
              key={b.start}
              type="button"
              className={styles.burstLabel}
              data-selected={b === selected ? 1 : 0}
              style={{
                left: `${toPercent((b.start + b.end) / 2)}%`,
                bottom: `${Math.min(RISE_ROWS, b.peak / scale) * 100}%`,
              }}
              onClick={() => onSelect(b.start)}
            >
              {t('usage.burst_label', {
                used: pct(b.used),
                hours: t('usage.hours', { count: Math.round((b.end - b.start) / HOUR_MS) }),
              })}
            </button>
          ))}
      </div>
      <span className={styles.drumTotal}>{day.used === null ? '–' : pct(day.used)}</span>
    </div>
  );
}

/* ------------------------------------------------------------- detail */

const CHART = { width: 360, height: 180, left: 30, right: 10, top: 22, bottom: 24 };

function BurstDetail({
  entry,
  burst,
  onSelect,
  theme,
  t,
  language,
}: {
  entry: Entry;
  burst: Burst | null;
  onSelect: (start: number) => void;
  theme: ResolvedTheme;
  t: TFunction;
  language: string;
}) {
  const { account } = entry;
  const home = burst
    ? entry.splits.find((s) => burst.start >= s.window.startMs && burst.start < s.window.endMs)
    : undefined;
  const other = burst ? entry.covering.get(burst.start) : undefined;
  const hours = Math.round(burst ? (burst.end - burst.start) / HOUR_MS : 0);

  return (
    <aside className={styles.detail}>
      <div className={styles.detailHead}>
        <ProviderIcon provider={account.provider} theme={theme} size={26} />
        <div>
          <h3>{account.label}</h3>
          <p>{`${PROVIDER_NAMES[account.provider]} · ${account.email}`}</p>
        </div>
      </div>

      {burst ? (
        <>
          <p className={styles.detailLead}>
            {t('usage.burst_lead', {
              day: `${weekday(burst.start, t)} ${formatMonthDay(burst.start, language)}`,
              from: formatTime(burst.start),
              to: formatTime(burst.end),
              used: pct(burst.used),
              hours: t('usage.hours', { count: hours }),
            })}
            {other && ` ${t('usage.burst_lead_cover', { other: other.label })}`}
          </p>
          <BurstChart entry={entry} burst={burst} t={t} />
          <div className={styles.stats}>
            <Stat label={t('usage.stat_burst_size')} value={`${pct(burst.used)}%`} />
            <Stat label={t('usage.stat_duration')} value={t('usage.hours', { count: hours })} />
            <Stat
              label={t('usage.stat_share_of_week')}
              value={home && home.used > 0 ? `${Math.round((burst.used / home.used) * 100)}%` : '–'}
            />
          </div>
        </>
      ) : (
        <p className={styles.detailLead}>{t('usage.burst_none_selected')}</p>
      )}

      <SplitBars splits={entry.splits.slice(-6)} t={t} language={language} />

      {entry.bursts.length > 0 && (
        <div className={styles.subChart}>
          <h4>{t('usage.bursts_list')}</h4>
          <ol className={styles.burstList}>
            {[...entry.bursts].reverse().map((b) => (
              <li key={b.start}>
                <button type="button" aria-pressed={b === burst} onClick={() => onSelect(b.start)}>
                  <span>{`${weekday(b.start, t)} ${formatMonthDay(b.start, language)} ${formatTime(b.start)}–${formatTime(b.end)}`}</span>
                  <b>
                    {t('usage.burst_label', {
                      used: pct(b.used),
                      hours: t('usage.hours', { count: Math.round((b.end - b.start) / HOUR_MS) }),
                    })}
                  </b>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </aside>
  );
}

function BurstChart({ entry, burst, t }: { entry: Entry; burst: Burst; t: TFunction }) {
  const hatchId = useId().replace(/:/g, '');
  const from = burst.start - 3 * HOUR_MS;
  const to = burst.end + 3 * HOUR_MS;
  const hours = entry.hours.filter((h) => h.start >= from && h.start < to);
  const plotW = CHART.width - CHART.left - CHART.right;
  const plotH = CHART.height - CHART.top - CHART.bottom;
  const max = Math.max(BURST_LINE * 2, ...hours.map((h) => h.used ?? 0)) * 1.15;
  const x = (ms: number) => CHART.left + ((ms - from) / (to - from)) * plotW;
  const y = (value: number) => CHART.top + plotH - (value / max) * plotH;
  const known = hours.filter((h) => h.used !== null);
  const line = known
    .map(
      (h, i) =>
        `${i ? 'L' : 'M'}${x(h.start + HOUR_MS / 2).toFixed(1)},${y(h.used as number).toFixed(1)}`
    )
    .join(' ');
  const locks = entry.windows
    .filter((w) => w.lockedFrom !== null && w.lockedFrom < to && w.endMs > from)
    .map((w) => [Math.max(from, w.lockedFrom as number), Math.min(to, w.endMs)] as const);
  const ticks = [0, Math.round(max / 2), Math.floor(max)];

  return (
    <svg
      className={styles.chart}
      viewBox={`0 0 ${CHART.width} ${CHART.height}`}
      role="img"
      aria-label={t('usage.burst_chart_label')}
    >
      <HatchPattern id={hatchId} />
      <rect
        className={styles.burstBand}
        x={x(burst.start)}
        y={CHART.top}
        width={x(burst.end) - x(burst.start)}
        height={plotH}
      />
      {locks.map(([a, b]) => (
        <rect
          key={a}
          x={x(a)}
          y={CHART.top}
          width={x(b) - x(a)}
          height={plotH}
          fill={`url(#${hatchId})`}
          className={styles.lockedArea}
        />
      ))}
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            className={styles.gridLine}
            x1={CHART.left}
            x2={CHART.width - CHART.right}
            y1={y(tick)}
            y2={y(tick)}
          />
          <text className={styles.axisText} x={CHART.left - 5} y={y(tick) + 3.5} textAnchor="end">
            {tick}
          </text>
        </g>
      ))}
      <line
        className={styles.allowedLine}
        x1={CHART.left}
        x2={CHART.width - CHART.right}
        y1={y(BURST_LINE)}
        y2={y(BURST_LINE)}
      />
      <path className={styles.usedLine} d={line} />
      {known.map((h) => {
        const inside = h.start >= burst.start && h.start < burst.end;
        return (
          <g key={h.start}>
            <circle
              className={inside ? styles.hoverDot : styles.quietDot}
              cx={x(h.start + HOUR_MS / 2)}
              cy={y(h.used as number)}
              r={inside ? 3 : 2}
            />
            {inside && (
              <text
                className={styles.barValue}
                x={x(h.start + HOUR_MS / 2)}
                y={y(h.used as number) - 7}
                textAnchor="middle"
              >
                {pct(h.used as number)}
              </text>
            )}
          </g>
        );
      })}
      {hours
        .filter((h) => new Date(h.start).getHours() % 2 === 0)
        .map((h) => (
          <text
            key={h.start}
            className={styles.axisText}
            x={x(h.start)}
            y={CHART.height - 6}
            textAnchor="middle"
          >
            {String(new Date(h.start).getHours()).padStart(2, '0')}
          </text>
        ))}
    </svg>
  );
}

const SPLIT = { width: 360, height: 150, left: 8, right: 8, top: 22, bottom: 24 };

function SplitBars({
  splits,
  t,
  language,
}: {
  splits: WindowSplit[];
  t: TFunction;
  language: string;
}) {
  if (splits.length === 0) return null;
  const plotW = SPLIT.width - SPLIT.left - SPLIT.right;
  const plotH = SPLIT.height - SPLIT.top - SPLIT.bottom;
  const slot = plotW / splits.length;
  const barW = Math.min(30, slot * 0.6);
  const y = (value: number) => SPLIT.top + plotH - (Math.min(100, value) / 100) * plotH;

  return (
    <div className={styles.subChart}>
      <h4>
        {t('usage.split_title')} <span>· {t('usage.split_unit')}</span>
      </h4>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${SPLIT.width} ${SPLIT.height}`}
        role="img"
        aria-label={t('usage.split_title')}
      >
        <line
          className={styles.allowedLine}
          x1={SPLIT.left}
          x2={SPLIT.width - SPLIT.right}
          y1={y(100)}
          y2={y(100)}
        />
        {splits.map((split, i) => {
          const cx = SPLIT.left + slot * i + slot / 2;
          const other = Math.max(0, split.used - split.inBursts);
          return (
            <g key={split.window.resetMs} data-current={split.window.current ? 1 : 0}>
              <rect
                className={styles.barOther}
                x={cx - barW / 2}
                y={y(split.used)}
                width={barW}
                height={Math.max(0, y(split.inBursts) - y(split.used))}
                rx={2}
              >
                <title>{`${t('usage.legend_other_use')}: ${pct(other)}%`}</title>
              </rect>
              <rect
                className={styles.barBursts}
                x={cx - barW / 2}
                y={y(split.inBursts)}
                width={barW}
                height={Math.max(0, y(0) - y(split.inBursts))}
                rx={2}
              >
                <title>{`${t('usage.legend_in_bursts')}: ${pct(split.inBursts)}%`}</title>
              </rect>
              <text className={styles.barValue} x={cx} y={y(split.used) - 5} textAnchor="middle">
                {Math.round(split.used)}
              </text>
              <text className={styles.axisText} x={cx} y={SPLIT.height - 6} textAnchor="middle">
                {split.window.current
                  ? t('usage.this_window_short')
                  : formatMonthDay(split.window.startMs, language)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className={styles.legend}>
        <LegendItem swatch={styles.swatchBursts}>{t('usage.legend_in_bursts')}</LegendItem>
        <LegendItem swatch={styles.swatchOther}>{t('usage.legend_other_use')}</LegendItem>
        <LegendItem swatch={styles.swatchAllowed}>{t('usage.legend_limit')}</LegendItem>
      </div>
    </div>
  );
}
