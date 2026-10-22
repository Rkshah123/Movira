import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StatusBar, Image, BackHandler, useWindowDimensions } from 'react-native';
import TrackPlayer, {
  Capability,
  Event,
  State,
  useProgress,
  AppKilledPlaybackBehavior,
} from 'react-native-track-player';
import type { MediaItem } from '@shared';
import { PlaybackService } from './PlaybackService';
import { setPlaybackBridge } from './bridge';
import { createMobileServices, type MobileServices, type VideoSource } from './services';
import { requestMediaAccess, type MediaAccess } from './permissions';
import CrashGuard from './CrashGuard';
import { ThemeProvider, useTheme, type MobileThemeMode } from './theme';
import { settingsStore } from './settings';
import { AppStateProvider, useAppState } from './state/AppContext';
import { NavProvider, useNav, type Route } from './state/NavContext';
import { useExternalMediaOpen } from './openWith';

import { useStatusBarInset } from './ui/TopBar';
import BottomNav from './ui/BottomNav';
import Icon from './ui/Icon';
import VideoScreen from './screens/VideoScreen';
import AudioScreen from './screens/AudioScreen';
import BrowseScreen from './screens/BrowseScreen';
import PlaylistsScreen from './screens/PlaylistsScreen';
import MoreScreen from './screens/MoreScreen';
import SettingsScreen from './screens/SettingsScreen';
import SettingsPages from './screens/SettingsPages';
import AboutScreen from './screens/AboutScreen';
import { AuthorsScreen } from './screens/AboutScreen';
import SearchScreen from './screens/SearchScreen';
import FolderBrowserScreen, { CollectionScreen } from './screens/FolderBrowserScreen';
import PlaylistDetailScreen, { EqualizerScreen } from './screens/PlaylistDetailScreen';
import AudioPlayerScreen from './screens/AudioPlayerScreen';
import VideoPlayerScreen from './screens/VideoPlayerScreen';
import VersionScreen from './screens/VersionScreen';

/**
 * `TrackPlayer.setupPlayer` is a race on a cold launch.
 *
 * The native side refuses to start its playback service unless the process is
 * already resumed; `ProcessLifecycleOwner` defers ON_RESUME by a few hundred ms
 * to debounce configuration changes, so a setup attempt made at startup can be
 * rejected with `android_cannot_setup_player_in_background`. Swallowing that
 * used to leave a permanently dead player, so it is retried for a bounded
 * window instead.
 */
const SETUP_ATTEMPTS = 15;
const SETUP_RETRY_MS = 100;

async function setupPlayerWithRetry(): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < SETUP_ATTEMPTS; attempt += 1) {
    try {
      await TrackPlayer.setupPlayer({ autoHandleInterruptions: true });
      return;
    } catch (e) {
      lastError = e;
      const code = (e as { code?: string } | null)?.code;
      if (code === 'player_already_initialized') return;
      if (attempt < SETUP_ATTEMPTS - 1) {
        await new Promise<void>((resolve) => setTimeout(() => resolve(), SETUP_RETRY_MS));
      }
    }
  }
  throw lastError ?? new Error('TrackPlayer.setupPlayer failed');
}

const LOGO = require('./assets/movira_logo.png');

