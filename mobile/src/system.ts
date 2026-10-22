import { NativeEventEmitter, NativeModules } from 'react-native';

/**
 * Device-level controls the video player needs that React Native does not
 * expose. Backed by MoviraSystemModule (Kotlin) — see
 * android/app/src/main/java/com/movira/player/MoviraSystemModule.kt.
 *
 * Every value is a 0..1 fraction. Nothing here swallows a failure: if the
 * native module is missing the caller gets a real error so the player can show
 * it instead of pretending the gesture worked.
 */

/** Device event name for a media file opened from another app. */
const OPEN_MEDIA_EVENT = 'moviraOpenMedia';

/** Device event name for the handset's physical orientation changing. */
const DEVICE_ORIENTATION_EVENT = 'moviraDeviceOrientation';

/**
 * The three window orientations the player can ask for.
 *
 * `landscape` and `reverseLandscape` are the two OPPOSITE landscape directions.
 * They have to be distinct values: Android implements them as two different
 * `SCREEN_ORIENTATION_*` constants 180 degrees apart, and asking for the same
 * one twice leaves the video the wrong way up when the phone is turned to the
 * other side.
 */
export type OrientationMode = 'auto' | 'portrait' | 'landscape' | 'reverseLandscape';

/** A physical device orientation reported by the sensor watcher. */
export type DeviceOrientation = 'portrait' | 'landscape' | 'reverseLandscape';

/** What a `content://` URI actually points at, as reported by Android. */
export interface ContentUriInfo {
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
  /** Real filesystem location behind the URI, when the provider exposes one. */
  path?: string | null;
}

/** A media file handed to Movira by another app through an ACTION_VIEW intent. */
export interface ExternalMedia {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
  path?: string | null;
}

interface MoviraSystemNative {
  /** Required by NativeEventEmitter; the module implements both as no-ops. */
  addListener(eventName: string): void;
  removeListeners(count: number): void;
  setViewBlur(tag: number, radius: number): Promise<boolean>;
  startDeviceOrientationWatch(): void;
  stopDeviceOrientationWatch(): void;
  canDecodeMime(mime: string): Promise<boolean>;
  probeVideoMime(uri: string): Promise<string | null>;
  probeAudioMimes(uri: string): Promise<string[] | null>;
  hasAllFilesAccess(): Promise<boolean>;
  openAllFilesAccessSettings(): Promise<boolean>;
  getVolume(): Promise<number>;
  resolveContentUri(uri: string): Promise<ContentUriInfo | null>;
  consumeLaunchMedia(): Promise<ExternalMedia | null>;
  takePersistableMediaAccess(uri: string): Promise<boolean>;
  deleteContentUri(uri: string): Promise<boolean>;
  requestDeleteMedia(paths: string[]): Promise<boolean>;
  setVolume(value: number): Promise<number>;
  isMuted(): Promise<boolean>;
  getBrightness(): Promise<number | null>;
  setBrightness(value: number): Promise<number>;
  resetBrightness(): Promise<void>;
  setOrientation(mode: string): Promise<string>;
  setKeepScreenOn(enabled: boolean): Promise<boolean>;
  setImmersive(enabled: boolean): Promise<boolean>;
  setAutoRotate(enabled: boolean): Promise<boolean>;
  getAutoRotate(): Promise<boolean>;
  getStatusBarHeight(): Promise<number>;
  openInBrowser(url: string): Promise<boolean>;
  enterPictureInPicture(): Promise<boolean>;
  log(message: string): void;
}

const native = NativeModules.MoviraSystem as MoviraSystemNative | undefined;

export const hasSystemControls = native != null;

