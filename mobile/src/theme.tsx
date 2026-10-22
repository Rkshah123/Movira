import React, { createContext, useContext, useMemo, useState, useCallback, useEffect } from 'react';
import { useColorScheme, type ColorSchemeName } from 'react-native';
import type { ThemeMode } from '@shared';

/**
 * Movira theme tokens.
 *
 * These are the EXACT values the desktop app uses in `desktop/src/styles.css`
 * (`--bg`, `--bg-1`, `--bg-2`, `--bg-3`, `--text`, `--text-dim`, `--accent`,
 * `--accent-2`, `--border`). The mobile redesign must not introduce a new
 * palette, so the tokens are duplicated here verbatim rather than re-picked.
 *
 * Ember and Phosphor extend the SAME token set: every screen reads only these
 * fields, so a new theme is complete by construction — no component carries a
 * colour of its own.
 */
export interface Theme {
  dark: boolean;
  bg: string;
  bg1: string;
  bg2: string;
  bg3: string;
  text: string;
  dim: string;
  accent: string;
  accent2: string;
  border: string;
  /** Card / dialog drop shadow — also the subtle themed glow. */
  shadow: string;
  /** Inactive slider and progress track. */
  track: string;
  /** Backdrop scrim behind dialogs, action sheets and menus. */
  overlay: string;
  /**
   * Luminous palette for the version-screen sparkles — one entry per glyph so
   * the four stay visually distinct. The burst reads these at render time, so
   * switching theme restyles the animation instantly with no per-particle
   * hardcoding anywhere:
   *  - core: bright colour of the glyph itself
   *  - glow: halo discs + text-shadow bloom colour
   *  - hot:  near-white centre highlight layered over the core
   */
  sparkles: SparklePalette[];
}

export interface SparklePalette {
  core: string;
  glow: string;
  hot: string;
}

/**
 * Mobile-local theme selection. `ThemeMode` lives in `@shared` (compiled into
 * the desktop app) and must not change there, so the extra palettes are
 * widened here only.
 */
export type MobileThemeMode = ThemeMode | 'ember' | 'phosphor' | 'nebula' | 'tide';

export const darkTheme: Theme = {
  dark: true,
  bg: '#0b0d12',
  bg1: '#11141c',
  bg2: '#171b26',
  bg3: '#1f2432',
  text: '#e8ebf2',
  dim: '#9aa3b5',
  accent: '#e5484d',
  accent2: '#ff6b6f',
  border: '#232937',
  shadow: '#000000',
  track: '#3a3f4d',
  overlay: 'rgba(0,0,0,0.6)',
  // Always dark → MAROON AND WHITE.
  // Deep maroon glyphs carrying white-hot centres, haloed in maroon. Entry 4 is
  // a pure white glyph so the family keeps one clean highlight to anchor the eye
  // against the three maroon-weighted shapes.
  sparkles: [
    { core: '#8e2743', glow: '#4a0d1c', hot: '#ffffff' },
    { core: '#c04a68', glow: '#8e2743', hot: '#fff4f7' },
    { core: '#e8a0b2', glow: '#a8324f', hot: '#ffffff' },
    { core: '#ffffff', glow: '#c04a68', hot: '#ffffff' },
  ],
};

export const lightTheme: Theme = {
  dark: false,
  bg: '#f4f5f9',
  bg1: '#ffffff',
  bg2: '#eef0f6',
  bg3: '#e4e7f0',
  text: '#1a1d26',
  dim: '#5c6474',
  accent: '#e5484d',
  accent2: '#ff6b6f',
  border: '#d8dbe6',
  shadow: '#141928',
  track: '#e4e7f0',
  overlay: 'rgba(20,25,40,0.35)',
  // Always light → MAROON AND BLACK.
  // Black and maroon glyphs, always haloed in maroon. Two deliberate departures
  // from the dark themes, because this palette sits on a light background:
  //
  //  - No white anywhere. A white glyph on #f4f5f9 is invisible.
  //  - `hot` is a DEEP maroon, not a pale tint. A light tint drawn over a black
  //    core at 0.8 opacity bleaches the black out and the whole sparkle reads as
  //    washed-out pink. Going the other way — a saturated maroon centre over
  //    near-black ink — keeps the family strictly maroon-and-black while still
  //    giving the glyph a lit middle.
  sparkles: [
    { core: '#0d0d0d', glow: '#7a1f37', hot: '#5c1428' },
    { core: '#7a1f37', glow: '#3d0a19', hot: '#a8324f' },
    { core: '#1c1c1c', glow: '#8e2743', hot: '#6d1a33' },
    { core: '#4a0d1c', glow: '#9c2b48', hot: '#7a1f37' },
  ],
};

/**
 * Ember — dark charcoal base with deep/burnt orange primary, amber highlights
 * and a warm shadow glow so panels read like lit embers rather than an orange
 * overlay. All five surfaces step up in warmth (bg → bg3) so cards, menus and
 * dialogs keep their elevation without borders alone doing the work.
 */
export const emberTheme: Theme = {
  dark: true,
  bg: '#0f0e0d',
  bg1: '#171412',
  bg2: '#1e1a17',
  bg3: '#292320',
  text: '#f3ece6',
  dim: '#ab9b8f',
  accent: '#f97316',
  accent2: '#ffb454',
  border: '#332a24',
  shadow: '#5e2600',
  track: '#3a2f27',
  overlay: 'rgba(0,0,0,0.66)',
  // Orange · red · amber · warm-white glow.
  sparkles: [
    { core: '#ff9f45', glow: '#ea580c', hot: '#fff6ec' },
    { core: '#ff6b5e', glow: '#dc2626', hot: '#fff0ee' },
    { core: '#ffd166', glow: '#d97706', hot: '#fff9e8' },
    { core: '#fff4e6', glow: '#fb923c', hot: '#ffffff' },
  ],
};

