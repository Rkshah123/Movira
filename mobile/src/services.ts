import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  MediaPlayerService,
  PlaylistService,
  MediaLibraryService,
  SubtitleService,
  UserDataService,
  type PlayerEngine,
  type EngineEvents,
  type QueueState,
  type MediaItem,
} from '@shared';
import { audioExtensions, videoExtensions, fileExtension } from '@shared';
import { isVideoExtension } from './mediaExtensions';
import { storageKeys, type StorageAdapter } from '@shared/storage';
import type { LibraryFolder } from '@shared';
import { scanFolderRecursive, exists as fsExists, listDeviceStorages } from './devices';
import { settingsStore } from './settings';

export const asyncStorageAdapter: StorageAdapter = {
  async get(key) {
    const raw = await AsyncStorage.getItem(`movira:${key}`);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  async set(key, value) {
    await AsyncStorage.setItem(`movira:${key}`, JSON.stringify(value));
  },
  async delete(key) {
    await AsyncStorage.removeItem(`movira:${key}`);
  },
};

export type MediaKind = 'video' | 'audio';

/**
 * Hybrid playback architecture:
 *
 * - AUDIO  -> react-native-track-player (native MediaSession foreground service:
 *             background/lock-screen playback, notification + headset controls).
 * - VIDEO  -> react-native-video (ExoPlayer surface rendered inside the app UI).
 *
 * The engine exposes a single PlayerEngine to MediaPlayerService; which backend
 * is used depends solely on the current item's media kind.
 */
/** What the video backend should render, once it is known. */
export interface VideoSource {
  uri: string;
  title: string;
  artist: string;
}

/**
 * The shared engine events plus the mobile-only video-source notification.
 *
 * Extends rather than edits `EngineEvents`, which belongs to shared-core and is
 * compiled into the desktop app as well.
 *
 * This exists because the engine's source was plain module-local state: the
 * player read it during render, so a screen that mounted before the source was
 * ready saw `null` and nothing ever re-rendered it. Announcing the change is what
 * lets the player show the picture the first time it is asked for.
 */
export interface MobileEngineEvents extends EngineEvents {
  onVideoSource?: (source: VideoSource | null) => void;
}

export interface MobileEngine extends PlayerEngine {
  /** true while the current item is a video (VideoScreen should mount the surface) */
  isVideoActive(): boolean;
  /**
   * Hands the current file to the BACKGROUND AUDIO engine even though it is a
   * video, for the player's "Play as Audio" entry: the picture is dropped and
   * playback continues through the media session (notification / lock screen).
   */
  playAsAudio(item: MediaItem): Promise<void>;
  /** URI of the item the video backend should render */
  getVideoSource(): VideoSource | null;
  togglePlayPause(): Promise<void>;
  /** commands forwarded to the mounted Video component */
  video: {
    play(): void;
    pause(): void;
    seek(t: number): void;
    setRate(r: number): void;
    setVolume(v: number): void;
    setMuted(m: boolean): void;
  };
  /** events the mounted Video component feeds back into the engine */
  handlers: {
    onProgress(t: number, duration: number, buffered?: number): void;
    onEnd(): void;
    onError(message: string): void;
    onPlayingChange(playing: boolean): void;
  };
}

export function createMobileEngine(events: MobileEngineEvents): MobileEngine {
  let currentKind: MediaKind = 'audio';
  let videoSource: VideoSource | null = null;
  let lastAudioState: 'playing' | 'paused' = 'paused';

  const TrackPlayer = require('react-native-track-player').default;

  /**
   * Turns a stored media path into something the players can open.
   *
   * Library-scanned items carry a bare filesystem path (`/storage/emulated/0/…`)
   * while document-picker items carry a `content://` or `file://` URI. The audio
   * branch has always added the `file://` prefix; the video branch did not, so
   * ExoPlayer received a schemeless string, failed to prepare it, never fired
   * `onLoad`, and the screen sat black and paused forever with no error. Adding
   * the scheme here fixes that while leaving existing `file://` / `content://`
   * values untouched.
   */
  const toPlayableUri = (path: string): string => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
    return `file://${path}`;
  };

  const emitProgress = (t: number, d: number) => events.onProgress(t, d);

  /**
   * Records the video source and tells React about it.
   *
   * Both halves matter. `getVideoSource()` alone was not enough: the player read
   * it during render, and `load()` reaches this line only after an `await`, so a
   * screen that mounted in between saw `null` and — the source being plain
   * closure state — no state change ever brought the picture in. The player
   * showed "No video is loaded" until something else made it re-render, which is
   * exactly the tap-it-again behaviour. Announcing the change is what makes the
   * picture appear on the first tap.
   */
  const setVideoSource = (source: VideoSource | null) => {
    const before = videoSource?.uri;
    videoSource = source;
    if (before !== source?.uri) events.onVideoSource?.(source);
  };

  const videoCmd = {
    play: () => {},
    pause: () => {},
    seek: (_t: number) => {},
    setRate: (_r: number) => {},
    setVolume: (_v: number) => {},
    setMuted: (_m: boolean) => {},
  };

  return {
    isVideoActive: () => currentKind === 'video',
    getVideoSource: () => (currentKind === 'video' ? videoSource : null),
    video: videoCmd,
    handlers: {
      onProgress: emitProgress,
      onEnd: () => events.onEnded(),
      onError: (m) => events.onError(m),
      onPlayingChange: (p) => {
        lastAudioState = p ? 'playing' : 'paused';
        events.onPlayingChange(p);
      },
    },

    async load(item, autoplay = true) {
      if (item.type === 'video') {
        // Stop the audio service so it releases the media session/notification.
        try {
          await TrackPlayer.reset();
        } catch {
          // service may not be bound yet
        }
        currentKind = 'video';
        setVideoSource({
          uri: toPlayableUri(item.path),
          title: item.title,
          artist: item.artist ?? 'Movira',
        });
        // Surface mounts via React; playback starts when the surface reports ready.
        events.onPlayingChange(false);
        return;
      }
      // Audio path: hand over to the native service.
      currentKind = 'audio';
      setVideoSource(null);
      await TrackPlayer.reset();
      await TrackPlayer.add({
        id: item.id,
        url: toPlayableUri(item.path),
        title: item.title,
        artist: item.artist ?? 'Movira',
        album: item.album ?? 'Movira Library',
        artwork: item.artwork,
        duration: item.duration,
      });
      // `autoplay === false` is how a restored queue reloads silently: the
      // track is queued up ready, but nothing starts until the user taps it.
      if (autoplay) void TrackPlayer.play();
    },

    async playAsAudio(item: MediaItem) {
      // Same as the audio branch above, regardless of the item's real type.
      currentKind = 'audio';
      setVideoSource(null);
      await TrackPlayer.reset();
      await TrackPlayer.add({
        id: item.id,
        url: toPlayableUri(item.path),
        title: item.title,
        artist: item.artist ?? 'Movira',
        album: item.album ?? 'Movira Library',
        artwork: item.artwork,
        duration: item.duration,
      });
      void TrackPlayer.play();
    },

    async play() {
      if (currentKind === 'video') videoCmd.play();
      else await TrackPlayer.play();
    },

    async pause() {
      if (currentKind === 'video') videoCmd.pause();
      else await TrackPlayer.pause();
    },

    async stop() {
      if (currentKind === 'video') videoCmd.pause();
      else await TrackPlayer.stop();
    },

    async seek(t) {
      if (currentKind === 'video') videoCmd.seek(t);
      else await TrackPlayer.seekTo(t);
    },

    async setVolume(v) {
      // ExoPlayer volume applies to the video surface; audio service is system-routed.
      videoCmd.setVolume(v);
    },

    async setRate(r) {
      videoCmd.setRate(r);
      try {
        await TrackPlayer.setRate(r);
      } catch {
        // ignore when service not bound
      }
    },

    setRepeat() {},
    setShuffle() {},

    async setSubtitles() {},
    async setAudioTrack() {},
    async getAudioTracks() {
      return [];
    },

    async togglePlayPause() {
      if (currentKind === 'video') {
        videoCmd.play();
        return;
      }
      const state = await TrackPlayer.getState();
      if (state === 3) await TrackPlayer.pause();
      else await TrackPlayer.play();
    },
  };
}

