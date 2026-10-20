/**
 * Past windows: how full each account's weekly window got before it reset,
 * and how much it left unused.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ResolvedTheme } from '@/types';
import { PROVIDER_NAMES, WEEK_MS, staleAfterMs, windowsOf } from './usageModel';
import type { AccountView, UsageHistory, UsageWindow } from './usageModel';
import { formatDuration, formatMonthDay, formatWhen } from './format';
import { LegendItem, ProviderIcon } from './parts';
import { useWidth } from './useWidth';
import styles from './UsagePage.module.scss';

interface Props {
  history: UsageHistory;
  accounts: AccountView[];
  now: number;
  theme: ResolvedTheme;
}

/** The strip reaches back as far as the recorder keeps history. */
const PAST_WEEKS = 9;

export function PastWindowsPanel({ history, accounts, now, theme }: Props) {
  const { t } = useTranslation();
  const past = useMemo(() => {
    const staleMs = staleAfterMs(history);
    return accounts.map((account) => ({
      account,
      windows: windowsOf(history.series[account.name]?.['7d'] ?? [], now, staleMs),
    }));
  }, [history, accounts, now]);
  const { headline, sub } = pastHeadline(past, now, t);

  return (
    <section className={styles.card}>
      <header className={styles.cardHead}>
        <div>
          <h2 className={styles.headline}>{headline}</h2>
          {sub && <p className={styles.subline}>{sub}</p>}
        </div>
      </header>
      <PastWindows past={past} now={now} theme={theme} t={t} />
    </section>
  );
}

interface PastAccount {
  account: AccountView;
  windows: UsageWindow[];
}

const finishedOf = (windows: UsageWindow[]) => windows.filter((w) => !w.current && w.toEnd);
const leftOf = (w: UsageWindow) => Math.max(0, 100 - w.peak);
const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

function pastHeadline(past: PastAccount[], now: number, t: TFunction) {
  const finished = past.flatMap((p) => finishedOf(p.windows));
  if (finished.length === 0) {
    const next = past
      .flatMap((p) => p.windows.filter((w) => w.current).map((w) => ({ p, w })))
      .sort((a, b) => a.w.resetMs - b.w.resetMs)[0];
    return {
      headline: t('usage.past_headline_none'),
      sub: next
        ? t('usage.past_sub_first', {
            account: next.p.account.label,
            time: formatWhen(next.w.resetMs, now, t),
          })
        : '',
    };
  }
  const hits = finished.filter((w) => w.peak >= 100).length;
  const list = past
    .filter((p) => finishedOf(p.windows).length > 0)
    .map((p) => `${p.account.label} ${Math.round(average(finishedOf(p.windows).map(leftOf)))}%`)
    .join(', ');
  return {
    headline: t('usage.past_headline', { hits, count: finished.length }),
    sub: t('usage.past_sub_unused', { list }),
  };
}

const peakLevel = (w: UsageWindow) =>
  w.peak >= 100 ? 'hit' : w.peak >= 80 ? '3' : w.peak >= 60 ? '2' : w.peak >= 40 ? '1' : '0';

