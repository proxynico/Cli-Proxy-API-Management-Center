/**
 * Small pieces both usage panels share.
 */

import type { ReactNode } from 'react';
import { AUTH_FILE_ICONS } from '@/features/authFiles/constants';
import type { ResolvedTheme } from '@/types';
import type { UsageProvider } from './usageModel';
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
  const asset = AUTH_FILE_ICONS[provider];
  if (!asset) return null;
  const src = typeof asset === 'string' ? asset : theme === 'dark' ? asset.dark : asset.light;
  return <img className={styles.providerIcon} src={src} width={size} height={size} alt="" />;
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
