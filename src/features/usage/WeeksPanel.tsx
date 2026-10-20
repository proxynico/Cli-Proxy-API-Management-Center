/**
 * Weeks: for each provider, whether an account had room through each week,
 * and how the work moved between accounts when one ran out.
 */

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ResolvedTheme } from '@/types';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import {
  CELL_MS,
  PROVIDER_NAMES,
  PROVIDER_ORDER,
  WEEK_MS,
  WORK_HOURS,
  handOffEvents,
  lockedAt,
  staleAfterMs,
  usedAt,
  weekRows,
} from './usageModel';
import type { AccountView, UsageHistory, UsageProvider, WeekRow } from './usageModel';
import {
  formatDuration,
  formatHours,
  formatMonthDay,
  formatTime,
  formatWhen,
  weekday,
} from './format';
import { HatchPattern, LegendItem, ProviderIcon, Segmented, Stat } from './parts';
import { useCrosshair } from './useCrosshair';
import styles from './UsagePage.module.scss';

interface Props {
  history: UsageHistory;
  accounts: AccountView[];
  now: number;
  theme: ResolvedTheme;
}

interface Group {
  provider: UsageProvider;
  accounts: AccountView[];
  rows: WeekRow[];
}

/** Any Monday, for the column headings. */
const A_MONDAY = new Date(2026, 9, 19).getTime();
const workHours = (ms: number) => Math.round(ms / HOUR_MS);

