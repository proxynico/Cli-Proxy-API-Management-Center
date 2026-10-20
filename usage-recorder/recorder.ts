/**
 * Records each CLIProxyAPI account's limit readings every five minutes and
 * serves the history to the dashboard's Usage page.
 *
 * Readings come through CLIProxyAPI's api-call, so the proxy stays the only
 * holder of every login and nothing here refreshes a token. The history is
 * served on loopback only; the page reads it through the same api-call, so the
 * management key guards it like the rest of the dashboard.
 *
 * Run: bun run usage-recorder/recorder.ts (launchd keeps it alive on the mini).
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const PROXY = process.env.CLIPROXY_URL ?? 'http://127.0.0.1:8317';
const KEY_FILE = process.env.CLIPROXY_KEY_FILE ?? join(HOME, '.config/cliproxy-local/admin.key');
const DATA_DIR = process.env.USAGE_DATA_DIR ?? join(HOME, '.local/share/cliproxy-usage');
const PORT = Number(process.env.USAGE_PORT ?? 8320);

const MINUTE = 60_000;
const POLL_MS = 5 * MINUTE;
/** An unchanged reading is still kept this often, so a gap in the history means the recorder was down. */
const HEARTBEAT_MS = 30 * MINUTE;
const RETAIN_MS = 63 * 24 * 60 * MINUTE;

type Provider = 'claude' | 'codex' | 'xai';
type WindowId = '5h' | '7d';
/** [reading time ms, percent used, reset time ms] */
type Point = [number, number, number];
type Windows = Partial<Record<WindowId, [used: number, resetMs: number]>>;

interface Account {
  provider: Provider;
  email: string;
  lastReadingAt: number | null;
  lastError: string | null;
}

interface History {
  version: 1;
  updatedAt: number;
  pollMinutes: number;
  heartbeatMinutes: number;
  accounts: Record<string, Account>;
  series: Record<string, Partial<Record<WindowId, Point[]>>>;
}

const historyPath = join(DATA_DIR, 'history.json');

/* --------------------------------------------------------------- proxy */