export interface MobileServices {
  player: MediaPlayerService;
  playlists: PlaylistService;
  library: MediaLibraryService;
  subtitles: SubtitleService;
  userData: UserDataService;
  engine: MobileEngine;
}

export async function createMobileServices(events: MobileEngineEvents): Promise<MobileServices> {
  const storage = asyncStorageAdapter;
  const engine = createMobileEngine(events);
  const player = new MediaPlayerService(engine, events, (state: QueueState) => {
    void storage.set(storageKeys.queue, state);
  });
  const playlists = new PlaylistService(storage);
  const library = new MediaLibraryService(storage, {
    // The shared library rebuilds its list from the folders it is given, so this
    // adapter is what actually reaches the device filesystem.
    async listMediaFiles(folder: string) {
      const files = await scanFolderRecursive(folder);
      return files.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime }));
    },
    async exists(path: string) {
      try {
        return await fsExists(path);
      } catch {
        return false;
      }
    },
  });
  const subtitles = new SubtitleService();
  const userData = new UserDataService(storage);

  // Seed the library folders BEFORE `library.init()`.
  //
  // `MediaLibraryService.addFolder` always triggers a full rescan, so adding the
  // device roots from the UI would walk the whole filesystem once per storage
  // before the first render. Seeding the stored folders instead means the single
  // rescan the UI already requests is the only walk that happens.
  try {
    const stored = (await storage.get(storageKeys.libraryFolders)) as LibraryFolder[] | null;
    if (!Array.isArray(stored) || stored.length === 0) {
      const roots = await listDeviceStorages();
      if (roots.length) {
        await storage.set(
          storageKeys.libraryFolders,
          roots.map<LibraryFolder>((r) => ({
            id: r.id,
            path: r.path,
            label: r.label,
            type: 'mixed',
          }))
        );
      }
    }
  } catch (e) {
    console.warn('Movira: could not seed library folders', e);
  }

  await Promise.all([playlists.init(), library.init(), userData.init()]);

  // Restoring the last session's queue puts that file back on screen, which
  // reads as "the app opened my file by itself". Only reload it when the user
  // has explicitly asked Movira to continue where they left off (Interface →
  // Continue playback), and even then load it paused: tapping the item is what
  // starts playback. The flag is a dedicated key with a `false` default — the
  // old `continuePlayback` flag leaked `true` into stored settings, so it can
  // no longer be trusted to mean "the user chose this".
  const savedQueue = (await storage.get(storageKeys.queue)) as QueueState | null;
  if (settingsStore.get().resumeOnLaunch && savedQueue?.items?.length) {
    player.setQueue(savedQueue.items, savedQueue.index, false);
  }

  return { player, playlists, library, subtitles, userData, engine };
}

