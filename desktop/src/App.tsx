import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MediaItem, QueueState, SubtitleTrack, PlaybackSettings, ThemeMode } from '@shared';
import { detectMediaType, formatTime, baseName, uniqueId, describeMediaError } from '@shared';
import { moviraApi } from './api';
import { createServices, type DesktopServices } from './services';
import PlayerView from './components/PlayerView';
import { closeTopPanel } from './components/FloatingPanel';
import LibraryView from './components/LibraryView';
import PlaylistsView from './components/PlaylistsView';
import SettingsView from './components/SettingsView';
import TopBar from './components/TopBar';
import HomeView from './components/HomeView';
import DiagnosticsView from './components/DiagnosticsView';
import { lagRecorder } from './lagRecorder';

export type View = 'media' | 'home' | 'player' | 'library' | 'playlists' | 'settings' | 'diagnostics';

export default function App() {
  const [services, setServices] = useState<DesktopServices | null>(null);
  const [view, setView] = useState<View>('home');
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState<MediaItem | null>(null);
  const [queue, setQueue] = useState<QueueState>({ items: [], index: -1, repeat: 'off', shuffle: false });
  const [progress, setProgress] = useState({ time: 0, duration: 0, buffered: 0 });
  const [settings, setSettings] = useState<PlaybackSettings | null>(null);
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [error, setError] = useState<string | null>(null);
  const [subtitle, setSubtitle] = useState<SubtitleTrack | null>(null);
  // VLC-style video zoom (key C): cycle fit → fill → stretch.
  const [zoomMode, setZoomMode] = useState(0);
  const [volume, setVolume] = useState(() => {
    const v = Number(localStorage.getItem('movira:volumePref'));
    return isFinite(v) && v >= 0 ? v : 0.8;
  });
  // The element starts at volume 1 with audio audible while this mirror said 0
  // (from a stored preference) until something fired 'volumechange' — so the
  // slider ball and the mute glyph disagreed with what you actually heard. The
  // engine applies the stored preference as soon as the element is attached, and
  // the state is mirrored from the element on the first media load.
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoHostRef = useRef<HTMLDivElement | null>(null);
  /**
   * Services are published to this ref the instant they resolve, BEFORE React
   * commits the matching `setServices` state update. Anything that starts
   * playback (an "Open with" launch file arriving a moment after startup, a
   * second-instance file, the E2E hook) can therefore land in that window, and
   * reading only the state made it bail out silently — the file simply never
   * opened. Reading the ref first closes the gap.
   */
  const servicesRef = useRef<DesktopServices | null>(null);

  const handleError = useCallback((msg: string) => {
    setError(msg);
    // Auto-dismiss ~4s. When tier-2 escalation recovers a failed native
    // attempt within that window, the success of the fallback playback
    // suppresses the toast instead of leaving a stale error on screen.
    setTimeout(() => setError((cur) => (cur === msg ? null : cur)), 4000);
  }, []);

  useEffect(() => {
    let disposed = false;
    if (!videoRef.current) {
      const el = document.createElement('video');
      el.playsInline = true;
      el.className = 'movira-video';
      el.preload = 'metadata';
      videoRef.current = el;
      // Diagnostic only: records stalls as they occur so a real-world stutter
      // can be inspected afterwards. It never writes currentTime, never calls
      // load(), and never touches src. The probe reads the engine through
      // servicesRef because services resolve asynchronously below.
      lagRecorder.attach(el, {
        currentTime: () => videoRef.current?.currentTime ?? 0,
        knownDuration: () => servicesRef.current?.engine.knownDuration() ?? 0,
        isFallbackBusy: () => servicesRef.current?.engine.isFallbackBusy() ?? false,
      });
    }
  const events = {
    onProgress: (t: number, d: number) => setProgress({ time: t, duration: d, buffered: 0 }),
    onEnded: () => servicesRef.current?.player.handleEnded(),
    onError: (m: string) => handleError(m),
    // Fallback-tier playback recovered: clear any transient error toast (the
    // escalation path surfaces a native-tier failure before succeeding).
    onPlayingChange: (p: boolean) => {
      setPlaying(p);
      if (p) setError(null);
    },
  };
    createServices(videoRef, events, videoHostRef).then((s) => {
      if (disposed) return;
      servicesRef.current = s;
      // Renderer-local hook for end-to-end UI tests (timeline seeking etc.);
      // exposes nothing beyond this page's own context.
      (window as unknown as { __moviraServices?: DesktopServices }).__moviraServices = s;
      setServices(s);
      setSettings(s.userData.getSettings());
      setQueue(s.player.getQueue());
      setCurrent(s.player.getCurrent());
      s.userData.subscribe(() => setSettings(s.userData.getSettings()));
      // Files passed at launch via "Open with" / double-click in Explorer:
      // play the first associated media file once services are ready.
      // (Via ref — the mount closure would otherwise capture the first render's
      // callback, where `services` was still null.)
      void moviraApi.consumeLaunchedFiles().then((paths) => {
        if (disposed || !paths.length) return;
        playFromPathsRef.current(paths);
      });
    });
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!services) return;
    const el = videoRef.current;
    if (!el) return;
    // Progress state is rAF-aligned and THROTTLED to ~10Hz for React. The
    // video element renders independently of React, so a 10Hz timeline is
    // visually indistinguishable — while feeding React state at 60fps made the
    // whole app tree reconcile every frame, competing with video decode for
    // the main thread (dropped frames, janky seeks during playback).
    let rafId: number | null = null;
    let lastUiAt = 0;
    let lastSaved = 0;
    // Settings are read through a ref rather than getSettings() per frame:
    // getSettings() allocates a fresh settings object on every call and this
    // loop runs at 10Hz for the whole session.
    const settingsRef = { current: services.userData.getSettings() };
    const pushProgress = (force = false) => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const now = performance.now();
        if (!force && now - lastUiAt < 100) return;
        lastUiAt = now;
        // While a fallback seek-restart is mid-flight the element is
        // transiently emptied (old pipeline detached, new one not attached
        // yet). Reporting its raw {0, NaN} state snapped the timeline thumb to
        // 0 and cleared the seek preview mid-drag — the visible "jump" during
        // seeks. Hold the last rendered state until the new pipeline attaches.
        if (!el.currentSrc && services.engine.isFallbackBusy()) return;
        const bl = el.buffered.length;
        const buffered = bl > 0 ? el.buffered.end(bl - 1) : 0;
        // File time, not raw element time: on the ffmpeg fallback tier the
        // element clock restarts at 0 after each seek-restart (muxer
        // normalization) — the engine maps it back onto the file timeline.
        setProgress({ time: services.engine.currentFileTime(), duration: services.engine.knownDuration(), buffered });
        // Resume positions persist at most every 5s — a timeupdate-driven
        // localStorage write per tick caused constant synchronous disk I/O.
        // (Skipped once the element is emptied — Stop must not re-persist a
        // position for media that is no longer loaded.)
        const tnow = Date.now();
        if (current && el.currentSrc && settingsRef.current.resumePlayback !== false && tnow - lastSaved > 5000) {
          lastSaved = tnow;
          void services.userData.saveResumePosition(current.id, services.engine.currentFileTime(), el.duration || 0);
        }
      });
    };
    const onTime = () => pushProgress(false);
    // Keep the settings ref in step with user changes (Settings panel writes).
    const unsubSettings = services.userData.subscribe(() => {
      settingsRef.current = services.userData.getSettings();
    });
    // A seek must repaint the position immediately (thumb snap while paused,
    // first frame after a fallback-tier restart) — bypass the throttle.
    const onSeeked = () => pushProgress(true);
    const onPlay = () => {
      // A seek-restart tears the pipeline down and rebuilds it, which fires
      // play/pause events that describe the SWAP, not the user. In that window
      // the engine owns the truth (it re-asserts the user's intent when the
      // new pipeline attaches, and pushes the state explicitly).
      if (services.engine.isRestarting()) return;
      services.engine.syncPlayingIntent(true);
      setPlaying(true);
    };
    const onPause = () => {
      if (services.engine.isRestarting()) return;
      services.engine.syncPlayingIntent(false);
      setPlaying(false);
    };
    const onEnded = () => services.player.handleEnded();
    /**
     * Media errors (spec §15) must never wedge the player: surface a specific,
     * actionable message and leave the element in a clean state so the user can
     * immediately open another file. MEDIA_ERR codes map to distinct explanations
     * (unsupported codec vs corrupted file vs interrupted load).
     */
    let errorToastTimer: ReturnType<typeof setTimeout> | null = null;
    const onError = () => {
      const code = el.error?.code ?? 0;
      const detail = el.error?.message;
      // Final safety net: make sure no half-loaded decoder state lingers.
      try {
        el.pause();
      } catch { /* ignore */ }
      // The engine escalates to the ffmpeg tier on native failure — that also
      // fires this DOM 'error' event. Give the pipeline a moment to swap the
      // source; only surface the toast if the error is really terminal.
      const failedSrc = el.currentSrc;
      if (errorToastTimer) clearTimeout(errorToastTimer);
      errorToastTimer = setTimeout(() => {
        errorToastTimer = null;
        if (el.error && el.currentSrc === failedSrc) {
          handleError(describeMediaError(code, current?.path ?? '', detail));
        }
      }, 900);
    };
    // Watchdog: TS/M2TS/AVI streams can stall forever without ever firing `error`.
    // After 25s with no progress we report it instead of spinning silently —
    // but the app stays responsive and the user can seek/reopen at any time.
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!el.paused && el.readyState < 3 && !el.error) {
          handleError(`This stream is taking unusually long to buffer${current ? ` (${baseName(current.path)})` : ''} — you can keep using Movira or open another file.`);
        }
      }, 25000);
    };
    const disarmStall = () => {
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    };
    // engine.stop() empties the element (src removed, load()): 'emptied' fires
    // with no currentSrc. Disarm the stall watchdog and any pending error toast
    // so nothing stale can fire into the reset state and freeze the UI story.
    const onEmptied = () => {
      if (!el.currentSrc) {
        disarmStall();
        if (errorToastTimer) { clearTimeout(errorToastTimer); errorToastTimer = null; }
      }
    };
    const onLoaded = () => {
      disarmStall();
      setProgress((p) => ({ ...p, duration: services.engine.knownDuration() }));
      // Mirror the element's real volume/mute state into the UI. Without this
      // the slider can show a value the element never had (the stored
      // preference vs the element's own default), which is what made the wheel
      // look like it "did nothing".
      setVolume(el.volume);
      setMuted(el.muted);
      const item = current;
      // Resume-position applies ONLY to native (file://) sources: on the MSE
      // fallback tier loadedmetadata fires after the first init segment, and
      // jumping here would fight the player's own initial seek (and land in a
      // region that is never buffered → stall). A fresh load with autoplay
      // already cleared the saved position in the engine (Stop semantics).
      if (item && services.userData.getSettings().resumePlayback && !el.src.startsWith('blob:')) {
        const pos = services.userData.getResumePosition(item.id);
        if (pos > 5 && pos < (el.duration || Infinity) - 10) el.currentTime = pos;
      }
      el.playbackRate = services.userData.getSettings().defaultSpeed;
    };
    const onWaiting = () => armStall();
    const onRecovered = () => disarmStall();
    let volSaveTimer: ReturnType<typeof setTimeout> | null = null;
    const onVol = () => {
      setVolume(el.volume);
      setMuted(el.muted);
      // Persist the preference DEBOUNCED: dragging the volume slider (or
      // wheel-stepping it) fires a volumechange per move — a synchronous
      // localStorage write per move janks the gesture.
      if (volSaveTimer) clearTimeout(volSaveTimer);
      volSaveTimer = setTimeout(() => {
        volSaveTimer = null;
        try { localStorage.setItem('movira:volumePref', String(el.volume)); } catch { /* ignore */ }
      }, 250);
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('progress', onTime);
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    el.addEventListener('emptied', onEmptied);
    el.addEventListener('loadedmetadata', onLoaded);
    el.addEventListener('volumechange', onVol);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('stalled', onWaiting);
    el.addEventListener('playing', onRecovered);
    el.addEventListener('canplay', onRecovered);
    return () => {
      unsubSettings();
      disarmStall();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (errorToastTimer) { clearTimeout(errorToastTimer); errorToastTimer = null; }
      // Flush a pending volume preference before the listeners go away.
      if (volSaveTimer) {
        clearTimeout(volSaveTimer);
        volSaveTimer = null;
        try { localStorage.setItem('movira:volumePref', String(el.volume)); } catch { /* ignore */ }
      }
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('progress', onTime);
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      el.removeEventListener('emptied', onEmptied);
      el.removeEventListener('loadedmetadata', onLoaded);
      el.removeEventListener('volumechange', onVol);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('stalled', onWaiting);
      el.removeEventListener('playing', onRecovered);
      el.removeEventListener('canplay', onRecovered);
    };
  }, [services, current, handleError]);

  useEffect(() => {
    const root = document.documentElement;
    const apply = (t: ThemeMode) => {
      root.setAttribute('data-theme', t);
    };
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mq.matches ? 'dark' : 'light');
      const fn = (e: MediaQueryListEvent) => apply(e.matches ? 'dark' : 'light');
      mq.addEventListener('change', fn);
      return () => mq.removeEventListener('change', fn);
    }
    apply(theme);
  }, [theme]);

  useEffect(() => {
    if (!settings) return;
    setTheme(settings.theme);
  }, [settings?.theme]);

  const playItems = useCallback(
    (items: MediaItem[], startIndex = 0) => {
      // Prefer the ref: it is populated the moment services exist, whereas the
      // state only after React commits (see servicesRef).
      const s = servicesRef.current ?? services;
      if (!s) return;
      s.player.setQueue(items, startIndex, true);
      setQueue(s.player.getQueue());
      setCurrent(s.player.getCurrent());
      // Only jump to the player when the app is idle on the home screen; if the
      // user is inside a section (Library, Playlists, Settings), leave them there
      // — the top-bar mini player + Now Playing stay reachable.
      setView((v) => (v === 'home' ? 'player' : v));
    },
    [services]
  );

  /** Open media files by absolute path — file-association launches ("Open
   *  with" → Movira) and second-instance file opens funnel through here. */
  const playFromPaths = useCallback(
    (paths: string[]) => {
      if (!servicesRef.current && !services) return;
      const items: MediaItem[] = paths
        .map((p) => {
          const type = detectMediaType(p);
          if (!type) return null;
          return {
            id: uniqueId(),
            type,
            title: baseName(p).replace(/\.[^.]+$/, ''),
            path: p,
            addedAt: Date.now(),
          } as MediaItem;
        })
        .filter(Boolean) as MediaItem[];
      if (items.length) playItems(items, 0);
    },
    [services, playItems]
  );

  // Windows hands over files opened from Explorer while Movira is running
  // (second instance). Ref keeps the subscription pointing at fresh state.
  const playFromPathsRef = useRef(playFromPaths);
  playFromPathsRef.current = playFromPaths;
  useEffect(() => {
    moviraApi.onOpenMediaPaths((paths) => playFromPathsRef.current(paths));
  }, []);

  // E2E test hook: the same code path the UI uses to start playback (exposed
  // renderer-locally; setQueue alone cannot flip React state from a script).
  useEffect(() => {
    (window as unknown as { __moviraTestPlay?: unknown }).__moviraTestPlay = playItems;
    // Lets an automated run pull the recorded stall evidence after the fact,
    // without going near the element.
    const w = window as unknown as {
      __moviraLagReport?: unknown;
      __moviraLagLive?: unknown;
      __moviraLagReset?: unknown;
    };
    w.__moviraLagReport = () => lagRecorder.report();
    w.__moviraLagLive = () => lagRecorder.live();
    w.__moviraLagReset = () => lagRecorder.reset();
  }, [playItems]);

  /** Media menu → Open File: a single-select picker that replaces the queue. */
  const openSingleFile = useCallback(async () => {
    if (!services) return;
    const path = await moviraApi.openFileSingle();
    if (!path) return;
    playFromPathsRef.current([path]);
  }, [services]);

  /**
   * Media menu → Open Multiple Files in Queue: appends to whatever is already
   * queued instead of replacing it, and does not hijack playback — VLC keeps
   * playing the current track while the selection is added underneath it.
   */
  const openMultipleInQueue = useCallback(async () => {
    const s = servicesRef.current ?? services;
    if (!s) return;
    const paths = await moviraApi.openFiles();
    if (!paths.length) return;
    const items: MediaItem[] = paths
      .map((p) => {
        const type = detectMediaType(p);
        if (!type) return null;
        return {
          id: uniqueId(),
          type,
          title: baseName(p).replace(/\.[^.]+$/, ''),
          path: p,
          addedAt: Date.now(),
        } as MediaItem;
      })
      .filter(Boolean) as MediaItem[];
    if (!items.length) {
      handleError('No supported media files selected');
      return;
    }
    s.player.addToQueue(items);
    // addToQueue() starts playback itself when the queue was empty; here we only
    // have to mirror the new state into React. No toast: the queue panel shows
    // the result, and the error toast is reserved for actual failures.
    setQueue(s.player.getQueue());
    setCurrent(s.player.getCurrent());
  }, [services]);

  const quitApp = useCallback(() => { void moviraApi.quit(); }, []);

  const openFolderAsQueue = useCallback(async () => {
    if (!services) return;
    const folder = await moviraApi.openFolder();
    if (!folder) return;
    const files = await moviraApi.listMedia(folder);
    const items: MediaItem[] = files
      .map((f) => {
        const type = detectMediaType(f.path);
        if (!type) return null;
        return { id: uniqueId(), type, title: baseName(f.path).replace(/\.[^.]+$/, ''), path: f.path, size: f.size, addedAt: Date.now() } as MediaItem;
      })
      .filter(Boolean) as MediaItem[];
    if (!items.length) {
      handleError('No media found in folder');
      return;
    }
    playItems(items, 0);
  }, [services, playItems, handleError]);

  const next = useCallback(() => {
    if (!services) return;
    const st = services.player.getQueue();
    // NEVER re-load the entry that is already playing. With the usual
    // "I opened one movie" queue, Next/Previous resolved to the SAME index and
    // re-ran the whole load path — teardown, ffmpeg spawn, re-probe, re-buffer:
    // a multi-second freeze for a button that does nothing in VLC at the end of
    // the queue. Re-decoding is now reserved for an actual item change.
    if (st.items.length <= 1) return;
    if (!st.shuffle && st.index >= st.items.length - 1 && st.repeat === 'off') return;
    void services.player.next().then((moved) => {
      if (!moved) return;
      setQueue(services.player.getQueue());
      setCurrent(services.player.getCurrent());
    });
  }, [services]);

  const prev = useCallback(() => {
    if (!services) return;
    const st = services.player.getQueue();
    // VLC semantics: more than a few seconds in, Previous restarts the current
    // item (a cheap seek); otherwise it steps to the actual previous entry.
    // Never a re-load of the item already playing.
    if (services.engine.currentFileTime() > 3 || st.items.length <= 1) {
      void services.engine.seek(0);
      return;
    }
    void services.player.previous().then((moved) => {
      if (!moved) return;
      setQueue(services.player.getQueue());
      setCurrent(services.player.getCurrent());
    });
  }, [services]);

  const togglePlay = useCallback(() => {
    if (!services) return;
    // Ask the ENGINE, not the `playing` React mirror. Mid seek-restart the
    // element is transiently detached (paused, no src) while the media is on
    // its way back, so the mirror was both wrong on screen (the button showed
    // the play glyph while video was playing) and wrong on click (it turned a
    // Pause into a full reload from 0).
    if (services.engine.isPlayingIntent()) void services.player.pause();
    else void services.player.togglePlay();
  }, [services]);

  // Keep the display awake during playback (no-op when idle/paused).
  useEffect(() => {
    void moviraApi.setPowerSaveBlocker(playing).catch(() => undefined);
  }, [playing]);

  const setSubtitleTrack = useCallback(
    (track: SubtitleTrack | null) => {
      if (!services) return;
      void services.engine.setSubtitles(track);
      setSubtitle(track);
      services.subtitles.notifySubtitleChange(track);
    },
    [services]
  );

  /**
   * THE single writer for the element's volume state.
   *
   * Every control — mouse wheel, slider drag, arrow keys, the mute button —
   * funnels through here, and the React mirror is updated SYNCHRONOUSLY.
   * Previously each control wrote `el.volume` itself and the UI only caught up
   * through the element's asynchronous `volumechange` event, so a stale mirror
   * could leave the wheel changing what you heard while the glyph and the
   * slider ball refused to move.
   */
  const applyVolume = useCallback((level: number) => {
    const el = videoRef.current;
    if (!el) return;
    const v = Math.max(0, Math.min(1, level));
    // Zero IS mute; any non-zero level clears mute so stepping up is audible.
    el.muted = v === 0;
    el.volume = v;
    setVolume(v);
    setMuted(v === 0);
  }, []);

  /** VLC key V: cycle the REAL subtitle sources of this file —
   *  off → sidecar file beside the video → each subtitle track embedded in the
   *  file → off. With nothing available it opens the subtitle panel, exactly
   *  like VLC's "no subtitles" case. */
  const subCycleRef = useRef<{ key: string; label: string }[]>([]);
  const subIndexRef = useRef(-1);

  const buildSubChoices = useCallback(async () => {
    if (!services || !current) return [] as { key: string; label: string }[];
    if (subCycleRef.current.length) return subCycleRef.current;
    const choices: { key: string; label: string }[] = [];
    const dir = current.path.replace(/[\\/][^\\/]+$/, '');
    const base = baseName(current.path).replace(/\.[^.]+$/, '');
    for (const ext of ['.srt', '.vtt', '.ass', '.ssa']) {
      const candidate = `${dir}\\${base}${ext}`;
      if (await moviraApi.exists(candidate).catch(() => false)) {
        choices.push({ key: `sidecar:${candidate}`, label: `${base}${ext}` });
        break;
      }
    }
    // Embedded tracks come from the same probe the B key uses — these are the
    // file's own languages, not a UI label.
    const { subs } = await services.engine.getTracks();
    for (const s of subs) {
      choices.push({
        key: `embedded:${s.index}`,
        label: s.language ? `Subtitle ${s.language.toUpperCase()}` : `Subtitle ${s.index + 1}`,
      });
    }
    subCycleRef.current = choices;
    return choices;
  }, [services, current]);

  const toggleSubtitlesV = useCallback(async () => {
    if (!services || !current) return;
    const choices = await buildSubChoices();
    if (!choices.length) {
      // Nothing beside or inside the file: hand the request to the panel.
      window.dispatchEvent(new CustomEvent('movira:open-subtitles'));
      return;
    }
    // choices.length + 1 states: every source, then back to off.
    const nextIndex = (subIndexRef.current + 1) % (choices.length + 1);
    subIndexRef.current = nextIndex;
    if (nextIndex >= choices.length) {
      setSubtitleTrack(null);
      return;
    }
    const choice = choices[nextIndex];
    try {
      if (choice.key.startsWith('sidecar:')) {
        const content = await moviraApi.readSubtitle(choice.key.slice('sidecar:'.length));
        setSubtitleTrack(services.subtitles.loadLocal(choice.label, content));
      } else {
        const idx = Number(choice.key.slice('embedded:'.length));
        const track = await services.engine.getEmbeddedSubtitle(idx);
        setSubtitleTrack(track ? { ...track, label: choice.label } : null);
      }
    } catch {
      setSubtitleTrack(null);
    }
  }, [services, current, buildSubChoices, setSubtitleTrack]);

  // A new file has its own track list — never carry the previous one's cycle.
  useEffect(() => {
    subCycleRef.current = [];
    subIndexRef.current = -1;
  }, [current?.id]);

  /** VLC key B: cycle the file's REAL audio tracks through the engine (instant
   *  on the native tier; on the ffmpeg tier the audio is re-muxed at the same
   *  position). Returns the new label, '' when there is nothing to switch. */
  const cycleAudioTrack = useCallback(async () => {
    if (!services) return '';
    const label = await services.engine.cycleAudioTrack();
    return label;
  }, [services]);

  const seekBy = useCallback(
    (delta: number) => {
      if (!services) return;
      const el = videoRef.current;
      if (!el) return;
      // Spec §14: seeking must work near the beginning, middle and end of every
      // container. TS/M2TS can report NaN durations while probing — clamping with
      // `duration || 0` used to snap every keyboard seek to 0 — and near-end seeks
      // stop just short of the final frame instead of pinning it (repeat-one lock).
      const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : Number.MAX_SAFE_INTEGER;
      // File-time position (element clock restarts at 0 on the fallback tier).
      const target = Math.max(0, Math.min(dur - 0.25, services.engine.currentFileTime() + delta));
      void services.engine.seek(target);
    },
    [services]
  );

  const toggleFullscreen = useCallback(() => {
    void moviraApi.isFullscreen().then((fs) => moviraApi.setFullscreen(!fs));
  }, []);

  const changeVolumeBy = useCallback((delta: number) => {
    const el = videoRef.current;
    if (!el) return;
    applyVolume(el.volume + delta);
  }, [applyVolume]);

  const setVolumeLevel = useCallback((v: number) => applyVolume(v), [applyVolume]);

  const toggleMute = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    const next = !el.muted;
    el.muted = next;
    setMuted(next);
  }, []);

  useEffect(() => {
    if (!services) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      // A control that handled the key itself already cancelled it. Without
      // this the Timeline and the VolumeSlider BOTH react to an arrow key:
      // their React handlers stop propagation only inside React's own tree, so
      // the native event still reached this window listener and the volume (or
      // the playhead) was stepped twice per press.
      if (e.defaultPrevented) return;
      switch (e.key) {
        case ' ':
        case 'Spacebar':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowRight':
          e.preventDefault();
          // Ctrl+arrow steps through the PLAYLIST now that the bare arrows
          // (and the transport skip buttons) are pure in-time seeks on the
          // element that is already playing.
          if (e.ctrlKey) next();
          else seekBy(settings?.seekInterval ?? 10);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.ctrlKey) prev();
          else seekBy(-(settings?.seekInterval ?? 10));
          break;
        case 'ArrowUp':
          e.preventDefault();
          changeVolumeBy(0.05);
          break;
        case 'ArrowDown':
          e.preventDefault();
          changeVolumeBy(-0.05);
          break;
        case 'n':
        case 'N':
          next();
          break;
        case 'p':
        case 'P':
          prev();
          break;
        case 'b':
        case 'B':
          // VLC: B cycles the AUDIO track of the file being played.
          e.preventDefault();
          void cycleAudioTrack();
          break;
        case 'c':
        case 'C':
          // VLC: C adjusts crop; Movira cycles video zoom fit→fill→stretch.
          e.preventDefault();
          setZoomMode((z) => (z + 1) % 3);
          break;
        case 'v':
        case 'V':
          // VLC: V cycles the SUBTITLE track (off → loaded/sidecar track).
          e.preventDefault();
          void toggleSubtitlesV();
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'Escape':
          // ONE handler owns Escape. Floating panels close top-down first;
          // only when none are open does Escape leave fullscreen. Previously a
          // panel bound its own key listener too, so a single press closed a
          // panel AND dropped out of fullscreen at once.
          if (closeTopPanel()) break;
          void moviraApi.isFullscreen().then((fs) => {
            if (fs) moviraApi.setFullscreen(false);
          });
          break;
        case 's':
        case 'S':
          void services.player.toggleShuffle().then(() => setQueue(services.player.getQueue()));
          break;
        case 'r':
        case 'R':
          services.player.cycleRepeat();
          setQueue(services.player.getQueue());
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [services, togglePlay, next, prev, seekBy, settings?.seekInterval, toggleFullscreen, changeVolumeBy, toggleMute, cycleAudioTrack, toggleSubtitlesV]);

  useEffect(() => {
    moviraApi.onFullscreenChanged((fs) => setFullscreen(fs));
    void moviraApi.isFullscreen().then(setFullscreen);
  }, []);

  useEffect(() => {
    moviraApi.onMediaKey((action) => {
      if (action === 'playpause') togglePlay();
      else if (action === 'next') next();
      else if (action === 'prev') prev();
    });
  }, [togglePlay, next, prev]);

  const updateQueue = useCallback(() => {
    if (!services) return;
    setQueue(services.player.getQueue());
    setCurrent(services.player.getCurrent());
  }, [services]);

  const goHome = useCallback(() => setView('home'), []);

  /** Hide any open secondary window (the Now Playing player stays behind it).
   *  Home counts too: its ✕ / Escape returns to the player, which is the
   *  VLC behaviour for closing a floating window. */
  const closeSecondary = useCallback(() => setView('player'), []);

  // Which views are the floating secondary windows (everything except the
  // startup logo and Now Playing). Drives the click-fence backdrop.
  const sectionOpen = view === 'library' || view === 'playlists' || view === 'settings' || view === 'diagnostics';

  // Hooks must run unconditionally (React rules): this memo lives ABOVE the
  // early loading return below — a hook placed after it would change the hook
  // count between the loading render and the real one (React error #310).
  // The fullscreen portal overlay shares the same JSX as the main-area one so
  // both keep the click-outside + Escape behavior in either mode.
  const overlayPanels = useMemo(() => (
    <>
      {/* Fences clicks from the player underneath while a section is open, so
          an accidental click near a panel can never hit Play/Skip/Stop. It sits
          under the panel (z-index 35 vs 40) and starts below the top bar, so
          navigation stays reachable — the panel itself is not modal. */}
      {sectionOpen && <div className="section-backdrop" onClick={() => closeSecondary()} />}
      {services && view === 'library' && (
        <LibraryView
          services={services}
          onPlayItems={playItems}
          onError={handleError}
          onClose={closeSecondary}
        />
      )}
      {services && view === 'playlists' && <PlaylistsView services={services} onPlayItems={playItems} onClose={closeSecondary} />}
      {services && view === 'settings' && <SettingsView services={services} onQuit={() => void moviraApi.quit()} onClose={closeSecondary} />}
      {view === 'diagnostics' && <DiagnosticsView onClose={closeSecondary} />}
    </>
  ), [services, view, playItems, handleError, closeSecondary, sectionOpen]);

  if (!services || !settings) {
    return <div className="loading-screen"><div className="spinner" /><span>Loading Movira…</span></div>;
  }

  // In fullscreen the player view renders in a browser-level portal, so it
  // escapes the windowed layout — full-viewport overlays would otherwise be
  // INVISIBLE behind the fullscreen element yet still swallow clicks.
  const overlayHost = fullscreen ? document.body : null;

  // Secondary windows float over fullscreen video too: the portal mounts at
  // <body> where the browser-rendered fullscreen element also lives, so the
  // backdrop is visible AND clickable in fullscreen (it would otherwise sit
  // behind the fullscreen video stage, invisible but still swallowing clicks).
  const overlayPortal = overlayHost ? createPortal(overlayPanels, overlayHost) : null;

  return (
    <div className="app app-with-topbar">
      <TopBar
        view={view}
        onNavigate={setView}
        current={current}
        playing={playing}
        onTogglePlay={togglePlay}
        onNext={next}
        onPrev={prev}
        onBrand={goHome}
        onOpenFolder={openFolderAsQueue}
        onOpenFile={openSingleFile}
        onOpenMultiple={openMultipleInQueue}
        onQuit={quitApp}
      />
      <main className="main">
        {/* VLC layout model: Now Playing is the PERMANENT background of the
            main area; every other screen (home, library, playlists, settings)
            floats above it as a window. Opening Settings/Playlist/Library must
            never swap the video away — it keeps playing underneath, exactly
            like VLC. Home floats too so it can sit above the player. */}
        <PlayerView
          services={services}
          current={current}
          playing={playing}
          progress={progress}
          queue={queue}
          subtitle={subtitle}
          volume={volume}
          muted={muted}
          fullscreen={fullscreen}
          zoomMode={zoomMode}
          videoHostRef={videoHostRef}
          onPlayItems={playItems}
          onNext={next}
          onPrev={prev}
          onSeekBy={seekBy}
          onTogglePlay={togglePlay}
          onQueueChange={updateQueue}
          onSubtitle={setSubtitleTrack}
          onToggleFullscreen={toggleFullscreen}
          onVolumeChange={changeVolumeBy}
          onSetVolume={setVolumeLevel}
          onToggleMute={toggleMute}
          onClose={goHome}
          startupMode={view === 'home'}
        />
        {view === 'home' && <HomeView onClose={closeSecondary} />}
        {/* Section panels render EXACTLY ONCE.
            In fullscreen they are portaled to <body> (overlayPanels above) so
            they are not trapped behind the fullscreen element. These copies must
            therefore be suppressed while fullscreen — rendering both mounted a
            second, invisible copy behind the video that was still live: its own
            capture listener saw every click inside the visible panel as an
            outside click and closed the panel immediately, and it pushed a
            duplicate entry onto the FloatingPanel stack so one Escape closed
            the wrong thing. */}
        {!fullscreen && sectionOpen && <div className="section-backdrop" onClick={() => closeSecondary()} />}
        {!fullscreen && view === 'library' && (
          <LibraryView
            services={services}
            onPlayItems={playItems}
            onError={handleError}
            onClose={closeSecondary}
          />
        )}
        {!fullscreen && view === 'playlists' && <PlaylistsView services={services} onPlayItems={playItems} onClose={closeSecondary} />}
        {!fullscreen && view === 'settings' && <SettingsView services={services} onQuit={() => void moviraApi.quit()} onClose={closeSecondary} />}
        {!fullscreen && view === 'diagnostics' && <DiagnosticsView onClose={closeSecondary} />}
      </main>
      {error && <div className="error-toast">{error}</div>}
      {overlayPortal}
    </div>
  );
}