export default function App() {
  const [services, setServices] = useState<MobileServices | null>(null);
  const [access, setAccess] = useState<MediaAccess | null>(null);
  // The engine reports play/pause state from below the provider; this lets the
  // context hear about it so the mini-player button never disagrees with the
  // audio actually coming out of the speaker.
  const enginePlayingRef = useRef<(p: boolean) => void>(() => {});
  const [current, setCurrent] = useState<MediaItem | null>(null);
  const [playing, setPlaying] = useState(false);
  // Held in state rather than read straight off the engine so that the player
  // re-renders the moment a video source becomes available — see
  // `MobileEngineEvents.onVideoSource`.
  const [videoSource, setVideoSource] = useState<VideoSource | null>(null);
  const [progress, setProgress] = useState({ time: 0, duration: 0 });
  const [themeMode, setThemeMode] = useState<MobileThemeMode>('system');
  const engineProgress = useProgress();
  const handleEndedRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let disposed = false;
    const setup = async () => {
      try {
        await setupPlayerWithRetry();
      } catch (e) {
        console.error('Movira: TrackPlayer setup failed; playback is unavailable', e);
      }
      try {
        await TrackPlayer.updateOptions({
          capabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext, Capability.SkipToPrevious, Capability.SeekTo, Capability.Stop],
          compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext, Capability.SkipToPrevious],
          notificationCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext, Capability.SkipToPrevious, Capability.Stop],
          android: { appKilledPlaybackBehavior: AppKilledPlaybackBehavior.ContinuePlayback },
        });
      } catch (e) {
        console.warn('Movira: TrackPlayer options failed', e);
      }
      try {
        await PlaybackService();
      } catch (e) {
        console.warn('Movira: PlaybackService failed', e);
      }

      const access = await requestMediaAccess();
      if (!disposed) setAccess(access);

      // The queue restore inside createMobileServices reads user preferences,
      // so the stored settings must be in before the services are built.
      await settingsStore.load();

      const engine = await createMobileServices({
        onProgress: () => {},
        // Wired through the holder below: `createMobileServices` needs the
        // callbacks up front, but the video surface reports "ended" after it
        // exists and the queue must advance from there.
        onEnded: () => handleEndedRef.current?.(),
        onError: (m: string) => console.warn('Movira playback error:', m),
        onVideoSource: (s) => setVideoSource(s),
        onPlayingChange: (p: boolean) => {
          setPlaying(p);
          enginePlayingRef.current(p);
        },
      });

      if (disposed) return;
      setServices(engine);
      setCurrent(engine.player.getCurrent());
      handleEndedRef.current = () => engine.player.handleEnded();

      setPlaybackBridge({
        remotePlay: async () => {
          await engine.engine.play();
          setPlaying(true);
        },
        remotePause: async () => {
          await engine.engine.pause();
          setPlaying(false);
        },
        remoteNext: async () => {
          await engine.player.next();
          setCurrent(engine.player.getCurrent());
        },
        remotePrev: async () => {
          await engine.player.previous();
          setCurrent(engine.player.getCurrent());
        },
        remoteSeek: async (t) => {
          await engine.engine.seek(t);
        },
        remoteQueueEnded: async () => {
          engine.player.handleEnded();
        },
      });

      try {
        TrackPlayer.addEventListener(Event.PlaybackState, (e) => {
          setPlaying(e.state === State.Playing);
        });
      } catch (e) {
        console.warn('Movira: playback state subscription failed', e);
      }
    };
    void setup();
    return () => {
      disposed = true;
      setPlaybackBridge(null);
    };
  }, []);

  const onCurrentChange = useCallback((item: MediaItem | null) => {
    setCurrent(item);
  }, []);

  const onPlayingChange = useCallback((p: boolean) => setPlaying(p), []);

  // Audio progress arrives from the TrackPlayer hook; video progress is pushed
  // by the player screen. Track whichever source is currently driving playback.
  const lastVideoPush = useRef(0);
  const onProgress = useCallback(
    (time: number, duration: number) => {
      lastVideoPush.current = Date.now();
      setProgress({ time, duration });
    },
    []
  );

  useEffect(() => {
    if (!playing) return;
    // Only follow the audio engine when the video surface is not the active one.
    const t = setInterval(() => {
      if (Date.now() - lastVideoPush.current < 2500) return;
      setProgress({ time: engineProgress.position, duration: engineProgress.duration });
    }, 500);
    return () => clearInterval(t);
  }, [playing, engineProgress.position, engineProgress.duration]);

  useEffect(() => {
    void settingsStore.load();
  }, []);

  // The theme has to be subscribed to here: AppStateProvider lives below
  // ThemeProvider, so a preference changed inside the tree would never reach it.
  useEffect(() => settingsStore.subscribe((s) => setThemeMode(s.theme)), []);

  const onModeChange = useCallback((mode: MobileThemeMode) => {
    void settingsStore.set('theme', mode);
  }, []);

  if (!services) {
    return (
      <ThemeProvider mode={themeMode} onModeChange={onModeChange}>
        <BootScreen />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider mode={themeMode} onModeChange={onModeChange}>
      <AppStateProvider
        services={services}
        onCurrentChange={onCurrentChange}
        onPlayingChange={onPlayingChange}
        onProgress={onProgress}
        videoSource={videoSource}
        registerEnginePlaying={(fn) => {
          enginePlayingRef.current = fn;
        }}
        engineProgress={engineProgress}
      >
        <NavProvider>
          <CrashGuard>
            <Shell progress={progress} access={access} />
          </CrashGuard>
        </NavProvider>
      </AppStateProvider>
    </ThemeProvider>
  );
}

function BootScreen() {
  const t = useTheme();
  return (
    <View style={[styles.boot, { backgroundColor: t.bg }]}>
      <StatusBar barStyle={t.dark ? 'light-content' : 'dark-content'} backgroundColor={t.bg} />
      <Image source={LOGO} style={styles.bootLogo} resizeMode="contain" />
      <Text style={[styles.bootText, { color: t.dim }]}>Loading…</Text>
    </View>
  );
}