export function WeeksPanel({ history, accounts, now, theme }: Props) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<'weeks' | 'handoff'>('weeks');

  const groups = useMemo<Group[]>(
    () =>
      PROVIDER_ORDER.map((provider) => {
        const own = accounts.filter((a) => a.provider === provider);
        const rows = own.length ? weekRows(history, own, now) : [];
        // Weeks before recording began are empty rows; they'd only push the real ones down.
        const first = rows.findIndex((row) => row.hasData);
        return { provider, accounts: own, rows: rows.slice(first < 0 ? rows.length - 1 : first) };
      }).filter((group) => group.accounts.length > 0),
    [history, accounts, now]
  );

  const covered = groups.filter((g) => g.accounts.length > 1);
  const lastWeek = (g: Group) => g.rows[g.rows.length - 2];
  const thisWeek = (g: Group) => g.rows[g.rows.length - 1];
  const worst = (pick: (g: Group) => number) =>
    [...covered].sort((a, b) => pick(b) - pick(a)).find((g) => pick(g) > 0);

  const lastWorst = worst((g) => lastWeek(g)?.noneFreeWorkMs ?? 0);
  const nowWorst = worst((g) => thisWeek(g)?.noneFreeWorkMs ?? 0);
  const paceWorst = worst((g) => thisWeek(g)?.forecastNoneFreeWorkMs ?? 0);
  const headline = lastWorst
    ? t('usage.weeks_headline_last', {
        provider: PROVIDER_NAMES[lastWorst.provider],
        count: workHours(lastWeek(lastWorst).noneFreeWorkMs),
      })
    : nowWorst
      ? t('usage.weeks_headline_now', {
          provider: PROVIDER_NAMES[nowWorst.provider],
          count: workHours(thisWeek(nowWorst).noneFreeWorkMs),
        })
      : paceWorst
        ? t('usage.weeks_headline_pace', {
            provider: PROVIDER_NAMES[paceWorst.provider],
            count: workHours(thisWeek(paceWorst).forecastNoneFreeWorkMs ?? 0),
          })
        : t('usage.weeks_headline_clear');

  const focus = lastWorst ?? nowWorst ?? paceWorst ?? covered[0] ?? groups[0];
  const defaultWeek = (g: Group) =>
    g === lastWorst && lastWeek(g) ? lastWeek(g).weekStart : thisWeek(g).weekStart;
  const [selection, setSelection] = useState<{ provider: UsageProvider; weekStart: number } | null>(
    null
  );
  const group = groups.find((g) => g.provider === selection?.provider) ?? focus;
  const row =
    group.rows.find((r) => r.weekStart === selection?.weekStart) ??
    group.rows.find((r) => r.weekStart === defaultWeek(group)) ??
    thisWeek(group);

  const sub = useMemo(() => {
    const gapRow = lastWorst ? lastWeek(lastWorst) : nowWorst ? thisWeek(nowWorst) : null;
    if (gapRow?.firstGap) {
      const from = gapRow.firstGap.from;
      const ranOut = handOffEvents(history, focus.accounts, gapRow.weekStart, now)
        .filter((e) => e.kind === 'ranOut' && e.at <= from)
        .slice(-2)
        .map((e) => e.account?.label ?? '');
      return t('usage.weeks_sub_gap', {
        day: weekday(from, t),
        time: formatTime(from),
        accounts: ranOut.join(t('usage.and_then')),
      });
    }
    const staleMs = staleAfterMs(history);
    const locks = focus.accounts.map((a) => lockedAt(history.series[a.name], now, staleMs));
    const out = focus.accounts.find((_, i) => locks[i] === true);
    const cover = focus.accounts.find((_, i) => locks[i] === false);
    return out && cover
      ? t('usage.weeks_sub_covering', { account: out.label, cover: cover.label })
      : null;
  }, [focus, history, lastWorst, nowWorst, now, t]);

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
            { value: 'weeks', label: t('usage.view_weeks') },
            { value: 'handoff', label: t('usage.view_handoff') },
          ]}
        />
      </header>

      <div className={styles.layout}>
        <div className={styles.main}>
          {view === 'handoff' ? (
            <HandOffList history={history} group={group} now={now} t={t} language={i18n.language} />
          ) : (
            <>
              <div className={styles.scroller}>
                <div className={styles.weeksGrid}>
                  <div className={styles.axisRow}>
                    <span className={styles.axisCaption}>{t('usage.week_of')}</span>
                    <div className={styles.axisDays}>
                      {Array.from({ length: 7 }, (_, i) => (
                        <span key={i}>{weekday(A_MONDAY + i * DAY_MS, t)}</span>
                      ))}
                    </div>
                    <span className={styles.axisCaption}>{t('usage.col_work_hours')}</span>
                  </div>

                  {groups.map((g) =>
                    g.accounts.length > 1 ? (
                      <ProviderWeeks
                        key={g.provider}
                        group={g}
                        now={now}
                        theme={theme}
                        selected={g === group ? row.weekStart : null}
                        onSelect={(weekStart) => setSelection({ provider: g.provider, weekStart })}
                        t={t}
                        language={i18n.language}
                      />
                    ) : (
                      <SingleAccount
                        key={g.provider}
                        group={g}
                        history={history}
                        theme={theme}
                        t={t}
                        language={i18n.language}
                      />
                    )
                  )}
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
                <LegendItem swatch={styles.swatchLocked}>
                  {t('usage.legend_locked_short')}
                </LegendItem>
                <LegendItem swatch={styles.swatchReset}>{t('usage.legend_reset')}</LegendItem>
                <span className={styles.legendGroup}>
                  {t('usage.legend_accounts_free')}
                  <LegendItem swatch={styles.freeAll}>{t('usage.free_all')}</LegendItem>
                  <LegendItem swatch={styles.freeSome}>{t('usage.free_some')}</LegendItem>
                  <LegendItem swatch={styles.freeNone}>{t('usage.free_none')}</LegendItem>
                  <LegendItem swatch={styles.freeNoneWork}>{t('usage.free_none_work')}</LegendItem>
                  <LegendItem swatch={styles.freeForecast}>{t('usage.legend_on_pace')}</LegendItem>
                  <LegendItem swatch={styles.swatchNone}>{t('usage.legend_no_reading')}</LegendItem>
                </span>
                <span className={styles.legendNote}>
                  {t('usage.legend_weeks_note', {
                    start: `${String(WORK_HOURS.startHour).padStart(2, '0')}:00`,
                    end: `${String(WORK_HOURS.endHour).padStart(2, '0')}:00`,
                  })}
                </span>
              </footer>
            </>
          )}
        </div>

        <WeekDetail
          history={history}
          group={group}
          row={row}
          now={now}
          theme={theme}
          t={t}
          language={i18n.language}
        />
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- grid */

