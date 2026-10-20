/**
 * Small pieces the usage panels share.
 */

import type { ReactNode } from 'react';
import type { ResolvedTheme } from '@/types';
import type { UsageProvider } from './usageModel';
import { providerIconSrc } from './icons';
import styles from './UsagePage.module.scss';

export function ProviderIcon({
  provider,
  theme,
  size = 18,
}: {
  provider: UsageProvider;
  theme: ResolvedTheme;
  size?: number;
}) {
  const src = providerIconSrc(provider, theme);
  if (!src) return null;
  return <img className={styles.providerIcon} src={src} width={size} height={size} alt="" />;
}

/** An account picker for panels that show one account at a time. */
export function AccountSelect({
  accounts,
  value,
  onChange,
  label,
}: {
  accounts: { name: string; label: string }[];
  value: string;
  onChange: (name: string) => void;
  label: string;
}) {
  return (
    <select
      className={styles.accountSelect}
      value={value}
      aria-label={label}
      onChange={(event) => onChange(event.target.value)}
    >
      {accounts.map((account) => (
        <option key={account.name} value={account.name}>
          {account.label}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function LegendItem({ swatch, children }: { swatch: string; children: ReactNode }) {
  return (
    <span className={styles.legendItem}>
      <span className={`${styles.swatch} ${swatch}`} aria-hidden="true" />
      {children}
    </span>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue} data-tone={tone}>
        {value}
      </span>
    </div>
  );
}

/** Hatching for "nothing left": shared so every locked stretch reads the same. */
export function HatchPattern({ id }: { id: string }) {
  return (
    <defs>
      <pattern
        id={id}
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width="6" height="6" className={styles.hatchBg} />
        <line x1="0" y1="0" x2="0" y2="6" className={styles.hatchLine} />
      </pattern>
    </defs>
  );
}
