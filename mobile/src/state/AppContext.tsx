import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaItem, Playlist, QueueState } from '@shared';
import TrackPlayer, { Event, State } from 'react-native-track-player';
import type { MobileServices, VideoSource } from '../services';
import { settingsStore, defaultMobileSettings, type MobileSettings } from '../settings';
import { listDeviceStorages, type DeviceStorage } from '../devices';
import { pickedStore } from '../picked';
import { identityKeys } from '../sameFile';

interface AppStateValue {
  services: MobileServices;
  settings: MobileSettings;
  setSetting: <K extends keyof MobileSettings>(key: K, value: MobileSettings[K]) => void;
  storages: DeviceStorage[];

  media: MediaItem[];
  videos: MediaItem[];
  audios: MediaItem[];
  favorites: MediaItem[];
  playlists: Playlist[];

  current: MediaItem | null;
  queue: QueueState;
  playing: boolean;
  /** True once the library finished its first scan (empty screen or list). */
  scanned: boolean;

  /**
   * Counts explicit play requests — one per `play()` call.
   *
   * `current` alone cannot say WHY it changed: it also changes when a queue is
   * restored at launch and when the queue advances on its own. This counter is
   * what separates "the user picked something" from "something arrived by
   * itself", which is what lets the player open on the very first tap.
   */
  playRequest: number;

  /** What the video backend should render; null until a video is loaded. */
  videoSource: VideoSource | null;

  play: (items: MediaItem[], start?: number) => void;
  togglePlayPause: () => void;
  next: () => void;
  previous: () => void;
  seek: (t: number) => void;

  toggleFavorite: (item: MediaItem) => void;
  isFavorite: (id: string) => boolean;

  createPlaylist: (name: string) => Promise<Playlist>;
  deletePlaylist: (id: string) => void;
  renamePlaylist: (id: string, name: string) => void;

  refreshLibrary: () => Promise<void>;
  addLibraryFolder: (path: string) => Promise<void>;
  removeLibraryFolder: (id: string) => Promise<void>;
  addPickedFiles: (uris: string[], kind?: 'audio' | 'video') => Promise<MediaItem[]>;

  /** Playback progress for the current item, in seconds. */
  progress: { time: number; duration: number };
  setProgress: (p: { time: number; duration: number }) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used inside <AppStateProvider>');
  return ctx;
}

