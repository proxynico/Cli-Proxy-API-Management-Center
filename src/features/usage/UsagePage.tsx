/**
 * Usage: how fast each account spends its week, when it runs out, whether a
 * provider kept an account free, and how that changes week to week.
 *
 * Reads the history the mini's usage recorder keeps. The recorder listens on
 * the proxy's own loopback, so the page reaches it through the management
 * api-call, behind the same key as everything else here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiCallApi } from '@/services/api';
import { useNow } from '@/hooks/useNow';
import { useThemeStore } from '@/stores';
import { accountViews, parseUsageHistory } from './usageModel';
import type { UsageHistory } from './usageModel';
import { BurstsPanel } from './BurstsPanel';
import { ForecastPanel } from './ForecastPanel';
import { PacePanel } from './PacePanel';
import { TrendsPanel } from './TrendsPanel';
import { WeeksPanel } from './WeeksPanel';
import styles from './UsagePage.module.scss';

// Overridable at build time, so a dev build can read a sample history without stopping the recorder.
const RECORDER_URL =
  (import.meta.env.VITE_USAGE_HISTORY_URL as string | undefined) ||
  'http://127.0.0.1:8320/history.json';
const RELOAD_MS = 5 * 60_000;

const VIEWS = ['pace', 'forecast', 'weeks', 'trends', 'bursts'] as const;
type PageView = (typeof VIEWS)[number];
/**
 * The view sits in the address so a reload opens the same one. The page
 * transition hands pages only path changes, so the page keeps the view itself
 * and writes the address alongside, keeping the router's history state.
 */
const viewFromAddress = (): PageView => {
  const asked = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('view');
  return VIEWS.find((v) => v === asked) ?? 'pace';
};
const writeView = (view: PageView) => {
  const path = window.location.hash.split('?')[0] || '#/usage';
  window.history.replaceState(
    window.history.state,
    '',
    view === 'pace' ? path : `${path}?view=${view}`
  );
};

const PANELS = {
  pace: PacePanel,
  forecast: ForecastPanel,
  weeks: WeeksPanel,
  trends: TrendsPanel,
  bursts: BurstsPanel,
} as const;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; history: UsageHistory };

function useUsageHistory() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const result = await apiCallApi.request({ method: 'GET', url: RECORDER_URL });
      if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
      const history = parseUsageHistory(result.body);
      if (!history) throw new Error('unreadable history');
      setState({ status: 'ready', history });
    } catch (error) {
      setState((previous) =>
        // Keep showing the last good history through a brief outage.
        previous.status === 'ready'
          ? previous
          : { status: 'error', message: error instanceof Error ? error.message : String(error) }
      );
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), RELOAD_MS);
    return () => window.clearInterval(id);
  }, [load]);

  return state;
}

export function UsagePage() {
  const { t } = useTranslation();
  const state = useUsageHistory();
  const now = useNow();
  const resolvedTheme = useThemeStore((store) => store.resolvedTheme);
  const [view, setView] = useState<PageView>(viewFromAddress);
  const Panel = PANELS[view];
  const accounts = useMemo(
    () => (state.status === 'ready' ? accountViews(state.history) : []),
    [state]
  );

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('usage.title')}</h1>
        {state.status === 'ready' && (
          <p className={styles.pageMeta}>
            {t('usage.meta', {
              count: accounts.length,
              minutes: state.history.pollMinutes,
            })}
          </p>
        )}
      </header>

      {state.status === 'loading' && (
        <div className={styles.notice} role="status">
          {t('usage.loading')}
        </div>
      )}
      {state.status === 'error' && (
        <div className={styles.notice} role="alert">
          <b>{t('usage.recorder_down')}</b>
          <span>{t('usage.recorder_down_hint', { error: state.message })}</span>
        </div>
      )}
      {state.status === 'ready' && accounts.length === 0 && (
        <div className={styles.notice} role="status">
          {t('usage.no_accounts')}
        </div>
      )}
      {state.status === 'ready' && accounts.length > 0 && (
        <>
          <nav className={styles.tabs} aria-label={t('usage.page_view')}>
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={v === view}
                onClick={() => {
                  setView(v);
                  writeView(v);
                }}
              >
                {t(`usage.view_${v}`)}
              </button>
            ))}
          </nav>
          <Panel history={state.history} accounts={accounts} now={now} theme={resolvedTheme} />
        </>
      )}
    </div>
  );
}