export function itemFromDocumentPicker(file: {
  uri: string;
  name?: string;
  type?: string;
  /** MIME resolved from the content:// URI via ContentResolver.getType(). */
  mime?: string;
  size?: number;
  /**
   * MIME filter the picker was opened with (`audio/*` / `video/*`). Android
   * frequently hands back extension-less MediaStore URIs where neither the
   * name nor its extension says what the file is — without this the pick is
   * silently dropped, which is exactly what used to happen.
   */
  fallbackType?: 'audio' | 'video';
}): MediaItem | null {
  const uri = file.uri ?? '';
  if (!uri) return null;
  // The last URI segment can carry a query string (`?…`) that must never leak
  // into the visible label.
  const lastSegment = decodeURIComponent(uri.split(/[?#]/)[0].split('/').pop() ?? '');
  const name = (file.name ?? lastSegment).trim() || 'media';
  const ext = fileExtension(name);
  const mime = file.mime ?? file.type;
  // Same full lists as desktop (spec §1/§3) — the picker passes everything the
  // user selects; actual decodability is Android codec-dependent and surfaces as
  // a graceful error, never a crash.
  const isAudio =
    mime?.startsWith('audio/') ||
    audioExtensions.includes(ext) ||
    file.type === 'audio/x';
  const isVideo =
    mime?.startsWith('video/') ||
    videoExtensions.includes(ext) ||
    isVideoExtension(ext) ||
    file.type === 'video/x';
  const type = isAudio ? 'audio' : isVideo ? 'video' : file.fallbackType ?? null;
  if (!type) return null;
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    title: name.replace(/\.[^.]+$/, ''),
    path: uri,
    size: file.size,
    addedAt: Date.now(),
  };
}

export const isVideo = (item: MediaItem) => item.type === 'video';