/** Root layout: status bar, the routed screen, mini player and bottom navigation. */
function Shell({ progress, access }: { progress: { time: number; duration: number }; access: MediaAccess | null }) {
  const t = useTheme();
  const nav = useNav();
  const app = useAppState();
  const { height } = useWindowDimensions();

  const bottomInset = Math.max(0, Math.min(28, height * 0.02));

  const subPage = nav.route.name !== 'shell';

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => nav.handleBack());
    return () => sub.remove();
  }, [nav]);

  // Video can be started from anywhere that lists media (the video tab, the
  // folder browser, search, a playlist). The engine only begins a video once the
  // mounted <Video> surface reports ready, so the player has to be on screen.
  // Centralised here so every entry point behaves the same.
  //
  // The trigger is "the user asked for this video", not just "the current item is
  // a video" and not just "the current item changed".
  //
  // Keying on "is a video current" alone makes Back re-push the player and trap
  // the user. Keying on the item transition alone is not enough either:
  // re-tapping the video that is already loaded changes nothing, and that still
  // has to open the player.
  //
  // `playRequest` is what settles both. It counts explicit play() calls, so a
  // queue restored at launch (Interface → Resume playback) leaves it at zero and
  // cannot hijack the home screen, while every tap advances it — including a tap
  // on the video already playing.
  const isVideo = app.current?.type === 'video';
  const currentId = app.current?.id ?? null;
  const playRequest = app.playRequest;
  const lastId = useRef<string | null>(null);
  const lastWasVideo = useRef(false);
  const lastPlayRequest = useRef(0);
  useEffect(() => {
    const previousId = lastId.current;
    const changed =
      currentId !== previousId ||
      isVideo !== lastWasVideo.current ||
      playRequest !== lastPlayRequest.current;
    lastId.current = currentId;
    lastWasVideo.current = isVideo;
    lastPlayRequest.current = playRequest;
    // Only an explicit play request may open the player. A restored queue
    // populates `current` a moment after launch with no request behind it, and
    // that must not take over the home screen.
    if (changed && isVideo && playRequest > 0 && nav.route.name !== 'nowPlaying') {
      nav.push({ name: 'nowPlaying' });
    }
  }, [currentId, isVideo, playRequest, nav]);

  /*
   * A file opened from another app ("Open with" → Movira).
   *
   * The library is passed as a ref rather than as a dependency: a rescan hands
   * out a new array constantly, and re-running the hand-off on every scan would
   * re-read the launch intent each time.
   */
  const libraryRef = useRef(app.media);
  libraryRef.current = app.media;

  const onExternalOpen = useCallback(
    (item: MediaItem) => {
      app.play([item], 0);
      // Reset to the shell first so opening a file from the player itself does
      // not stack a second player route on top of the one already showing.
      //
      // Navigating explicitly is what makes this behave like every other entry
      // point: the effect above only reacts to VIDEOS and deliberately ignores
      // the first item of a session, so neither audio nor a cold start would
      // ever reach the player on their own.
      nav.popToShell();
      nav.push({ name: 'nowPlaying' });
    },
    [app, nav]
  );

  useExternalMediaOpen({
    ready: true,
    scanned: app.scanned,
    libraryRef,
    onOpen: onExternalOpen,
  });

  const screen = nav.route.name === 'shell' ? <TabShell /> : renderRoute(nav.route);

  // The video surface owns the whole screen; a bottom bar over it would cover
  // the picture and steal taps from the controls.
  const immersive = nav.route.name === 'nowPlaying' && app.current?.type === 'video';

  // Hook must run unconditionally at the top level of the component — never
  // inside a JSX branch, or React sees a different hook count when the player
  // opens or closes.
  const topInset = useStatusBarInset();

  return (
    <View style={[styles.shell, { backgroundColor: t.bg }]}>
      <StatusBar barStyle={t.dark ? 'light-content' : 'dark-content'} backgroundColor={t.bg1} />
      {/*
       * Android draws edge-to-edge, so the system status bar (clock, Wi-Fi,
       * battery, …) sits on top of the window. Offset every non-fullscreen
       * screen by that height so the header, logo, search icon, buttons and
       * list content always begin below it and never cover the system UI.
       *
       * The player surface is intentionally full-bleed/immersive, so it keeps
       * drawing to the top of the screen.
       */}
      {/*
       * The player surface is intentionally full-bleed/immersive, so it keeps
       * drawing to the top of the screen — hence no top inset for it. But the
       * CONTENT ITSELF MUST STILL RENDER: gating this whole block on
       * `!immersive` rendered nothing at all for a video on the Now Playing
       * route, which left a black screen with no picture, no controls, and no
       * ExoPlayer surface to prepare the file. Only the inset is conditional.
       */}
      <View style={[styles.content, immersive ? null : { paddingTop: topInset }]}>
        {!subPage && access && !access.media ? <AccessBanner /> : null}
        {screen}
      </View>

      {immersive ? null : (
        <>
          {!subPage && app.current ? <MiniPlayer progress={progress} /> : null}
          {!subPage ? <BottomNav active={nav.tab} onChange={nav.setTab} bottomInset={bottomInset} /> : null}
        </>
      )}
    </View>
  );
}