/**
 * Phosphor — near-black background, dark green surfaces, phosphor green
 * primary, bright green active state and light green text, with a faint green
 * halo on floating cards. Deliberately no scanlines or CRT noise: the glow
 * stays in the shadow token so the UI remains readable.
 */
export const phosphorTheme: Theme = {
  dark: true,
  bg: '#020704',
  bg1: '#061209',
  bg2: '#09190d',
  bg3: '#0d2212',
  text: '#d4ffe0',
  dim: '#5fae79',
  accent: '#33ff66',
  accent2: '#7dff9b',
  border: '#143a20',
  shadow: '#00390f',
  track: '#123018',
  overlay: 'rgba(0,8,2,0.68)',
  // Phosphor green · lime · bright green · bright white-green.
  sparkles: [
    { core: '#33ff66', glow: '#00c853', hot: '#eaffee' },
    { core: '#a4ff4f', glow: '#64dd17', hot: '#f7ffe8' },
    { core: '#7dff9b', glow: '#00e676', hot: '#eaffef' },
    { core: '#eaffee', glow: '#33ff66', hot: '#ffffff' },
  ],
};

/**
 * Nebula — deep violet-black base with purple/violet accents and a cosmic
 * glow. The sparkle family is violet · purple · blue · soft cosmic-white.
 */
export const nebulaTheme: Theme = {
  dark: true,
  bg: '#0a0714',
  bg1: '#120d20',
  bg2: '#17112a',
  bg3: '#201939',
  text: '#ece8f8',
  dim: '#9d94bd',
  accent: '#a78bfa',
  accent2: '#c4b5fd',
  border: '#2d2549',
  shadow: '#3b1a78',
  track: '#332a56',
  overlay: 'rgba(4,2,12,0.68)',
  sparkles: [
    { core: '#c4a2ff', glow: '#7c3aed', hot: '#f8f3ff' },
    { core: '#d084ff', glow: '#9333ea', hot: '#fbf1ff' },
    { core: '#8ab4ff', glow: '#3b82f6', hot: '#eef4ff' },
    { core: '#ffffff', glow: '#a78bfa', hot: '#ffffff' },
  ],
};

/**
 * Tide — deep blue-ocean base with cyan/aqua accents and a cool glow. The
 * sparkle family is cyan · aqua · deep blue · cool-white.
 */
export const tideTheme: Theme = {
  dark: true,
  bg: '#03101a',
  bg1: '#071a29',
  bg2: '#0a2237',
  bg3: '#0f2d46',
  text: '#e3f3ff',
  dim: '#7fa8c0',
  accent: '#22d3ee',
  accent2: '#67e8f9',
  border: '#123549',
  shadow: '#00344a',
  track: '#123b52',
  overlay: 'rgba(0,7,14,0.68)',
  sparkles: [
    { core: '#67e8f9', glow: '#0891b2', hot: '#ecfeff' },
    { core: '#38bdf8', glow: '#0284c7', hot: '#f0faff' },
    { core: '#60a5fa', glow: '#2563eb', hot: '#eef4ff' },
    { core: '#ffffff', glow: '#22d3ee', hot: '#ffffff' },
  ],
};

/** Which concrete palette a selection resolves to ('system' follows OS). */
export function themeForMode(mode: MobileThemeMode, scheme?: ColorSchemeName): Theme {
  switch (mode) {
    case 'ember':
      return emberTheme;
    case 'phosphor':
      return phosphorTheme;
    case 'nebula':
      return nebulaTheme;
    case 'tide':
      return tideTheme;
    case 'light':
      return lightTheme;
    case 'dark':
      return darkTheme;
    default:
      // 'system' (and any stale stored value) behaves exactly as before.
      return scheme === 'light' ? lightTheme : darkTheme;
  }
}

/** Shared metrics so every screen lines up (VLC-like density). */
export const metrics = {
  topBarHeight: 60,
  subTabsHeight: 46,
  bottomNavHeight: 60,
  /** Android gesture-nav inset adds to the bottom bar. */
  bottomNavMinHeight: 56,
  screenPadding: 14,
  tileRadius: 4,
  rowRadius: 4,
} as const;

interface ThemeContextValue {
  theme: Theme;
  mode: MobileThemeMode;
  setMode: (m: MobileThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: darkTheme,
  mode: 'system',
  setMode: () => {},
});

export function ThemeProvider({
  children,
  mode,
  onModeChange,
}: {
  children: React.ReactNode;
  mode: MobileThemeMode;
  onModeChange: (m: MobileThemeMode) => void;
}) {
  const scheme = useColorScheme();
  const [override, setOverride] = useState<MobileThemeMode>(mode);

  // Adopt the persisted preference once services hand it over.
  useEffect(() => {
    setOverride(mode);
  }, [mode]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: themeForMode(override, scheme),
      mode: override,
      setMode: (m: MobileThemeMode) => {
        setOverride(m);
        onModeChange(m);
      },
    }),
    [override, scheme, onModeChange]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext).theme;
}

export function useThemeMode(): MobileThemeMode {
  return useContext(ThemeContext).mode;
}

export function useSetThemeMode(): (m: MobileThemeMode) => void {
  const { setMode } = useContext(ThemeContext);
  return setMode;
}

/** Convenience hook returning a stable callback for opening a settings page. */
export function useStableCallback<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = React.useRef(fn);
  ref.current = fn;
  return useCallback(((...args: never[]) => ref.current(...args)) as T, []);
}