function ProviderWeeks({
  group,
  now,
  theme,
  selected,
  onSelect,
  t,
  language,
}: {
  group: Group;
  now: number;
  theme: ResolvedTheme;
  selected: number | null;
  onSelect: (weekStart: number) => void;
  t: TFunction;
  language: string;
}) {
  return (
    <div className={styles.providerBlock}>
      <div className={styles.providerHead}>
        <span className={styles.rowLabel}>
          <ProviderIcon provider={group.provider} theme={theme} />
          <span className={styles.rowName}>{PROVIDER_NAMES[group.provider]}</span>
        </span>
        <span className={styles.providerKey}>
          {group.accounts.map((account, i) => (
            <span key={account.name}>
              <span className={styles.keyBar} data-index={i} aria-hidden="true" />
              {account.label.replace(`${PROVIDER_NAMES[group.provider]} `, '')}
            </span>
          ))}
          <span>
            <span className={styles.keyBar} data-index="free" aria-hidden="true" />
            {t('usage.legend_accounts_free')}
          </span>
        </span>
      </div>

      {group.rows.map((row) => {
        const firstKnown = row.free.findIndex((state) => state !== 'unknown' && state !== 'future');
        const partialFrom = firstKnown > 0 ? row.weekStart + firstKnown * CELL_MS : null;
        return (
          <div
            key={row.weekStart}
            className={styles.weekRow}
            data-selected={selected === row.weekStart ? 1 : 0}
          >
            <button
              type="button"
              className={styles.weekLabel}
              onClick={() => onSelect(row.weekStart)}
              aria-pressed={selected === row.weekStart}
            >
              <span>{formatMonthDay(row.weekStart, language)}</span>
              {row.isCurrent ? (
                <small>{t('usage.this_week')}</small>
              ) : (
                partialFrom && (
                  <small>
                    {t('usage.from_time', {
                      time: `${weekday(partialFrom, t)} ${formatTime(partialFrom)}`,
                    })}
                  </small>
                )
              )}
            </button>
            <div className={styles.weekTracks} onClick={() => onSelect(row.weekStart)}>
              {row.accounts.map(({ account, cells }) => (
                <div key={account.name} className={styles.weekTrack}>
                  {cells.map((cell) => (
                    <span
                      key={cell.start}
                      className={styles.cell}
                      data-state={cell.state === 'future' ? 'none' : cell.state}
                      data-level={cell.level}
                      title={`${account.label} · ${weekday(cell.start, t)} ${formatTime(cell.start)}`}
                    >
                      {cell.resetAt !== null && (
                        <span
                          className={styles.cellReset}
                          style={{ left: `${cell.resetAt * 100}%` }}
                        />
                      )}
                    </span>
                  ))}
                </div>
              ))}
              <div className={styles.weekTrack}>
                {row.free.map((state, i) => (
                  <span
                    key={i}
                    className={styles.cell}
                    data-free={state}
                    title={`${weekday(row.weekStart + i * CELL_MS, t)} ${formatTime(row.weekStart + i * CELL_MS)} · ${t(`usage.free_state_${state}`)}`}
                  />
                ))}
              </div>
              {row.isCurrent && now >= row.weekStart && now < row.weekStart + WEEK_MS && (
                <span
                  className={styles.nowTick}
                  style={{ left: `${((now - row.weekStart) / WEEK_MS) * 100}%` }}
                />
              )}
            </div>
            <span className={styles.rowSummary}>
              <WeekSummary row={row} now={now} t={t} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

function WeekSummary({ row, now, t }: { row: WeekRow; now: number; t: TFunction }) {
  if (!row.hasData) return <span className={styles.muted}>{t('usage.no_readings')}</span>;
  const peaks = row.accounts
    .map((a) => (a.peak === null ? '–' : `${Math.round(a.peak)}%`))
    .join(', ');
  if (row.isCurrent && (row.forecastNoneFreeWorkMs ?? 0) > row.noneFreeWorkMs) {
    return (
      <>
        <b data-tone="danger">
          {t('usage.none_free_pace', { hours: workHours(row.forecastNoneFreeWorkMs ?? 0) })}
        </b>
        {row.forecastGapFrom && (
          <span className={styles.muted}>
            {t('usage.on_pace_from', { time: formatWhen(row.forecastGapFrom, now, t) })}
          </span>
        )}
      </>
    );
  }
  if (row.noneFreeMs > 0 && row.firstGap) {
    return (
      <>
        <b data-tone="danger">
          {t('usage.none_free', { hours: formatHours(row.noneFreeWorkMs || row.noneFreeMs, t) })}
        </b>
        <span className={styles.muted}>
          {`${weekday(row.firstGap.from, t)} ${formatTime(row.firstGap.from)} → ${weekday(row.firstGap.to, t)} ${formatTime(row.firstGap.to)}`}
        </span>
      </>
    );
  }
  return (
    <>
      <span>{t('usage.covered')}</span>
      <span className={styles.muted}>{t('usage.peaks', { values: peaks })}</span>
    </>
  );
}

function SingleAccount({
  group,
  history,
  theme,
  t,
  language,
}: {
  group: Group;
  history: UsageHistory;
  theme: ResolvedTheme;
  t: TFunction;
  language: string;
}) {
  const account = group.accounts[0];
  const lockedMs = group.rows.reduce((sum, row) => sum + row.noneFreeMs, 0);
  const firstReading = Math.min(
    ...Object.values(history.series[account.name] ?? {}).map(
      (points) => points?.[0]?.[0] ?? Infinity
    )
  );
  const thisWeek = group.rows[group.rows.length - 1];
  const status =
    lockedMs > 0
      ? t('usage.single_locked', { duration: formatDuration(thisWeek.noneFreeMs || lockedMs, t) })
      : Number.isFinite(firstReading)
        ? t('usage.single_never_since', { date: formatMonthDay(firstReading, language) })
        : t('usage.no_readings');

  return (
    <div className={styles.singleRow}>
      <span className={styles.rowLabel}>
        <ProviderIcon provider={group.provider} theme={theme} />
        <span className={styles.rowName}>{account.label}</span>
      </span>
      <span className={styles.singleText}>
        {t('usage.single_account')} {status}
      </span>
      <span className={styles.rowSummary}>
        <span className={styles.muted}>{t('usage.one_account')}</span>
        <span className={styles.muted}>{t('usage.no_cover')}</span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------- detail */

const CHART = { width: 360, height: 200, left: 38, right: 10, top: 14, bottom: 26 };
const PLOT_W = CHART.width - CHART.left - CHART.right;
const PLOT_H = CHART.height - CHART.top - CHART.bottom;
const SAMPLE_MS = 30 * 60_000;

function WeekDetail({
  history,
  group,
  row,
  now,
  theme,
  t,
  language,
}: {
  history: UsageHistory;
  group: Group;
  row: WeekRow;
  now: number;
  theme: ResolvedTheme;
  t: TFunction;
  language: string;
}) {
  const hatchId = useId().replace(/:/g, '');
  const { fraction, onMove, onLeave } = useCrosshair(CHART.left, PLOT_W, CHART.width);
  const staleMs = staleAfterMs(history);
  const start = row.weekStart;
  const end = start + WEEK_MS;
  const until = Math.min(end, now);
  const x = (ms: number) => CHART.left + ((ms - start) / WEEK_MS) * PLOT_W;
  const y = (pct: number) => CHART.top + PLOT_H - (Math.min(100, pct) / 100) * PLOT_H;

  const lines = group.accounts.map((account) => {
    const points = history.series[account.name]?.['7d'] ?? [];
    let d = '';
    let open = false;
    for (let ms = start; ms <= until; ms += SAMPLE_MS) {
      const used = usedAt(points, ms, staleMs);
      if (used === null) {
        open = false;
        continue;
      }
      d += `${open ? 'L' : 'M'}${x(ms).toFixed(1)},${y(used).toFixed(1)} `;
      open = true;
    }
    return { account, d };
  });

  const gaps: { from: number; to: number }[] = [];
  for (let ms = start; ms < until; ms += 10 * 60_000) {
    const none = group.accounts.every(
      (a) => lockedAt(history.series[a.name], ms, staleMs) === true
    );
    const last = gaps[gaps.length - 1];
    if (none && last && last.to === ms) last.to = ms + 10 * 60_000;
    else if (none) gaps.push({ from: ms, to: ms + 10 * 60_000 });
  }
  const events = handOffEvents(history, group.accounts, start, now);
  const ranOut = events.filter((e) => e.kind === 'ranOut');

  // An account already out at its first reading this week ran out unseen; the lead says so.
  const outUnread = group.accounts.find((account) => {
    const first = (history.series[account.name]?.['7d'] ?? []).find((p) => p[0] >= start);
    return first !== undefined && first[0] <= until && first[1] >= 100;
  });
  const sole = Object.entries(row.soleCoverMs).sort((a, b) => b[1] - a[1])[0];
  const soleAccount = group.accounts.find((a) => a.name === sole?.[0]);
  const gapFrom = row.firstGap?.from ?? 0;
  const lastBeforeGap = ranOut.filter((e) => e.at <= gapFrom).pop();
  const lead = !row.hasData
    ? t('usage.week_lead_none')
    : row.firstGap
      ? t('usage.week_lead_gap', {
          account: lastBeforeGap?.account?.label ?? PROVIDER_NAMES[group.provider],
          time: formatWhen(row.firstGap.from, now, t),
          until: formatWhen(row.firstGap.to, now, t),
        })
      : ranOut.length > 0
        ? t('usage.week_lead_covered', {
            account: ranOut[0].account?.label ?? '',
            time: formatWhen(ranOut[0].at, now, t),
            cover: soleAccount?.label ?? '',
          })
        : outUnread
          ? t('usage.week_lead_out_unread', { account: outUnread.label })
          : t('usage.week_lead_clear');

  const hoverMs = fraction === null ? null : start + fraction * WEEK_MS;
  const hoverValues =
    hoverMs === null || hoverMs > now
      ? null
      : group.accounts.map((a) => usedAt(history.series[a.name]?.['7d'] ?? [], hoverMs, staleMs));

  const days = Array.from({ length: 7 }, (_, i) => start + i * DAY_MS);

  return (
    <aside className={styles.detail}>
      <div className={styles.detailHead}>
        <ProviderIcon provider={group.provider} theme={theme} size={26} />
        <div>
          <h3>{PROVIDER_NAMES[group.provider]}</h3>
          <p>
            {t('usage.week_meta', {
              accounts: group.accounts.map((a) => a.label).join(', '),
              date: formatMonthDay(start, language),
            })}
          </p>
        </div>
      </div>
      <p className={styles.detailLead}>{lead}</p>

      <svg
        className={styles.chart}
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-label={t('usage.chart_week_label', { provider: PROVIDER_NAMES[group.provider] })}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      >
        <HatchPattern id={hatchId} />
        {days.map((day) => {
          const date = new Date(day);
          if (date.getDay() < WORK_HOURS.firstDay || date.getDay() > WORK_HOURS.lastDay)
            return null;
          const from = day + WORK_HOURS.startHour * HOUR_MS;
          const to = day + WORK_HOURS.endHour * HOUR_MS;
          return (
            <rect
              key={day}
              className={styles.workBand}
              x={x(from)}
              y={CHART.top}
              width={x(to) - x(from)}
              height={PLOT_H}
            />
          );
        })}
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
        {gaps.map((gap) => (
          <rect
            key={gap.from}
            x={x(gap.from)}
            y={CHART.top}
            width={Math.max(1, x(gap.to) - x(gap.from))}
            height={PLOT_H}
            fill={`url(#${hatchId})`}
            className={styles.lockedArea}
          >
            <title>{`${t('usage.free_state_none')}: ${formatWhen(gap.from, now, t)} → ${formatWhen(gap.to, now, t)}`}</title>
          </rect>
        ))}
        {lines.map(({ account, d }, i) => (
          <path key={account.name} className={styles.accountLine} data-index={i} d={d} />
        ))}
        {ranOut
          .filter((e) => e.at >= start && e.at < end)
          .map((e) => (
            <circle
              key={`${e.account?.name}-${e.at}`}
              className={styles.dangerDot}
              cx={x(e.at)}
              cy={y(100)}
              r={4.5}
            >
              <title>
                {t('usage.event_ran_out', { account: e.account?.label ?? '' }) +
                  ` · ${formatWhen(e.at, now, t)}`}
              </title>
            </circle>
          ))}
        {now >= start && now < end && (
          <line
            className={styles.nowLine}
            x1={x(now)}
            x2={x(now)}
            y1={CHART.top}
            y2={CHART.top + PLOT_H}
          />
        )}
        {days.map((day) => (
          <text
            key={day}
            className={styles.axisText}
            x={x(day + DAY_MS / 2)}
            y={CHART.height - 6}
            textAnchor="middle"
          >
            {weekday(day, t)}
          </text>
        ))}
        {hoverMs !== null && hoverValues && (
          <g pointerEvents="none">
            <line
              className={styles.crosshair}
              x1={x(hoverMs)}
              x2={x(hoverMs)}
              y1={CHART.top}
              y2={CHART.top + PLOT_H}
            />
            <text
              className={styles.hoverText}
              x={Math.min(x(hoverMs) + 6, CHART.width - 150)}
              y={CHART.top + 12}
            >
              {`${weekday(hoverMs, t)} ${formatTime(hoverMs)} · ${group.accounts
                .map(
                  (a, i) =>
                    `${a.label.replace(`${PROVIDER_NAMES[group.provider]} `, '')} ${hoverValues[i] === null ? '–' : `${Math.round(hoverValues[i] as number)}%`}`
                )
                .join(' · ')}`}
            </text>
          </g>
        )}
      </svg>

      <div className={styles.legend}>
        {group.accounts.map((account, i) => (
          <LegendItem
            key={account.name}
            swatch={`${styles.swatchAccount} ${styles[`swatchAccount${Math.min(i, 2)}`]}`}
          >
            {account.label}
          </LegendItem>
        ))}
        <LegendItem swatch={styles.swatchRunsOutDot}>{t('usage.legend_runs_out')}</LegendItem>
        <LegendItem swatch={styles.swatchLocked}>{t('usage.free_state_none')}</LegendItem>
        <LegendItem swatch={styles.swatchWork}>{t('usage.col_work_hours')}</LegendItem>
      </div>

      <div className={styles.stats}>
        <Stat
          label={t('usage.stat_none_free')}
          value={t('usage.work_h', { count: workHours(row.noneFreeWorkMs) })}
          tone={row.noneFreeWorkMs > 0 ? 'danger' : undefined}
        />
        <Stat
          label={t('usage.stat_covered', {
            account: soleAccount
              ? soleAccount.label.replace(`${PROVIDER_NAMES[group.provider]} `, '')
              : '–',
          })}
          value={sole && sole[1] > 0 ? formatHours(sole[1], t) : '–'}
        />
        <Stat
          label={t('usage.stat_gap')}
          value={row.firstGap ? formatDuration(row.firstGap.to - row.firstGap.from, t, true) : '–'}
          tone={row.firstGap ? 'danger' : undefined}
        />
      </div>

      <WeeklyGapChart group={group} t={t} language={language} />
    </aside>
  );
}

const BARS = { width: 360, height: 150, left: 8, right: 8, top: 22, bottom: 24 };

function WeeklyGapChart({ group, t, language }: { group: Group; t: TFunction; language: string }) {
  const plotW = BARS.width - BARS.left - BARS.right;
  const plotH = BARS.height - BARS.top - BARS.bottom;
  const values = group.rows.map((row) => ({
    row,
    covered: workHours(row.coveredWorkMs),
    none: workHours(row.noneFreeWorkMs),
    pace: row.isCurrent ? workHours(row.forecastNoneFreeWorkMs ?? 0) : null,
  }));
  const max = Math.max(4, ...values.map((v) => v.covered + Math.max(v.none, v.pace ?? 0)));
  const slot = plotW / values.length;
  const barW = Math.min(34, slot * 0.5);
  const h = (hours: number) => (hours / max) * plotH;
  const base = BARS.top + plotH;
  const byWeek = values
    .map((v) =>
      v.row.hasData ? (v.pace !== null && v.pace > v.none ? `~${v.pace}` : String(v.none)) : '–'
    )
    .join(', ');

  return (
    <div className={styles.subChart}>
      <h4>
        {t('usage.gap_chart_title', { provider: PROVIDER_NAMES[group.provider] })}{' '}
        <span>· {t('usage.per_week')}</span>
      </h4>
      <p className={styles.subChartLead}>{t('usage.gap_chart_lead', { values: byWeek })}</p>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${BARS.width} ${BARS.height}`}
        role="img"
        aria-label={t('usage.gap_chart_title', { provider: PROVIDER_NAMES[group.provider] })}
      >
        {values.map(({ row, covered, none, pace }, i) => {
          const cx = BARS.left + slot * i + slot / 2;
          const label = row.isCurrent
            ? t('usage.this_week_short')
            : formatMonthDay(row.weekStart, language);
          const coveredTop = base - h(covered);
          const noneTop = coveredTop - h(none) - (none > 0 && covered > 0 ? 2 : 0);
          const top = Math.min(coveredTop, noneTop);
          return (
            <g key={row.weekStart}>
              {row.hasData && covered > 0 && (
                <rect
                  className={styles.barWithin}
                  x={cx - barW / 2}
                  y={coveredTop}
                  width={barW}
                  height={h(covered)}
                  rx={3}
                >
                  <title>{t('usage.legend_covered_by', { hours: covered })}</title>
                </rect>
              )}
              {row.hasData && none > 0 && (
                <rect
                  className={styles.barNone}
                  x={cx - barW / 2}
                  y={noneTop}
                  width={barW}
                  height={h(none)}
                  rx={3}
                >
                  <title>
                    {t('usage.none_free', { hours: t('usage.hours', { count: none }) })}
                  </title>
                </rect>
              )}
              {pace !== null && pace > none && (
                <rect
                  className={styles.barPace}
                  x={cx - barW / 2}
                  y={coveredTop - h(pace)}
                  width={barW}
                  height={h(pace - none)}
                  rx={3}
                >
                  <title>{t('usage.none_free_pace', { hours: pace })}</title>
                </rect>
              )}
              {!row.hasData && (
                <rect
                  className={styles.barEmpty}
                  x={cx - barW / 2}
                  y={base - 3}
                  width={barW}
                  height={3}
                  rx={1.5}
                />
              )}
              <text
                className={pace !== null && pace > none ? styles.barValueDanger : styles.barValue}
                x={cx}
                y={(pace !== null && pace > none ? coveredTop - h(pace) : top) - 5}
                textAnchor="middle"
              >
                {row.hasData ? (pace !== null && pace > none ? `~${pace}` : none) : ''}
              </text>
              <text
                className={row.isCurrent ? styles.axisTextStrong : styles.axisText}
                x={cx}
                y={BARS.height - 6}
                textAnchor="middle"
              >
                {label}
              </text>
            </g>
          );
        })}
        <line
          className={styles.baseLine}
          x1={BARS.left}
          x2={BARS.width - BARS.right}
          y1={base}
          y2={base}
        />
      </svg>
      <div className={styles.legend}>
        <LegendItem swatch={styles.swatchWithin}>{t('usage.legend_covered')}</LegendItem>
        <LegendItem swatch={styles.swatchNoneFree}>{t('usage.free_none')}</LegendItem>
        <LegendItem swatch={styles.swatchPaceBar}>{t('usage.legend_on_pace')}</LegendItem>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- hand-off */

function HandOffList({
  history,
  group,
  now,
  t,
  language,
}: {
  history: UsageHistory;
  group: Group;
  now: number;
  t: TFunction;
  language: string;
}) {
  const weeks = [...group.rows].reverse().filter((row) => row.hasData);
  const provider = PROVIDER_NAMES[group.provider];
  return (
    <div className={styles.handoff}>
      {weeks.length === 0 && <p className={styles.muted}>{t('usage.no_readings')}</p>}
      {weeks.map((row) => {
        const all = handOffEvents(history, group.accounts, row.weekStart, now);
        // "Free again" says nothing new when an account reset at that same moment.
        const events = all.filter(
          (e) => e.kind !== 'freeAgain' || !all.some((r) => r.kind === 'reset' && r.at === e.at)
        );
        return (
          <div key={row.weekStart} className={styles.handoffWeek}>
            <h4>
              {t('usage.week_of')} {formatMonthDay(row.weekStart, language)}
              {row.isCurrent && <small> · {t('usage.this_week')}</small>}
            </h4>
            {events.length === 0 ? (
              <p className={styles.muted}>{t('usage.handoff_none')}</p>
            ) : (
              <ol>
                {events.map((event) => (
                  <li
                    key={`${event.kind}-${event.at}-${event.account?.name ?? ''}`}
                    data-kind={event.kind}
                  >
                    <time>{`${weekday(event.at, t)} ${formatTime(event.at)}`}</time>
                    <span>
                      {event.kind === 'ranOut'
                        ? t('usage.event_ran_out', { account: event.account?.label ?? '' })
                        : event.kind === 'reset'
                          ? t('usage.event_reset', { account: event.account?.label ?? '' })
                          : event.kind === 'noneFree'
                            ? t('usage.event_none_free', { provider })
                            : t('usage.event_free_again', { provider })}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </div>
  );
}
