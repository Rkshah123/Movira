import type { IconName } from './Icon';

/**
 * Picks the symbol that represents a level: a speaker whose waves follow the
 * volume, or a sun for brightness.
 *
 * Shared by the video player and the audio player so the two readouts can never
 * drift apart — the thresholds below are what the user recognises as "low",
 * "medium" and "high", and having them defined twice is how one screen ends up
 * showing a different icon for the same volume.
 */
export function levelSymbol(kind: 'volume' | 'brightness', level: number): IconName {
  if (kind === 'brightness') return 'brightness';
  if (level <= 0.001) return 'volumeOff';
  if (level < 0.34) return 'volumeLow';
  if (level < 0.67) return 'volumeMedium';
  return 'volumeHigh';
}

/** The label above the rail. Fixed-width text means the bubble never reflows. */
export function levelLabel(kind: 'volume' | 'brightness', level: number): string {
  if (kind === 'brightness') return `Brightness ${Math.round(level * 100)}%`;
  if (level <= 0.001) return 'Muted';
  return `Volume ${Math.round(level * 100)}%`;
}