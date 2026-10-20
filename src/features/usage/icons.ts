import { AUTH_FILE_ICONS } from '@/features/authFiles/constants';
import type { ResolvedTheme } from '@/types';
import type { UsageProvider } from './usageModel';

/** A provider's logo for the theme, for an <img> or an SVG <image>. */
export function providerIconSrc(provider: UsageProvider, theme: ResolvedTheme): string | null {
  const asset = AUTH_FILE_ICONS[provider];
  if (!asset) return null;
  return typeof asset === 'string' ? asset : theme === 'dark' ? asset.dark : asset.light;
}