export function AppStateProvider({
  services,
  children,
  onCurrentChange,
  onPlayingChange,
  onProgress,
  registerEnginePlaying,
  engineProgress,
  videoSource = null,
}: {
  services: MobileServices;
  children: React.ReactNode;
  onCurrentChange: (item: MediaItem | null) => void;
  onPlayingChange: (playing: boolean) => void;
  onProgress: (time: number, duration: number) => void;
  registerEnginePlaying?: (fn: (playing: boolean) => void) => void;
  /** Live audio position from the TrackPlayer hook, owned by the app shell. */
  engineProgress: { position: number; duration: number };
  /**
   * What the video backend should render, or null.
   *
   * Passed in as state so that the player re-renders when a source arrives. It is
   * null on the very first render of a freshly opened player, because the engine
   * only learns the source after an await.
   */
  videoSource?: VideoSource | null;
}) {
  const [settings, setSettings] = useState<MobileSettings>(defaultMobileSettings);
  const [storages, setStorages] = useState<DeviceStorage[]>([]);
  const [scannedItems, setScannedItems] = useState<MediaItem[]>([]);
  const [pickedItems, setPickedItems] = useState<MediaItem[]>([]);
  const [favorites, setFavorites] = useState<MediaItem[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [current, setCurrent] = useState<MediaItem | null>(null);
  const [queue, setQueue] = useState<QueueState>({ items: [], index: -1, repeat: 'off', shuffle: false });
  const [playing, setPlaying] = useState(false);
  const [scanned, setScanned] = useState(false);
  /** Bumped by `play()`; see `playRequest` on the context value. */
  const [playRequest, setPlayRequest] = useState(0);
  const [progress, setProgressState] = useState({ time: 0, duration: 0 });
  const scanning = useRef(false);

  // --- preferences -------------------------------------------------------
  useEffect(() => settingsStore.subscribe(setSettings), []);

  const setSetting = useCallback(<K extends keyof MobileSettings>(key: K, value: MobileSettings[K]) => {
    void settingsStore.set(key, value);
  }, []);

  // --- library / playlists / favourites ---------------------------------
  useEffect(() => {
    void pickedStore.load();
    const u0 = pickedStore.subscribe(setPickedItems);
    const u1 = services.library.subscribe((items) => setScannedItems(items));
    const u2 = services.playlists.subscribe(setPlaylists);
    const u3 = services.userData.subscribe(() => setFavorites(services.userData.getFavorites()));
    return () => {
      u0();
      u1();
      u2();
      u3();
    };
  }, [services]);

  // Picked files and scanned files are one library as far as the UI is
  // concerned; a file can only appear once, picked entries win.
  //
  // Identity is NOT the `path` string. A picked entry carries a content:// URI
  // while the scanner records a /storage/... path, so comparing paths alone let
  // the same file sit in the list three times over — once scanned and twice from
  // the picker, which returns a different URI each time. Identity keys from
  // `sameFile` fold those together instead.
  //
  // Dedupe, merge and the video/audio split happen in a single pass. Doing it
  // as `merge -> filter -> filter` walked the whole library three times and
  // rebuilt three intermediate arrays on every rescan, which is what made a
  // large library expensive to hold in memory. The keys are collected into a Set
  // as the list is built, so the pass stays linear rather than becoming the
  // quadratic "search everything kept so far" it replaces.
  const library = useMemo(() => {
    const seen = new Set<string>();
    const all: MediaItem[] = [];
    const videos: MediaItem[] = [];
    const audios: MediaItem[] = [];
    const add = (list: MediaItem[]) => {
      for (const item of list) {
        const keys = identityKeys(item);
        if (keys.some((k) => seen.has(k))) continue;
        for (const k of keys) seen.add(k);
        all.push(item);
        (item.type === 'video' ? videos : audios).push(item);
      }
    };
    add(pickedItems);
    add(scannedItems);
    return { all, videos, audios };
  }, [pickedItems, scannedItems]);

  const media = library.all;
  const videos = library.videos;
  const audios = library.audios;

  // Once the scan has finished, retire any pick the scan also found. Without
  // this the duplicate stays in storage and the library only looks right.
  const scanComplete = scanned && scannedItems.length > 0;
  useEffect(() => {
    if (!scanComplete) return;
    void pickedStore.pruneDuplicates(scannedItems);
  }, [scanComplete, scannedItems]);

  // --- initial library scan ---------------------------------------------
  const refreshLibrary = useCallback(async () => {
    if (scanning.current) return;
    scanning.current = true;
    try {
      const found = await listDeviceStorages();
      setStorages(found);
      const existing = services.library.getFolders();
      const known = new Set(existing.map((f) => f.path));
      for (const s of found) {
        if (!known.has(s.path)) await services.library.addFolder(s.path, 'mixed');
      }
      if (found.length > 0) await services.library.rescan();
    } catch (e) {
      console.warn('Movira: library scan failed', e);
    } finally {
      scanning.current = false;
      setScanned(true);
    }
  }, [services]);

  useEffect(() => {
    if (!settingsStore.isLoaded()) return;
    if (!settings.autoScan && services.library.getAll().length > 0) {
      setScanned(true);
      return;
    }
    void refreshLibrary();
  }, [services, settings.autoScan, refreshLibrary]);

  // --- playback ----------------------------------------------------------
  const syncQueue = useCallback(() => {
    const q = services.player.getQueue();
    const c = services.player.getCurrent();
    // Guard against the 2-second poll re-rendering the whole tree when nothing
    // actually changed (repeat/shuffle toggles rebuild the state object).
    setQueue((prev) =>
      prev.index === q.index &&
      prev.repeat === q.repeat &&
      prev.shuffle === q.shuffle &&
      prev.items.length === q.items.length &&
      prev.items.every((it, i) => it.id === q.items[i]?.id)
        ? prev
        : q
    );
    setCurrent((prev) => (prev?.id === c?.id ? prev : c));
    onCurrentChange(c);
  }, [services, onCurrentChange]);

  const syncPlaying = useCallback(
    (p: boolean) => {
      setPlaying(p);
      onPlayingChange(p);
    },
    [onPlayingChange]
  );

  const play = useCallback(
    (items: MediaItem[], start = 0) => {
      if (!items.length) return;
      services.player.setQueue(items, start, true);
      const q = services.player.getQueue();
      const c = services.player.getCurrent();
      setQueue(q);
      setCurrent(c);
      // Recorded for the player auto-open in App.tsx. Deliberately bumped on
      // EVERY call, not only when the item differs: re-tapping the video that is
      // already loaded leaves `current` unchanged, and that still has to open the
      // player or the second tap would do nothing either.
      setPlayRequest((n) => n + 1);
      onCurrentChange(c);
      syncPlaying(true);
    },
    [services, onCurrentChange, syncPlaying]
  );

  // The native player is the authority on whether sound is coming out: a track
  // can start, pause or stop from the notification, a headset button or the end
  // of a queue without any of it passing through this context. Mirroring the
  // real playback state keeps the mini-player button honest.
  useEffect(() => {
    const sub = TrackPlayer.addEventListener(Event.PlaybackState, (e) => {
      syncPlaying(e.state === State.Playing || e.state === State.Buffering);
    });
    return () => sub.remove();
  }, [syncPlaying]);

  useEffect(() => {
    registerEnginePlaying?.(syncPlaying);
  }, [registerEnginePlaying, syncPlaying]);

  const togglePlayPause = useCallback(() => {
    if (!current) return;
    if (playing) {
      void services.player.pause().then(() => syncPlaying(false));
    } else {
      void services.engine.togglePlayPause().then(() => syncPlaying(true));
    }
  }, [current, playing, services, syncPlaying]);

  const next = useCallback(() => {
    void services.player.next().then(syncQueue);
  }, [services, syncQueue]);

  const previous = useCallback(() => {
    void services.player.previous().then(syncQueue);
  }, [services, syncQueue]);

  const seek = useCallback((t: number) => void services.engine.seek(t), [services]);

  // Keep the queue visible state in step with the service after repeat/shuffle
  // toggles, resume saving and library edits.
  useEffect(() => {
    const t = setInterval(syncQueue, 2000);
    return () => clearInterval(t);
  }, [syncQueue]);

  const lastVideoPush = useRef(0);
  // Read by the two progress timers below, which are created once and therefore
  // cannot close over `current` directly.
  const currentRef = useRef<MediaItem | null>(current);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  const setProgress = useCallback(
    (p: { time: number; duration: number }) => {
      lastVideoPush.current = Date.now();
      setProgressState(p);
      onProgress(p.time, p.duration);
    },
    [onProgress]
  );

  // Audio pushes its own progress from the native player, so the position has to
  // be mirrored into the context or the audio player and the scrubber sit at
  // 0:00 forever. Video publishes through `setProgress`, so a recent video push
  // wins and the audio ticker stands down while the video surface is driving.
  useEffect(() => {
    const t = setInterval(() => {
      if (!currentRef.current) return;
      if (Date.now() - lastVideoPush.current < 2500) return;
      const { position, duration } = engineProgress;
      if (!position && !duration) return;
      setProgressState({ time: position, duration });
    }, 500);
    return () => clearInterval(t);
  }, [engineProgress.position, engineProgress.duration]);

  // Ask the player directly. `useProgress` swallows every failure, which makes a
  // dead bridge look identical to a track that never started; calling it here
  // keeps the failure visible instead of silently freezing the scrubber at 0:00.
  useEffect(() => {
    let cancelled = false;
    let reported = false;
    const tick = async () => {
      // Nothing is loaded: skip the bridge call entirely rather than waking it
      // once a second forever, which burns battery and keeps the app from ever
      // going idle (and so breaks `uiautomator` snapshots for anyone debugging).
      if (!currentRef.current) {
        if (!cancelled) setTimeout(tick, 1000);
        return;
      }
      try {
        const p = await TrackPlayer.getProgress();
        if (cancelled) return;
        if (Date.now() - lastVideoPush.current >= 2500 && (p.position || p.duration)) {
          setProgressState({ time: p.position, duration: p.duration });
        }
      } catch (e) {
        // Log once: the poll runs for as long as the screen is open.
        if (!reported) {
          reported = true;
          console.warn('Movira: getProgress failed', e);
        }
      }
      if (!cancelled) setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const sub = TrackPlayer.addEventListener(
      Event.PlaybackProgressUpdated,
      (e: { position?: number; duration?: number }) => {
        if (Date.now() - lastVideoPush.current < 2500) return;
        const time = e?.position ?? 0;
        const duration = e?.duration ?? 0;
        if (!time && !duration) return;
        setProgressState((p) => (p.time === time && p.duration === duration ? p : { time, duration }));
      }
    );
    return () => sub.remove();
  }, []);

  // --- favourites --------------------------------------------------------
  const toggleFavorite = useCallback(
    (item: MediaItem) => {
      void services.userData.toggleFavorite(item);
    },
    [services]
  );
  const isFavorite = useCallback((id: string) => services.userData.isFavorite(id), [services]);

  // --- playlists ---------------------------------------------------------
  const createPlaylist = useCallback((name: string) => services.playlists.create(name), [services]);
  const deletePlaylist = useCallback((id: string) => void services.playlists.remove(id), [services]);
  const renamePlaylist = useCallback(
    (id: string, name: string) => void services.playlists.rename(id, name),
    [services]
  );

  // --- folders / picked files -------------------------------------------
  const addLibraryFolder = useCallback(
    async (path: string) => {
      await services.library.addFolder(path, 'mixed');
      await services.library.rescan();
    },
    [services]
  );

  const removeLibraryFolder = useCallback(
    async (id: string) => {
      await services.library.removeFolder(id);
    },
    [services]
  );

  const addPickedFiles = useCallback(
    async (uris: string[], kind?: 'audio' | 'video') => {
      if (!uris.length) return [];
      // The freshly added items are handed back so callers can act on them
      // (the video tab plays them); reading `media` after the await would only
      // see the pre-pick snapshot captured here.
      return pickedStore.add(
        uris,
        { paths: new Set(media.map((i) => i.path)), items: media },
        kind
      );
    },
    [media]
  );

  const value = useMemo<AppStateValue>(
    () => ({
      services,
      settings,
      setSetting,
      storages,
      media,
      videos,
      audios,
      favorites,
      playlists,
      current,
      queue,
      playing,
      scanned,
      playRequest,
      videoSource,
      play,
      togglePlayPause,
      next,
      previous,
      seek,
      toggleFavorite,
      isFavorite,
      createPlaylist,
      deletePlaylist,
      renamePlaylist,
      refreshLibrary,
      addLibraryFolder,
      removeLibraryFolder,
      addPickedFiles,
      progress,
      setProgress,
    }),
    [
      services,
      settings,
      setSetting,
      storages,
      media,
      videos,
      audios,
      favorites,
      playlists,
      current,
      queue,
      playing,
      scanned,
      playRequest,
      videoSource,
      play,
      togglePlayPause,
      next,
      previous,
      seek,
      toggleFavorite,
      isFavorite,
      createPlaylist,
      deletePlaylist,
      renamePlaylist,
      refreshLibrary,
      addLibraryFolder,
      removeLibraryFolder,
      addPickedFiles,
      progress,
      setProgress,
    ]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}