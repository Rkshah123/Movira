import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { TabKey } from '../ui/BottomNav';

/** Pages that sit above the five-tab shell. */
export type SettingsPageKey =
  | 'mediaLibrary'
  | 'video'
  | 'audio'
  | 'headset'
  | 'subtitles'
  | 'network'
  | 'permissions'
  | 'interface'
  | 'extra'
  | 'advanced';

export type Route =
  | { name: 'shell' }
  | { name: 'search'; kind?: 'video' | 'audio' | 'all' }
  | { name: 'playlist'; id: string }
  | { name: 'settings' }
  | { name: 'settingsPage'; page: SettingsPageKey }
  | { name: 'about' }
  | { name: 'authors' }
  | { name: 'folder'; path: string; title: string; selectMode?: boolean }
  | { name: 'collection'; kind: 'favorites' | 'downloads' | 'movies' | 'music'; title: string }
  | { name: 'equalizer' }
  | { name: 'version' }
  | { name: 'nowPlaying' };

interface NavValue {
  route: Route;
  stack: Route[];
  tab: TabKey;
  /** Switches the bottom tab; returns to the shell (drops pushed pages). */
  setTab: (t: TabKey) => void;
  push: (r: Route) => void;
  replace: (r: Route) => void;
  pop: () => void;
  popToShell: () => void;
  /** Android hardware back. Returns false when nothing left to pop. */
  handleBack: () => boolean;
}

const NavContext = createContext<NavValue | null>(null);

export function useNav(): NavValue {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error('useNav must be used inside <NavProvider>');
  return ctx;
}

export function NavProvider({ children }: { children: React.ReactNode }) {
  const [tab, setTabState] = useState<TabKey>('video');
  const [stack, setStack] = useState<Route[]>([{ name: 'shell' }]);

  const setTab = useCallback((t: TabKey) => {
    setTabState(t);
    setStack([{ name: 'shell' }]);
  }, []);

  const push = useCallback((r: Route) => setStack((s) => [...s, r]), []);
  const replace = useCallback((r: Route) => setStack((s) => [...s.slice(0, -1), r]), []);
  const pop = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const popToShell = useCallback(() => setStack((s) => (s.length > 1 ? [s[0]] : s)), []);

  const handleBack = useCallback(() => {
    let popped = false;
    setStack((s) => {
      if (s.length > 1) {
        popped = true;
        return s.slice(0, -1);
      }
      return s;
    });
    // `popped` is assigned synchronously inside the updater only when the
    // updater actually runs; React may defer it, so derive it from length.
    return popped || stack.length > 1;
  }, [stack.length]);

  const value = useMemo<NavValue>(
    () => ({
      route: stack[stack.length - 1],
      stack,
      tab,
      setTab,
      push,
      replace,
      pop,
      popToShell,
      handleBack,
    }),
    [stack, tab, setTab, push, replace, pop, popToShell, handleBack]
  );

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}