function PastWindows({
  past,
  now,
  theme,
  t,
}: {
  past: PastAccount[];
  now: number;
  theme: ResolvedTheme;
  t: TFunction;
}) {
  const { i18n } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>(600);
  const all = past.flatMap((p) => p.windows);
  const to = Math.max(now, ...all.map((w) => w.endMs));
  const from = Math.max(to - PAST_WEEKS * WEEK_MS, Math.min(...all.map((w) => w.startMs), now));
  const toPercent = (ms: number) => ((Math.max(from, Math.min(to, ms)) - from) / (to - from)) * 100;

  const mondays: number[] = [];
  const monday = new Date(from);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7));
  const weekPx = (width * WEEK_MS) / Math.max(to - from, 1);
  for (let ms = monday.getTime(), i = 0; ms < to; ms += WEEK_MS, i += 1) {
    if (weekPx >= 52 || i % 2 === 0) mondays.push(ms);
  }

  const focus = past.find((p) => p.account.name === selected) ?? past[0];

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <div className={styles.forecastGrid}>
          <div className={styles.axisRow}>
            <span />
            <div className={styles.pastAxis} ref={ref}>
              {mondays.map((ms) => (
                <span key={ms} style={{ left: `${toPercent(ms)}%` }}>
                  {formatMonthDay(ms, i18n.language)}
                </span>
              ))}
            </div>
            <span />
          </div>
          {past.map((p) => {
            const finished = finishedOf(p.windows);
            const hits = finished.filter((w) => w.peak >= 100).length;
            const shown = p.windows.filter((w) => w.endMs > from);
            return (
              <div key={p.account.name} className={styles.row} data-selected={p === focus ? 1 : 0}>
                <button
                  type="button"
                  className={styles.rowLabel}
                  onClick={() => setSelected(p.account.name)}
                  aria-pressed={p === focus}
                >
                  <ProviderIcon provider={p.account.provider} theme={theme} />
                  <span className={styles.rowName}>{p.account.label}</span>
                </button>
                <div className={styles.pastTrack} onClick={() => setSelected(p.account.name)}>
                  {shown.map((w) => {
                    const left = toPercent(w.startMs);
                    const span = toPercent(w.endMs) - left;
                    return (
                      <span
                        key={w.resetMs}
                        className={styles.pastWindow}
                        data-peak={peakLevel(w)}
                        data-current={w.current ? 1 : 0}
                        data-unread={!w.current && !w.toEnd ? 1 : 0}
                        style={{ left: `${left}%`, width: `calc(${span}% - 2px)` }}
                        title={windowText(w, now, t)}
                      >
                        {!w.current && w.toEnd && w.peak < 100 && Math.round(leftOf(w))}
                      </span>
                    );
                  })}
                  <span className={styles.nowTick} style={{ left: `${toPercent(now)}%` }} />
                </div>
                <span className={styles.rowSummary}>
                  {finished.length ? (
                    <>
                      <b data-tone={hits ? 'danger' : undefined}>
                        {t('usage.past_summary_hits', { hits, count: finished.length })}
                      </b>
                      <span className={styles.muted}>
                        {t('usage.past_summary_left', {
                          left: Math.round(average(finished.map(leftOf))),
                        })}
                      </span>
                    </>
                  ) : (
                    <span className={styles.muted}>{t('usage.past_summary_none')}</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        <footer className={styles.legend}>
          <span className={styles.legendGroup}>
            {t('usage.past_peak_legend')}
            {['0', '1', '2', '3'].map((level) => (
              <span key={level} className={styles.pastSwatch} data-peak={level} />
            ))}
            {t('usage.past_levels')}
          </span>
          <LegendItem swatch={styles.swatchNoneFree}>{t('usage.past_hit')}</LegendItem>
          <LegendItem swatch={styles.swatchCurrent}>{t('usage.past_current')}</LegendItem>
          <span className={styles.legendNote}>{t('usage.past_note')}</span>
        </footer>
      </div>

      {focus && <PastDetail entry={focus} now={now} theme={theme} t={t} />}
    </div>
  );
}

function windowText(w: UsageWindow, now: number, t: TFunction) {
  if (w.current) return t('usage.past_window_current', { used: Math.round(w.peak) });
  if (w.lockedFrom !== null && w.ranOutAt === null) return t('usage.past_window_out_unread');
  if (w.ranOutAt !== null) {
    return t('usage.past_window_ran_out', {
      time: formatWhen(w.ranOutAt, now, t),
      duration: formatDuration(w.endMs - w.ranOutAt, t, true),
    });
  }
  if (!w.toEnd) return t('usage.past_window_unread_end', { peak: Math.round(w.peak) });
  return t('usage.past_window_peak', { peak: Math.round(w.peak), left: Math.round(leftOf(w)) });
}

function PastDetail({
  entry,
  now,
  theme,
  t,
}: {
  entry: PastAccount;
  now: number;
  theme: ResolvedTheme;
  t: TFunction;
}) {
  const { i18n } = useTranslation();
  const windows = [...entry.windows].reverse();
  return (
    <aside className={styles.detail}>
      <div className={styles.detailHead}>
        <ProviderIcon provider={entry.account.provider} theme={theme} size={26} />
        <div>
          <h3>{entry.account.label}</h3>
          <p>{`${PROVIDER_NAMES[entry.account.provider]} · ${entry.account.email}`}</p>
        </div>
      </div>
      <ol className={styles.windowList}>
        {windows.map((w) => (
          <li key={w.resetMs} data-hit={w.peak >= 100 ? 1 : 0}>
            <span>
              {`${formatMonthDay(w.startMs, i18n.language)} – ${formatMonthDay(w.endMs, i18n.language)}`}
              {w.endedEarly && <small>{t('usage.past_window_early')}</small>}
            </span>
            <span>{windowText(w, now, t)}</span>
          </li>
        ))}
      </ol>
      {windows.length === 0 && <p className={styles.muted}>{t('usage.no_readings')}</p>}
    </aside>
  );
}