function required(): MoviraSystemNative {
  if (!native) {
    throw new Error('MoviraSystem native module is not linked into this build');
  }
  return native;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export async function getVolume(): Promise<number> {
  return clamp01(await required().getVolume());
}

/** Returns the level the system actually applied, which may be quantised. */
export async function setVolume(value: number): Promise<number> {
  return clamp01(await required().setVolume(clamp01(value)));
}

export async function isMuted(): Promise<boolean> {
  return required().isMuted();
}

export async function getBrightness(): Promise<number | null> {
  const v = await required().getBrightness();
  return v == null ? null : clamp01(v);
}

export async function setBrightness(value: number): Promise<number> {
  return clamp01(await required().setBrightness(clamp01(value)));
}

/** Hands brightness back to the system setting when the player unmounts. */
export async function resetBrightness(): Promise<void> {
  await required().resetBrightness();
}

export async function setAutoRotate(enabled: boolean): Promise<boolean> {
  return required().setAutoRotate(enabled);
}

/**
 * Drives the activity orientation from the player. The activity handles the
 * orientation config change itself, so the video keeps playing across the
 * rotation instead of being torn down and reloaded.
 */
export async function setOrientation(mode: OrientationMode): Promise<OrientationMode> {
  return (await required().setOrientation(mode)) as OrientationMode;
}

/** The single screen on/off control; keeps the display awake while enabled. */
export async function setKeepScreenOn(enabled: boolean): Promise<boolean> {
  return required().setKeepScreenOn(enabled);
}

/** Real fullscreen: hides both the status bar and the navigation bar. */
export async function setImmersive(enabled: boolean): Promise<boolean> {
  return required().setImmersive(enabled);
}

export async function getAutoRotate(): Promise<boolean> {
  return required().getAutoRotate();
}

/**
 * Real status-bar height in platform pixels. Used everywhere a top inset is
 * needed (app bar, content padding) so the header, logo, search and menu
 * icons never sit under the system clock / Wi-Fi / battery.
 *
 * React Native's `StatusBar.currentHeight` can report 0 on some Android
 * configurations (opaque status-bar colour with no window inset), so we read
 * it from the system resource instead.
 */
export async function getStatusBarHeight(): Promise<number> {
  return Math.max(0, await required().getStatusBarHeight());
}

/**
 * Display name, MIME type and size behind a `content://` URI, or null when the
 * module cannot answer (file:// URIs, missing module, provider refusing the
 * query).
 *
 * The document picker returns bare URIs whose last segment is often an
 * extension-less MediaStore id (`content://media/external/audio/media/42`),
 * so this is what lets a picked file keep its real name and land in the right
 * panel instead of being silently dropped.
 */
export async function resolveContentUri(uri: string): Promise<ContentUriInfo | null> {
  if (!native?.resolveContentUri) return null;
  try {
    return await native.resolveContentUri(uri);
  } catch {
    return null;
  }
}

/**
 * The media file behind the intent that launched the activity, consumed on read.
 *
 * Resolves null when Movira was started normally from its launcher icon. The
 * native side clears the launch intent as it reads it, so this returns the file
 * exactly once — a JS reload or an activity recreation cannot resurrect it.
 */
export async function consumeLaunchMedia(): Promise<ExternalMedia | null> {
  if (!native?.consumeLaunchMedia) return null;
  try {
    return await native.consumeLaunchMedia();
  } catch {
    return null;
  }
}

/**
 * Whether the device has a decoder for a MIME type.
 *
 * Consulted BEFORE telling the user a file cannot be decoded, so that claim is
 * only ever made when the platform codec list actually agrees with it.
 */
export async function canDecodeMime(mime: string | null | undefined): Promise<boolean> {
  if (!native?.canDecodeMime || !mime) return false;
  try {
    return await native.canDecodeMime(mime);
  } catch {
    return false;
  }
}

/**
 * The MIME type of a file's first video track — the codec that is actually inside
 * it — or null when the file cannot be read.
 *
 * MediaExtractor parses the container, so this is the only reliable way to tell a
 * `.ts` holding MPEG-2 from the same container holding H.264. The extension and
 * MediaStore's MIME describe the container, not the codec, and on a device with
 * no MPEG-2 decoder that difference is the difference between a picture and a
 * silent black screen.
 */
export async function probeVideoMime(uri: string): Promise<string | null> {
  if (!native?.probeVideoMime || !uri) return null;
  try {
    return await native.probeVideoMime(uri);
  } catch {
    return null;
  }
}

/**
 * The MIME type of every audio track in the file, in container order — or null
 * when the file cannot be read at all.
 *
 * FALLBACK: the platform extractor HIDES audio tracks whose codec this device * cannot decode (AC-3 and E-AC-3 tracks vanish entirely on a phone with no * decoder for them), so callers read ExoPlayer's `onLoad` audioTracks first and * only reach for this when that list is empty.
 *
 * This is what tells "silent because every audio codec here is undecodable" * apart from "silent for some other reason". A device with no AC-3 / E-AC-3 / DTS * decoder plays such a file's video perfectly and drops the audio with no error * and no callback, so without this the player looks broken while doing exactly * what the platform told it to. ExoPlayer auto-selects a decodable track when * one exists, so only a list where NOTHING is decodable is worth explaining.
 */
export async function probeAudioMimes(uri: string): Promise<string[] | null> {
  if (!native?.probeAudioMimes || !uri) return null;
  try {
    const mimes = await native.probeAudioMimes(uri);
    return Array.isArray(mimes) ? (mimes.filter((m): m is string => typeof m === 'string')) : null;
  } catch {
    return null;
  }
}

/**
 * True when the app holds "All files access".
 *
 * Without it Android's scoped storage refuses a direct read of any file the
 * media store has never indexed, and there is no `content://` URI to fall back to
 * for those either — so this is the only thing that makes such a file playable.
 */
export async function hasAllFilesAccess(): Promise<boolean> {
  if (!native?.hasAllFilesAccess) return false;
  try {
    return await native.hasAllFilesAccess();
  } catch {
    return false;
  }
}

/** Opens the system screen where "All files access" is granted. */
export async function openAllFilesAccessSettings(): Promise<boolean> {
  if (!native?.openAllFilesAccessSettings) return false;
  try {
    return await native.openAllFilesAccessSettings();
  } catch {
    return false;
  }
}

/**
 * Subscribes to the handset's PHYSICAL orientation as it is turned.
 *
 * React Native cannot be used for this. Once the activity is pinned to an
 * orientation (`requestedOrientation = LANDSCAPE`) Android stops applying the
 * accelerometer to the window, so no configuration change fires and
 * `useWindowDimensions` never updates — there is no signal left to follow. The
 * native module reads the accelerometer directly and emits only on a real change.
 *
 * "portrait" covers upright and upside down; "landscape" covers both sides.
 *
 * Returns a no-op unsubscribe when the module is absent, so callers need no guard.
 */
export function onDeviceOrientation(
  listener: (orientation: DeviceOrientation) => void
): () => void {
  if (!native) return () => {};
  try {
    const sub = new NativeEventEmitter(native).addListener(DEVICE_ORIENTATION_EVENT, (e) => {
      if (e === 'portrait' || e === 'landscape' || e === 'reverseLandscape') listener(e);
    });
    native.startDeviceOrientationWatch?.();
    return () => {
      sub.remove();
      try {
        native.stopDeviceOrientationWatch?.();
      } catch {
        // Nothing to release if the module is already gone.
      }
    };
  } catch {
    return () => {};
  }
}

/**
 * Blurs (or un-blurs, with radius 0) a single view, addressed by its React tag.
 *
 * Only ever used to push the music player out of focus behind the volume readout.
 * The tag comes from `findNodeHandle` on a `collapsable={false}` view, so only
 * that one subtree is filtered — the layout and the controls are never touched.
 *
 * False means the platform could not do it: `RenderEffect` is API 31+ and the app
 * supports API 24. Callers treat that as "dim only" rather than as a failure.
 */
export async function setViewBlur(tag: number, radius: number): Promise<boolean> {
  if (!native?.setViewBlur) return false;
  try {
    return await native.setViewBlur(tag, Math.max(0, radius));
  } catch {
    return false;
  }
}

/**
 * Asks Android to hold read access to a `content://` file beyond the lifetime of
 * the intent that delivered it.
 *
 * False means the sender did not grant a persistable permission, which is the
 * normal case for ACTION_VIEW. The file still plays for the current session; it
 * just may not survive a restart.
 */
export async function takePersistableMediaAccess(uri: string): Promise<boolean> {
  if (!native?.takePersistableMediaAccess) return false;
  try {
    return await native.takePersistableMediaAccess(uri);
  } catch {
    return false;
  }
}

/**
 * Subscribes to media files another app hands to Movira while it is ALREADY
 * running.
 *
 * React Native's Linking cannot be used here. As of 0.85 `IntentModule`
 * implements only `getInitialURL` and no longer registers an activity listener,
 * so its `url` event never fires for an ACTION_VIEW delivered to a running
 * activity — which is precisely what "Open with" does once Movira sits in the
 * background. The module emits this event from `onNewIntent` instead.
 *
 * Returns a no-op unsubscribe when the module is absent, so callers need no
 * guard.
 */
export function onExternalMediaOpen(
  listener: (media: ExternalMedia) => void
): () => void {
  if (!native) return () => {};
  try {
    const sub = new NativeEventEmitter(native).addListener(OPEN_MEDIA_EVENT, (e) => {
      if (!e?.uri) return;
      listener({
        uri: e.uri,
        name: e.name ?? null,
        mimeType: e.mimeType ?? null,
        size: e.size ?? null,
        path: e.path ?? null,
      });
    });
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

/**
 * Best-effort delete of a `content://` file — true when the provider really
 * removed it, false when it refused (or the module is missing). Never throws:
 * the caller falls back to dropping the item from the app's own list.
 */
export async function deleteContentUri(uri: string): Promise<boolean> {
  if (!native?.deleteContentUri) return false;
  try {
    return await native.deleteContentUri(uri);
  } catch {
    return false;
  }
}

/**
 * Deletes media files through the platform's own confirmation prompt.
 *
 * On Android 11+ an app cannot delete a file it does not own, which is why
 * Delete silently did nothing for most media: the underlying `File.delete()`
 * returns false and the failure is never reported. `MediaStore.createDeleteRequest`
 * is the sanctioned way through — Android asks the user once, and on approval the
 * file is genuinely removed. No "All files access" required.
 *
 * Resolves true only when the user approved and the platform did the deletion.
 * Never throws; the caller decides what to do about a refusal.
 */
export async function requestDeleteMedia(paths: string[]): Promise<boolean> {
  if (!native?.requestDeleteMedia || paths.length === 0) return false;
  try {
    return await native.requestDeleteMedia(paths);
  } catch {
    return false;
  }
}

/**
 * Opens a web URL in the device's default browser, explicitly bypassing any
 * dedicated app for that domain.
 *
 * `Linking.openURL` alone is not enough here: a plain ACTION_VIEW is offered to
 * whichever app claims the host, so `github.com/...` goes to the official GitHub
 * app while LinkedIn and the portfolio site (having no app installed) fall
 * through to the browser. That made the three links in the About dialog behave
 * inconsistently. The native side resolves the real browser and pins the intent
 * to it — see `openInBrowser` in MoviraSystemModule.kt.
 *
 * Returns false when the module is missing or no browser could be resolved, so
 * the caller can tell the user instead of assuming the link opened.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  if (!native?.openInBrowser) {
    // Older build without the native method: fall back to the system handler
    // rather than dropping the tap entirely.
    const { Linking } = require('react-native') as typeof import('react-native');
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      return false;
    }
  }
  try {
    return await native.openInBrowser(url);
  } catch {
    return false;
  }
}

/**
 * Puts the activity into Android's picture-in-picture window.
 *
 * Resolves false when the device or OS refuses (the feature needs
 * `supportsPictureInPicture` on the activity and is unavailable on some builds),
 * so the caller can leave the video full screen instead of appearing to do
 * nothing.
 */
export async function enterPictureInPicture(): Promise<boolean> {
  if (!native?.enterPictureInPicture) return false;
  try {
    return await native.enterPictureInPicture();
  } catch {
    return false;
  }
}

/**
 * Writes a line to logcat under the "MoviraJS" tag.
 *
 * Release bundles strip `console.*`, so a caught render error is otherwise
 * invisible on device; this is the only channel that survives.
 */
export function logToAndroid(message: string): void {
  try {
    native?.log(message);
  } catch {
    // Diagnostics only — never let logging break the app.
  }
}