async function management(key: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${PROXY}/v0/management${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function upstream(
  key: string,
  authIndex: string,
  url: string,
  header: Record<string, string>
) {
  const result = await management(key, 'POST', '/api-call', {
    auth_index: authIndex,
    method: 'GET',
    url,
    header: { Authorization: 'Bearer $TOKEN$', ...header },
  });
  const status = Number(result.status_code);
  if (status < 200 || status >= 300) throw new Error(`upstream HTTP ${status}`);
  return JSON.parse(String(result.body ?? '{}')) as Record<string, unknown>;
}

/** Provider resets jitter by fractions of a second between calls; a minute is the real precision. */
const toMinute = (ms: number) => Math.round(ms / MINUTE) * MINUTE;
const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const record = (value: unknown) =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

/** Same endpoints and headers as the dashboard's Quota page (src/utils/quota/constants.ts). */
const READERS: Record<Provider, (key: string, authIndex: string) => Promise<Windows>> = {
  async claude(key, authIndex) {
    const body = await upstream(key, authIndex, 'https://api.anthropic.com/api/oauth/usage', {
      'anthropic-beta': 'oauth-2025-04-20',
    });
    const windows: Windows = {};
    for (const [field, id] of [
      ['five_hour', '5h'],
      ['seven_day', '7d'],
    ] as const) {
      const window = record(body[field]);
      const used = num(window?.utilization);
      const resetMs = Date.parse(String(window?.resets_at ?? ''));
      if (used !== null && Number.isFinite(resetMs)) windows[id] = [used, toMinute(resetMs)];
    }
    return windows;
  },

  async codex(key, authIndex) {
    const body = await upstream(key, authIndex, 'https://chatgpt.com/backend-api/wham/usage', {
      'User-Agent':
        'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)',
    });
    const limits = record(body.rate_limit);
    const windows: Windows = {};
    for (const field of ['primary_window', 'secondary_window']) {
      const window = record(limits?.[field]);
      const used = num(window?.used_percent);
      const seconds = num(window?.limit_window_seconds);
      const resetAt = num(window?.reset_at);
      const id: WindowId | null = seconds === 5 * 3600 ? '5h' : seconds === 7 * 86400 ? '7d' : null;
      if (id && used !== null && resetAt !== null) windows[id] = [used, toMinute(resetAt * 1000)];
    }
    return windows;
  },

  async xai(key, authIndex) {
    const body = await upstream(
      key,
      authIndex,
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      {
        'x-xai-token-auth': 'xai-grok-cli',
        'x-grok-client-version': '0.2.91',
        accept: '*/*',
        'user-agent': 'grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)',
      }
    );
    const config = record(body.config) ?? body;
    const period = record(config.currentPeriod);
    const used = num(config.creditUsagePercent);
    const resetMs = Date.parse(String(period?.end ?? ''));
    // Only the weekly pool is a rate-limit window; a monthly figure is a spend cap.
    if (
      !String(period?.type ?? '').includes('WEEKLY') ||
      used === null ||
      !Number.isFinite(resetMs)
    ) {
      return {};
    }
    return { '7d': [used, toMinute(resetMs)] };
  },
};

/* ------------------------------------------------------------- history */

async function loadHistory(): Promise<History> {
  try {
    const parsed = JSON.parse(await readFile(historyPath, 'utf8')) as History;
    if (parsed.version === 1) return parsed;
  } catch {
    // First run, or an unreadable file: start empty rather than refuse to record.
  }
  return {
    version: 1,
    updatedAt: 0,
    pollMinutes: POLL_MS / MINUTE,
    heartbeatMinutes: HEARTBEAT_MS / MINUTE,
    accounts: {},
    series: {},
  };
}

async function saveHistory(history: History) {
  const temp = `${historyPath}.tmp`;
  await writeFile(temp, JSON.stringify(history));
  await rename(temp, historyPath);
}

function addPoint(points: Point[], point: Point) {
  const last = points.at(-1);
  if (last && last[1] === point[1] && last[2] === point[2] && point[0] - last[0] < HEARTBEAT_MS)
    return;
  points.push(point);
}

async function poll(history: History) {
  const key = (await readFile(KEY_FILE, 'utf8')).trim();
  const listing = await management(key, 'GET', '/auth-files');
  const files = (Array.isArray(listing.files) ? listing.files : []) as Record<string, unknown>[];
  const now = Date.now();
  const raw: Record<string, Windows> = {};

  for (const file of files) {
    const provider = String(file.provider ?? file.type ?? '') as Provider;
    const name = String(file.name ?? '');
    const authIndex = String(file.auth_index ?? '');
    if (!(provider in READERS) || !name || !authIndex || file.disabled === true) continue;

    const account = (history.accounts[name] ??= {
      provider,
      email: String(file.email ?? name),
      lastReadingAt: null,
      lastError: null,
    });
    try {
      const windows = await READERS[provider](key, authIndex);
      const series = (history.series[name] ??= {});
      for (const [id, [used, resetMs]] of Object.entries(windows) as [
        WindowId,
        [number, number],
      ][]) {
        addPoint((series[id] ??= []), [now, used, resetMs]);
      }
      account.lastReadingAt = now;
      account.lastError = null;
      raw[name] = windows;
    } catch (error) {
      account.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  const cutoff = now - RETAIN_MS;
  for (const series of Object.values(history.series)) {
    for (const id of Object.keys(series) as WindowId[]) {
      series[id] = series[id]?.filter((point) => point[0] >= cutoff);
    }
  }
  history.updatedAt = now;
  await saveHistory(history);

  // The raw log is the record the compact history can be rebuilt from.
  const month = new Date(now).toISOString().slice(0, 7);
  await appendFile(
    join(DATA_DIR, `readings-${month}.jsonl`),
    `${JSON.stringify({ t: now, raw })}\n`
  );
}

/* ---------------------------------------------------------------- main */

await mkdir(DATA_DIR, { recursive: true });
const history = await loadHistory();

const tick = () =>
  poll(history).catch((error) => console.error(new Date().toISOString(), 'poll failed:', error));
await tick();
setInterval(tick, POLL_MS);

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/history.json') {
      return new Response(JSON.stringify(history), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    return new Response('Not found', { status: 404 });
  },
});
console.log(
  new Date().toISOString(),
  `recording every ${POLL_MS / MINUTE} min; serving 127.0.0.1:${PORT}`
);