function renderRoute(route: Route): React.ReactNode {
  switch (route.name) {
    case 'shell':
      return null; // resolved by the caller
    case 'search':
      return <SearchScreen kind={route.kind ?? 'all'} />;
    case 'playlist':
      return <PlaylistDetailScreen id={route.id} />;
    case 'settings':
      return <SettingsScreen />;
    case 'settingsPage':
      return <SettingsPages page={route.page} />;
    case 'about':
      return <AboutScreen />;
    case 'authors':
      return <AuthorsRoute />;
    case 'folder':
      return <FolderBrowserScreen path={route.path} title={route.title} selectMode={route.selectMode} />;
    case 'collection':
      return <CollectionScreen kind={route.kind} title={route.title} />;
    case 'equalizer':
      return <EqualizerScreen />;
    case 'version':
      return <VersionScreen />;
    case 'nowPlaying':
      return <NowPlayingSwitch />;
    default:
      return null;
  }
}

/** The video surface replaces the shell entirely while a video is loaded. */
function NowPlayingSwitch() {
  const app = useAppState();
  return app.current?.type === 'video' ? <VideoPlayerScreen /> : <AudioPlayerScreen />;
}

/** The Authors page reached from the router (a route in its own right). */
function AuthorsRoute() {
  const nav = useNav();
  return <AuthorsScreen onClose={() => nav.pop()} />;
}

function MiniPlayer({ progress }: { progress: { time: number; duration: number } }) {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();
  if (!app.current) return null;
  const pct = progress.duration > 0 ? Math.min(1, progress.time / progress.duration) : 0;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`Now playing: ${app.current.title}`}
      style={[styles.mini, { backgroundColor: t.bg1, borderTopColor: t.border }]}
      onPress={() => nav.push({ name: 'nowPlaying' })}
    >
      <View style={styles.miniBody}>
        <Icon name={app.current.type === 'video' ? 'video' : 'audio'} size={20} color={t.dim} />
        <View style={styles.miniText}>
          <Text style={[styles.miniTitle, { color: t.text }]} numberOfLines={1}>
            {app.current.title}
          </Text>
          <Text style={[styles.miniSub, { color: t.dim }]} numberOfLines={1}>
            {app.current.artist ?? (app.current.type === 'video' ? 'Video' : 'Audio')}
          </Text>
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={app.playing ? 'Pause' : 'Play'}
          hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
          onPress={app.togglePlayPause}
        >
          <Icon name={app.playing ? 'pause' : 'play'} size={20} color={t.accent} />
        </TouchableOpacity>
      </View>
      <View style={[styles.miniTrack, { backgroundColor: t.border }]}>
        <View style={[styles.miniFill, { backgroundColor: t.accent, width: `${pct * 100}%` }]} />
      </View>
    </TouchableOpacity>
  );
}

/** Screen switch for the five-tab shell. */
function TabShell() {
  const nav = useNav();
  switch (nav.tab) {
    case 'video':
      return <VideoScreen />;
    case 'audio':
      return <AudioScreen />;
    case 'browse':
      return <BrowseScreen />;
    case 'playlists':
      return <PlaylistsScreen />;
    default:
      return <MoreScreen />;
  }
}

/**
 * Shown only when the user has not granted media access. Without it the library
 * scans fine but returns nothing, which otherwise looks like a broken app.
 */
function AccessBanner() {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  return (
    <View style={[styles.access, { backgroundColor: t.bg2, borderColor: t.border }]}>
      <Text style={[styles.accessText, { color: t.text }]} numberOfLines={2}>
        Movira needs access to your media files to build the library.
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Grant media access"
        disabled={busy}
        style={[styles.accessBtn, { borderColor: t.accent }]}
        onPress={async () => {
          setBusy(true);
          try {
            await requestMediaAccess();
          } finally {
            setBusy(false);
          }
        }}
      >
        <Text style={[styles.accessBtnText, { color: t.accent }]}>
          {busy ? 'Opening…' : 'Grant access'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  access: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  accessText: { flex: 1, fontSize: 12.5 },
  accessBtn: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  accessBtnText: { fontSize: 12.5, fontWeight: '600' },
  shell: { flex: 1 },
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  bootLogo: { width: 110, height: 110, opacity: 0.9 },
  bootText: { fontSize: 14 },
  mini: { borderTopWidth: StyleSheet.hairlineWidth },
  miniBody: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 9 },
  miniText: { flex: 1, minWidth: 0 },
  miniTitle: { fontSize: 14 },
  miniSub: { fontSize: 12, marginTop: 2 },
  miniTrack: { height: 2, width: '100%' },
  miniFill: { height: 2 },
  content: { flex: 1 },
});