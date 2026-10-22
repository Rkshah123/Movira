import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
  StatusBar,
  type GestureResponderEvent,
} from 'react-native';
import Video, {
  SelectedTrackType,
  type OnLoadData,
  type OnProgressData,
  type VideoRef,
} from 'react-native-video';
import { formatTime } from '@shared';
import { useAppState } from '../state/AppContext';
import { useNav } from '../state/NavContext';
import { useTheme } from '../theme';
import Icon, { type IconName } from '../ui/Icon';
import { levelLabel, levelSymbol } from '../ui/levelSymbol';
import { describeFailure, codecToMime, humanCodec, humanAudioCodec, type PlaybackFailure } from '../playbackErrors';
import { TrackSlider } from '../ui/Controls';
import EmptyState from '../ui/EmptyState';
import ChoiceDialog, { type Choice } from '../ui/ChoiceDialog';
import * as system from '../system';

/**
 * Video Now Playing — full-bleed, overlay controls only.
 *
 * The picture owns the whole screen and every control floats above it, so there
 * is no second control bar under the video.
 *
 *   top      [<blue arc] ....... [title, 2 lines] .......        (landscape)
 *            [title, 2 lines, left aligned]                     (portrait)
 *   bottom   0:02                                    - 2:18:17
 *            ────────────────O───────────────────────────────
 *            [info][fit]        ( PLAY )        [popout][more]
 *
 * Gestures on the picture itself (VLC-style):
 *   1 tap     toggle the controls
 *   2/3/4     seek forward/back by 10/20/30s; right half forward, left half back
 *   swipe     right half = media volume, left half = window brightness
 *
 * Volume and brightness readouts appear only for those two gestures — a plain
 * tap shows the controls and nothing else.
 */

/**
 * Seconds added per tap in a left/right tap burst: 1 tap is an ordinary control
 * toggle, so the seek starts at 2 taps and keeps adding `TAP_STEP_SECONDS` for
 * every extra tap — 2 taps = 20s, 3 = 30s, 4 = 40s, and so on without a cap.
 */
const TAP_STEP_SECONDS = 10;
/** Seconds a full-width horizontal swipe covers, so the mapping feels proportional. */
const SWIPE_SEEK_SECONDS = 120;
/** A burst is committed this long after the last tap lands. */
const TAP_SETTLE_MS = 360;
/** A tap further apart than this starts a new burst. */
const TAP_GAP_MS = 420;
/** A drag shorter than this is treated as a tap, not a gesture. */
const DRAG_THRESHOLD = 12;

/**
 * How long the player will wait for the engine to hand over a source before
 * admitting that nothing is loaded.
 *
 * Only a backstop for a source that never arrives. A real one shows up in a few
 * hundred milliseconds, so this is never reached in normal use — it just stops a
 * blank screen from lasting forever if the engine does go quiet.
 */
const SOURCE_WAIT_MS = 4000;
/** Zoom bounds, shared by the pinch gesture and the aspect-ratio options. */
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;

/** Rail geometry for the volume / brightness slider. Both values are CONSTANT. */
const HUD_TRACK = 132;
const HUD_THUMB = 16;
/** How far the handle travels from the bottom of the rail to the top. */
const HUD_TRAVEL = HUD_TRACK - HUD_THUMB;

/** Which single gesture the current touch belongs to. */
type GestureMode = 'volume' | 'brightness' | 'seek' | 'pinch' | null;

/**
 * Horizontal thirds of the picture for tap handling.
 *
 * `centre` is a double-tap zone for play/pause; the outer thirds keep the
 * +/-10s-per-tap seek. Keeping them separate means a centre double-tap can never
 * seek, and a left/right double-tap can never pause.
 */
type TapZone = 'left' | 'centre' | 'right';

/** Fraction of the width taken by the centre zone on each side of the middle. */
const CENTRE_ZONE = 0.3;

/**
 * Distance between the first two active touches, for the pinch ratio.
 */
function touchDistance(touches: readonly { pageX: number; pageY: number }[]): number {
  if (touches.length < 2) return 0;
  const dx = touches[0].pageX - touches[1].pageX;
  const dy = touches[0].pageY - touches[1].pageY;
  return Math.sqrt(dx * dx + dy * dy);
}

type Hud =
  | { kind: 'seek'; text: string; side?: 'left' | 'right' }
  | { kind: 'volume'; level: number; side: 'left' | 'right' }
  | { kind: 'brightness'; level: number; side: 'left' | 'right' }
  | { kind: 'error'; text: string };

type ResizeMode = 'contain' | 'cover' | 'stretch';

/**
 * Forced display aspect for the 16:9 and 4:3 sizing options.
 *
 * react-native-video only offers contain / cover / stretch, so a fixed ratio is
 * produced by letterboxing the surface inside a correctly-proportioned box and
 * centring it. 'auto' means "follow the screen".
 */
type ForcedAspect = 'auto' | '16:9' | '4:3';

const ASPECT_RATIOS: Record<Exclude<ForcedAspect, 'auto'>, number> = {
  '16:9': 16 / 9,
  '4:3': 4 / 3,
};
type Sheet = 'none' | 'display' | 'tracks' | 'speed' | 'sleep' | 'more';

type TrackInfo = { index: number; title?: string; language?: string; selected?: boolean };

/**
 * The player's own orientation choice, kept outside React on purpose.
 *
 * react-native-video re-emits `onLoad` after a layout/orientation change, and a
 * plain `useRef` is reset whenever this screen remounts. Either way auto-detect
 * would quietly undo a rotation the user just asked for, so the choice lives
 * here for the whole session. `null` means "follow the video".
 */
let manualOrientation: system.OrientationMode | null = null;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clampZoom = (v: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v));

const SPEEDS: Choice[] = [
  { label: '0.5×', value: '0.5' },
  { label: '0.75×', value: '0.75' },
  { label: 'Normal speed', value: '1' },
  { label: '1.25×', value: '1.25' },
  { label: '1.5×', value: '1.5' },
  { label: '2×', value: '2' },
];

export default function VideoPlayerScreen() {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();
  const { width, height } = useWindowDimensions();
  const videoRef = useRef<VideoRef>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hudTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // From context, NOT from `engine.getVideoSource()`.
  //
  // The engine's source was closure state, so a player that mounted before the
  // engine finished an `await` on its way to setting it read `null` — and with
  // nothing in React state to change, it stayed "No video is loaded" until some
  // unrelated interaction made it re-render. That was the first tap doing
  // nothing and the second tap appearing to work. This value is state, so the
  // picture arrives as soon as the engine announces it.
  const source = app.videoSource;
  const current = app.current;

  const [progress, setProgress] = useState({ time: 0, duration: 0 });
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [failure, setFailure] = useState<PlaybackFailure | null>(null);
  /**
   * Whether "All files access" is granted, read once at mount.
   *
   * Only needed to word an error correctly, and it cannot change while this
   * screen is up (granting it leaves the app), so a single read is enough and
   * keeps the error path off the critical path.
   */
  const allFilesRef = useRef(false);
  const [locked, setLocked] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hud, setHud] = useState<Hud | null>(null);
  /**
   * The readout keeps rendering for as long as the fade-out needs, so it can
   * dissolve instead of being yanked off screen the moment the timer expires.
   */
  const [hudView, setHudView] = useState<Hud | null>(null);
  const hudFade = useRef(new Animated.Value(0)).current;
  /** 0..1 level that positions the slider handle. */
  const hudLevelAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (hud) {
      setHudView(hud);
      Animated.timing(hudFade, {
        toValue: 1,
        duration: 160,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
      return;
    }
    Animated.timing(hudFade, {
      toValue: 0,
      duration: 320,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setHudView(null);
    });
  }, [hud, hudFade]);
  // Immersive is driven by playback state (`app.playing`) rather than a separate
  // fullscreen flag, so there is no independent fullscreen toggle any more.
  const [keepAwake, setKeepAwake] = useState(true);
  const [resizeMode, setResizeMode] = useState<ResizeMode>('contain');
  const [forcedAspect, setForcedAspect] = useState<ForcedAspect>('auto');
  const [zoom, setZoom] = useState(1);
  const [rate, setRate] = useState(1);
  const [orientation, setOrientation] = useState<system.OrientationMode>('auto');
  const [sheet, setSheet] = useState<Sheet>('none');
  const [audioTracks, setAudioTracks] = useState<TrackInfo[]>([]);
  const [textTracks, setTextTracks] = useState<TrackInfo[]>([]);
  const [audioIndex, setAudioIndex] = useState<number | null>(null);
  const [textIndex, setTextIndex] = useState<number | null>(null);
  /** Set once the user picks an orientation by hand; stops auto-detection. */
  const orientationByUser = useRef(false);

  /**
   * The file whose aspect ratio has already been used to choose an orientation.
   *
   * This is what makes the video decide the STARTING orientation only. `onLoad`
   * fires again after every rotation, and it used to re-pin the activity to the
   * video's aspect each time — which is exactly why turning the phone did nothing:
   * the moment the window changed, the player snapped it back.
   */
  const orientedForSource = useRef<string | null>(null);

  /**
   * The file currently loaded, always up to date.
   *
   * `onLoad` can be answered BEFORE React has re-rendered with the new file, so
   * reading `source?.uri` from inside that callback returns the PREVIOUS file.
   * That is what made switching back to a video that had been played before do
   * nothing at all: the stale uri matched the one already recorded, so the
   * orientation was skipped and the window kept the old file's shape. A ref
   * written during render cannot go stale.
   */
  const sourceUriRef = useRef<string | null>(null);
  sourceUriRef.current = source?.uri ?? null;
  // Cleared during render rather than in an effect, for the same reason: a
  // passive effect can run after `onLoad` has already been answered.
  if (orientedForSource.current != null && orientedForSource.current !== sourceUriRef.current) {
    orientedForSource.current = null;
  }

  // Mirrors of the device levels. Held in state so a swipe starts from the real
  // current value instead of waiting on an async native read mid-drag.
  const [volume, setVolume] = useState(1);
  const [brightness, setBrightness] = useState(1);

  const shown = seekPreview ?? progress.time;
  const landscape = width > height;

  // Refs so the gesture responder (created once) always sees current values.
  const shownRef = useRef(shown);
  const durationRef = useRef(progress.duration);
  const lockedRef = useRef(locked);
  const controlsVisibleRef = useRef(controlsVisible);
  const volumeRef = useRef(volume);
  const brightnessRef = useRef(brightness);
  const zoomRef = useRef(zoom);
  /**
   * Live gesture state.
   *
   * `mode` is decided on the FIRST MOVE, not when the finger lands, because a
   * touch that never moves must stay an ordinary tap. Pinch is detected first so
   * two fingers can never be read as a single-finger drag.
   */
  const gesture = useRef<{
    mode: GestureMode;
    startX: number;
    startY: number;
    /** Volume or brightness level at the moment the drag began. */
    base: number;
    /** Playback position at the moment a horizontal drag began. */
    seekStart: number;
    pinchStartDist: number;
    pinchStartZoom: number;
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    base: 0,
    seekStart: 0,
    pinchStartDist: 0,
    pinchStartZoom: 1,
  });

  shownRef.current = shown;
  durationRef.current = progress.duration;
  lockedRef.current = locked;
  controlsVisibleRef.current = controlsVisible;
  volumeRef.current = volume;
  brightnessRef.current = brightness;
  zoomRef.current = zoom;

  useEffect(() => {
    setFailure(null);
    setSeekPreview(null);
    setAudioTracks([]);
    setTextTracks([]);
    setAudioIndex(null);
    setTextIndex(null);
    setZoom(1);
    setRate(1);
    // Every file opens letterboxed unless the user asks otherwise, so a Fill or
    // Stretch left over from the previous video cannot start this one distorted.
    setResizeMode('contain');
    setForcedAspect('auto');
    orientationByUser.current = manualOrientation != null;
    setOrientation('auto');
  }, [source?.uri]);

  useEffect(() => {
    if (seekPreview === null) return;
    if (Math.abs(progress.time - seekPreview) < 0.75) {
      setSeekPreview(null);
      return;
    }
    const timer = setTimeout(() => setSeekPreview(null), 6000);
    return () => clearTimeout(timer);
  }, [progress.time, seekPreview]);
  // The engine's command channel is owned by this screen while it is mounted.
  useEffect(() => {
    const engine = app.services.engine;
    engine.video.play = () => {};
    engine.video.pause = () => {};
    engine.video.seek = (time) => videoRef.current?.seek(time);
    engine.video.setMuted = (m) => setMuted(m);
  }, [app.services.engine]);

  const poke = useCallback(() => {
    controlsVisibleRef.current = true;
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      controlsVisibleRef.current = false;
      setControlsVisible(false);
    }, 3500);
  }, []);

  /**
   * Reports a video the device has no decoder for.
   *
   * Without a decoder ExoPlayer raises nothing at all: the clock runs, the audio
   * plays, the controls all work, and the only symptom is a black rectangle that
   * looks like a broken player. Measured on this phone — it has decoders for
   * H.264, but the platform list comes back empty for `video/mpeg2`, and an
   * MPEG-2 file (in a .ts container or an .mp4) plays silently onto black.
   *
   * The codec is read with MediaExtractor rather than from the player library's
   * `videoTracks[].codecs`, which reported `"avc1.640016"` for H.264 but an EMPTY
   * STRING for MPEG-2 — unreliable in precisely the case that matters.
   *
   * Only fires when the codec is positively identified AND the platform confirms
   * it has no decoder, so an unusual but perfectly playable codec is never
   * accused of being unplayable.
   *
   * The whole check is asynchronous, which is where the danger lies: it has two
   * awaits and a user can pick a different video in between. A result that lands
   * after the screen has moved on would accuse the NEW file of the OLD file's
   * fault — which is exactly what happened first time round, where an H.264 file
   * playing perfectly was labelled MPEG-2 because the previous MPEG-2 video's
   * probe finished late. So every answer is matched back against the URI it was
   * asked for and dropped if that file is no longer on screen.
   */
  const checkVideoDecodable = useCallback(async (fallbackCodecs?: string) => {
    const asked = sourceUriRef.current;
    if (!asked) return;
    let mime: string | null = null;
    try {
      mime = await system.probeVideoMime(asked);
    } catch {
      mime = null;
    }
    if (sourceUriRef.current !== asked) return;
    // The extractor is authoritative; the library's field is only a backstop.
    if (!mime) mime = codecToMime(fallbackCodecs);
    if (!mime) return;
    let decodable = true;
    try {
      decodable = await system.canDecodeMime(mime);
    } catch {
      return;
    }
    if (sourceUriRef.current !== asked) return;
    if (decodable) return;
    setFailure((existing) => {
      // Never overwrite a real error that already explains itself better.
      if (existing) return existing;
      return {
        kind: 'codecMissing' as const,
        message: `This video is ${humanCodec(mime)} and this phone has no decoder for it.`,
        hint: 'The file itself is fine — this device cannot play this format. Converting it to H.264 (MP4) will make it play here.',
      };
    });
  }, []);

  /**
   * Explains a SILENT video whose audio this phone cannot decode.
   *
   * This is the audio half of `checkVideoDecodable`, and it is needed for the
   * opposite reason: an MKV carrying only AC-3 / E-AC-3 / DTS audio plays its
   * video perfectly on a device with no decoder for that codec, and ExoPlayer * drops the audio with NO error and NO callback — just a muted picture. The * user sees a player that looks broken while it is doing exactly what the * platform told it to, so nothing in the error path ever fires on its own.
   *
   * Two things keep this honest rather than noisy:
   *
   *  - ExoPlayer auto-selects a decodable track whenever one exists (measured: a *    file with an AC-3 default plus an AAC track plays audio via c2.android.aac). *    So a list containing ANY decodable codec means playback is fine and this *    stays silent — single-track files are the only case worth reporting.
   *  - The claim is checked against the device's real decoder list via *    `canDecodeMime`, exactly like the video check, so it never blames hardware *    that is not actually missing.
   *
   * It never replaces a stronger existing failure (the guard inside setFailure), * and it does not stop playback — the video keeps playing, now with a reason.
   */
  const checkAudioDecodable = useCallback(async (tracks?: { type?: string }[]) => {
    const asked = sourceUriRef.current;
    if (!asked) return;
    // Where the codecs come from matters more than anything else here.
    //
    // Android's platform `MediaExtractor` HIDES an audio track whose codec it
    // has no decoder for: measured on this handset, the same MKV lists 2 tracks
    // for AAC / FLAC / Opus and only the video track for AC-3 and E-AC-3
    // (`ffmpeg -i` confirms both streams really are in the file). So probing the
    // platform can never see the one codec this check exists to explain.
    //
    // ExoPlayer parses containers itself, so its `audioTracks` from `onLoad` do
    // contain the track — reported as `{ type: "audio/ac3", selected: false }`.
    // That list is the primary source; the platform probe is only a fallback for
    // the case where ExoPlayer reports nothing (a file with no audio at all).
    const fromPlayer = (tracks ?? [])
      .map((t) => t?.type)
      .filter((m): m is string => typeof m === 'string' && m.startsWith('audio/'));
    let mimes: string[] | null = null;
    if (fromPlayer.length > 0) {
      mimes = fromPlayer;
    } else {
      try {
        mimes = await system.probeAudioMimes(asked);
      } catch {
        mimes = null;
      }
    }
    if (sourceUriRef.current !== asked) return;
    // No audio tracks at all, or the file cannot be read — nothing to explain.
    if (!mimes || mimes.length === 0) return;
    // Any decodable track is enough: ExoPlayer will have picked it.
    for (const mime of mimes) {
      try {
        if (await system.canDecodeMime(mime)) return;
      } catch {
        return; // cannot confirm — say nothing rather than guess
      }
    }
    if (sourceUriRef.current !== asked) return;
    const mime = mimes[0];
    setFailure((existing) => {
      // Never overwrite a real error that already explains itself better.
      if (existing) return existing;
      return {
        kind: 'codecMissing' as const,
        message: `This file's audio is ${humanAudioCodec(mime)} and this phone has no decoder for it. The video will play, but there will be no sound.`,
        hint: 'The file itself is fine — this device cannot decode this audio format. Converting its audio to AAC (or adding an AAC track) will make it play with sound here.',
      };
    });
  }, []);

  const showHud = useCallback((next: Hud, hold = 900) => {
    setHud(next);
    // The slider handle rides this value directly, so it tracks the finger at
    // frame rate instead of being re-rendered into a new layout each move.
    if (next.kind === 'volume' || next.kind === 'brightness') {
      hudLevelAnim.setValue(clamp01(next.level));
    }
    if (hudTimer.current) clearTimeout(hudTimer.current);
    hudTimer.current = setTimeout(() => setHud(null), hold);
  }, []);

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (hudTimer.current) clearTimeout(hudTimer.current);
      // Leaving the player tears the video surface down. Without this the shared
      // `playing` flag stays true and the mini player offers "Pause" for an item
      // that has actually stopped.
      app.services.engine.handlers.onPlayingChange(false);
      // Brightness was set on our own window; hand it back to the system.
      system.resetBrightness().catch(() => {});
      // Stop holding the display awake or hiding the bars once we are gone.
      system.setKeepScreenOn(false).catch(() => {});
      system.setImmersive(false).catch(() => {});
      // Back to PORTRAIT, not "auto".
      //
      // Every other screen in Movira is a portrait-only layout, and "auto" means
      // SCREEN_ORIENTATION_FULL_USER — follow whatever the sensor says. With the
      // phone lying flat on a desk there is no side-on reading to follow, so the
      // window simply keeps the landscape it had and the whole app is left
      // stranded sideways with the library clipped and the tab bar overlapping
      // the list. It is just as stuck when auto-rotate is off, because FULL_USER
      // then pins the window to its current orientation. Asking for portrait
      // states the one orientation the rest of the app is actually built for.
      system.setOrientation('portrait').catch(() => {});
    },
    []
  );

  // Read the real starting levels once so the first swipe agrees with the
  // device rather than assuming 100%.
  useEffect(() => {
    let alive = true;
    system
      .getVolume()
      .then((v) => {
        if (alive) setVolume(v);
      })
      .catch(() => {});
    system
      .getBrightness()
      .then((v) => {
        if (alive && v != null) setBrightness(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // --- orientation --------------------------------------------------------

  /**
   * Orientation is driven by the player, not by the user turning the handset:
   * a 1920x1080 film goes landscape by itself, a vertical clip stays portrait.
   * The user can override it at any time, and once they do we stop second-guessing
   * them for the rest of this file.
   */
  const appliedOrientationRef = useRef<system.OrientationMode>('auto');

  const applyOrientation = useCallback((mode: system.OrientationMode) => {
    // Recorded here rather than only by the sensor handler, so the very first
    // sensor reading after the aspect ratio has chosen an orientation is compared
    // against what was really applied.
    appliedOrientationRef.current = mode;
    setOrientation(mode);
    system.setOrientation(mode).catch((err) => {
      console.warn('Movira: could not set orientation', err);
    });
  }, []);

  /**
   * Follow the handset while a video is on screen.
   *
   * The video's aspect ratio chooses where playback STARTS; this keeps it there
   * afterwards. Without it the activity is pinned, and a pinned window ignores the
   * accelerometer entirely — no configuration change fires, nothing re-renders and
   * the screen simply never responds to the phone being turned.
   *
   * The comparison is against the LAST MODE APPLIED, not against whether the
   * window happens to be wider than it is tall. That distinction is the whole fix
   * for the upside-down case: the two landscape directions are both "landscape"
   * as a boolean, so comparing booleans made a turn from one side to the other
   * look like "already there" and nothing happened, leaving the video 180 degrees
   * out. Comparing the modes sees landscape != reverseLandscape and rotates.
   *
   * Subscribed once and reading the applied mode through a ref: depending on it
   * directly would tear the sensor watch down and set it up again on every single
   * rotation, which both wastes the registration and resets the native "only
   * report changes" state, so the first reading after each rotation would arrive
   * as a spurious change.
   *
   * When the system auto-rotate is ON the window rotates itself before this runs,
   * so the ref already matches and nothing extra happens. On a rotation the
   * activity handles `configChanges` for orientation, so the window is resized in
   * place: ExoPlayer is never torn down, the position is kept and there is no
   * flicker.
   */
  useEffect(() => {
    const off = system.onDeviceOrientation((physical) => {
      if (orientationByUser.current) return;
      if (appliedOrientationRef.current === physical) return;
      appliedOrientationRef.current = physical;
      applyOrientation(physical);
    });
    return off;
  }, [applyOrientation]);

  // --- awake --------------------------------------------------------------

  // Read once so an access failure can be worded correctly instead of being
  // blamed on the codec. Read after mount so it never delays the first frame.
  useEffect(() => {
    let alive = true;
    void system.hasAllFilesAccess().then((v) => {
      if (alive) allFilesRef.current = v;
    });
    return () => {
      alive = false;
    };
  }, []);

  // Hold the display awake while the video is on screen.
  useEffect(() => {
    system.setKeepScreenOn(keepAwake).catch(() => {});
  }, [keepAwake]);

  /**
   * Full immersive while playing. `<StatusBar hidden>` only covers the top bar,
   * so the navigation bar is hidden through the native insets controller too.
   * Anything that is not playback — paused, stopped, or a different screen —
   * restores both.
   */
  useEffect(() => {
    system.setImmersive(app.playing).catch(() => {});
  }, [app.playing]);

  // --- display mode -------------------------------------------------------

  const videoTransform = useMemo(
    () => (zoom === 1 ? undefined : [{ scale: zoom }]),
    [zoom]
  );

  // --- seeking ------------------------------------------------------------

  const seekBy = useCallback((delta: number) => {
    const dur = durationRef.current;
    const from = shownRef.current;
    const target = dur > 0 ? Math.min(dur, Math.max(0, from + delta)) : Math.max(0, from + delta);
    videoRef.current?.seek(target);
    setSeekPreview(target);
  }, []);

  // Reads the ref rather than the state value: the tap that hides the controls
  // is committed from a timeout, and relying on the captured `controlsVisible`
  // left it stuck open because the closure had already gone stale.
  const toggleControls = useCallback(() => {
    if (controlsVisibleRef.current) {
      controlsVisibleRef.current = false;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setControlsVisible(false);
    } else {
      poke();
    }
  }, [poke]);

  // --- multi-tap burst ----------------------------------------------------

  const taps = useRef<number[]>([]);
  const tapSide = useRef<TapZone>('right');
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set when a centre double-tap already toggled playback, so it is not repeated. */
  const centreHandled = useRef(false);

  // Resolved once the burst settles, so a 1-tap toggle and a 4-tap +30s seek
  // are decided by the same code path instead of racing each other.
  const commitSeek = useCallback(() => {
    if (tapTimer.current) clearTimeout(tapTimer.current);
    tapTimer.current = null;
    const count = taps.current.length;
    const side = tapSide.current;
    const alreadyHandled = centreHandled.current;
    taps.current = [];
    centreHandled.current = false;

    // A centre double-tap already toggled playback the instant the second tap
    // landed, so there is nothing left to do when the burst settles.
    if (alreadyHandled) return;

    // A burst that never grew past one tap is an ordinary toggle. Acting here
    // rather than on the first tap keeps a 2/3/4-tap seek from briefly hiding
    // the controls and popping them straight back.
    if (count < 2) {
      toggleControls();
      return;
    }
    // A double-tap in the middle pauses / resumes instead of seeking.
    if (side === 'centre') {
      onTogglePlayRef.current();
      return;
    }
    const secs = count * TAP_STEP_SECONDS;
    const delta = (side === 'right' ? 1 : -1) * secs;
    seekBy(delta);
    showHud({ kind: 'seek', text: `${delta > 0 ? '+' : '-'}${secs}s`, side }, 800);
  }, [seekBy, showHud, toggleControls]);

  const registerTap = useCallback(
    (x: number) => {
      const now = Date.now();
      const list = taps.current;
      // A fresh burst also clears the "already handled" latch.
      if (list.length && now - list[list.length - 1] > TAP_GAP_MS) {
        list.length = 0;
        centreHandled.current = false;
      }
      list.push(now);

      const ratio = x / Math.max(1, width);
      const side: TapZone =
        ratio > 0.5 + CENTRE_ZONE / 2
          ? 'right'
          : ratio < 0.5 - CENTRE_ZONE / 2
            ? 'left'
            : 'centre';
      tapSide.current = side;

      if (side === 'centre') {
        // Fire on the SECOND tap immediately — no settle wait, so play/pause
        // feels instant. Never seeks, and deliberately shows NO text: the
        // transport button itself flips between play and pause, so that is the
        // only feedback needed.
        if (list.length === 2) {
          centreHandled.current = true;
          onTogglePlayRef.current();
        }
        if (tapTimer.current) clearTimeout(tapTimer.current);
        tapTimer.current = setTimeout(commitSeek, TAP_SETTLE_MS);
        return;
      }

      // Preview the growing burst; the action itself waits for the settle timer
      // so a lone tap is not committed before the rest of the burst arrives.
      if (list.length >= 2) {
        const secs = list.length * TAP_STEP_SECONDS;
        showHud({ kind: 'seek', text: `${side === 'right' ? '+' : '-'}${secs}s`, side }, 1200);
        // A burst also leaves the controls up, so the result stays readable.
        poke();
      }
      if (tapTimer.current) clearTimeout(tapTimer.current);
      tapTimer.current = setTimeout(commitSeek, TAP_SETTLE_MS);
    },
    [app.playing, commitSeek, poke, showHud, width]
  );

  // --- vertical gestures --------------------------------------------------

  const applyLevel = useCallback(
    (mode: 'volume' | 'brightness', base: number, dy: number) => {
      // Finger down (positive dy) lowers the level, hence the inversion.
      const span = Math.max(160, height * 0.7);
      const next = clamp01(base - dy / span);
      if (mode === 'volume') {
        setVolume(next);
        showHud({ kind: 'volume', level: next, side: 'right' });
        // A native failure must NOT replace the meter with an error: the error
        // overwrites the same HUD slot, so the readout flashed away mid-gesture.
        system.setVolume(next).catch((err) => {
          console.warn('Movira: could not set volume', err);
        });
      } else {
        setBrightness(next);
        showHud({ kind: 'brightness', level: next, side: 'left' });
        system.setBrightness(next).catch((err) => {
          console.warn('Movira: could not set brightness', err);
        });
      }
    },
    [showHud, height]
  );

  // Plain responder props rather than PanResponder: PanResponder claimed the
  // responder on the first touch and never got its release back from the native
  // video view. The same prop pattern is what TrackSlider uses.
  const onStageGrant = useCallback(
    (e: GestureResponderEvent) => {
      // Nothing is decided yet: a press that turns into a tap must not have
      // already claimed the volume/brightness axis.
      const touches = e.nativeEvent.touches;
      gesture.current = {
        mode: null,
        startX: e.nativeEvent.pageX,
        startY: e.nativeEvent.pageY,
        base: 0,
        seekStart: shownRef.current,
        pinchStartDist: touchDistance(touches),
        pinchStartZoom: 1,
      };
    },
    []
  );

  /**
   * Decides which gesture this touch became, once — on the first real movement.
   *
   * Order matters: two fingers always mean pinch; then whichever axis the finger
   * travelled furthest along wins, so a diagonal drag is never read as both a
   * seek and a volume change.
   */
  const resolveGestureMode = useCallback(
    (e: GestureResponderEvent): GestureMode => {
      const gr = gesture.current;
      if (gr.mode) return gr.mode;

      const touches = e.nativeEvent.touches;
      if (touches.length >= 2) {
        gr.mode = 'pinch';
        gr.pinchStartDist = touchDistance(touches) || 1;
        gr.pinchStartZoom = zoomRef.current;
        return gr.mode;
      }

      const dx = e.nativeEvent.pageX - gr.startX;
      const dy = e.nativeEvent.pageY - gr.startY;
      if (Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return null;

      if (Math.abs(dx) > Math.abs(dy)) {
        gr.mode = 'seek';
        gr.seekStart = shownRef.current;
      } else {
        const onRight = gr.startX >= width / 2;
        gr.mode = onRight ? 'volume' : 'brightness';
        gr.base = onRight ? volumeRef.current : brightnessRef.current;
      }
      return gr.mode;
    },
    [width]
  );

  const onStageMove = useCallback(
    (e: GestureResponderEvent) => {
      const gr = gesture.current;
      const mode = resolveGestureMode(e);
      if (!mode) return;

      if (mode === 'pinch') {
        const start = gr.pinchStartDist || 1;
        const ratio = touchDistance(e.nativeEvent.touches) / start;
        // A modest dead-zone keeps a resting thumb from nudging the zoom.
        if (Math.abs(ratio - 1) < 0.04) return;
        setZoom(clampZoom(gr.pinchStartZoom * ratio));
        return;
      }

      if (mode === 'seek') {
        // Proportional: the full screen width is worth SWIPE_SEEK_SECONDS, so a
        // short flick moves a little and a full sweep moves a lot.
        const span = Math.max(160, width * 0.9);
        const secs = ((e.nativeEvent.pageX - gr.startX) / span) * SWIPE_SEEK_SECONDS;
        const target = Math.max(0, gr.seekStart + secs);
        videoRef.current?.seek(target);
        setSeekPreview(target);
        const delta = target - gr.seekStart;
        showHud({ kind: 'seek', text: `${delta >= 0 ? '+' : '-'}${Math.abs(Math.round(delta))}s` });
        return;
      }

      applyLevel(mode, gr.base, e.nativeEvent.pageY - gr.startY);
    },
    [applyLevel, resolveGestureMode, showHud, width]
  );

  const onStageRelease = useCallback(
    (e: GestureResponderEvent) => {
      const gr = gesture.current;
      const mode = gr.mode;
      gr.mode = null;

      // A touch that never resolved to a gesture was a tap. Two fingers lifting
      // is never a tap.
      if (!mode) {
        if (e.nativeEvent.touches.length === 0) registerTap(e.nativeEvent.pageX);
        return;
      }

      if (mode === 'volume' || mode === 'brightness') {
        // Let the readout linger briefly after the finger lifts.
        showHud(
          mode === 'volume'
            ? { kind: 'volume', level: volumeRef.current, side: 'right' }
            : { kind: 'brightness', level: brightnessRef.current, side: 'left' },
          600
        );
        return;
      }

      // A finished pinch or horizontal seek just hands control back to the
      // normal auto-hide; the picture itself already shows the zoom, and the
      // seek readout fades out on its own timer.
      poke();
    },
    [poke, registerTap, showHud]
  );

  const onStageTerminate = useCallback(() => {
    gesture.current.mode = null;
  }, []);
  // --- actions ------------------------------------------------------------

  const onToggleLock = useCallback(() => {
    setLocked((v) => {
      const next = !v;
      if (next) {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        controlsVisibleRef.current = false;
        setControlsVisible(false);
      } else {
        poke();
      }
      return next;
    });
  }, [poke]);

  const onTogglePlay = useCallback(() => {
    app.togglePlayPause();
    poke();
  }, [app, poke]);
  /**
   * The tap handlers are declared before `onTogglePlay`, so they reach it through
   * this ref rather than a closure that would capture a stale definition.
   */
  const onTogglePlayRef = useRef(onTogglePlay);
  onTogglePlayRef.current = onTogglePlay;

  const onNudge = useCallback(
    (delta: number) => {
      seekBy(delta);
      showHud({ kind: 'seek', text: `${delta > 0 ? '+' : '-'}${Math.abs(delta)}s`, side: 'left' }, 700);
    },
    [seekBy, showHud]
  );

  const onSelectSpeed = useCallback((value: string) => {
    setRate(Number(value));
    setSheet('none');
  }, []);

  const onSelectDisplay = useCallback((value: string) => {
    // Every option resets the previous one first, so switching modes can never
    // leave a stale ratio or zoom behind.
    setZoom(1);
    setForcedAspect('auto');
    switch (value) {
      case 'best':
        // Whole picture visible, letterboxed to the screen.
        setResizeMode('contain');
        break;
      case 'fit':
        // Picture fills the screen, edges cropped.
        setResizeMode('cover');
        break;
      case 'fill':
        // Stretched to the screen, ignoring the source ratio.
        setResizeMode('stretch');
        break;
      case '16:9':
        setResizeMode('contain');
        setForcedAspect('16:9');
        break;
      case '4:3':
        setResizeMode('contain');
        setForcedAspect('4:3');
        break;
      case 'centre':
        // Plain centred playback at its natural ratio.
        setResizeMode('contain');
        break;
      default:
        break;
    }
    setSheet('none');
  }, []);

  // --- derived ------------------------------------------------------------

  const duration = progress.duration || 0;

  const audioChoices: Choice[] = useMemo(() => {
    if (audioTracks.length === 0) return [{ label: 'Default', value: '0' }];
    return audioTracks.map((tr, i) => ({
      label: tr.title || tr.language || `Track ${i + 1}`,
      value: String(tr.index ?? i),
    }));
  }, [audioTracks]);

  const subChoices: Choice[] = useMemo(
    () => [
      { label: 'Subtitles off', value: 'off' },
      ...textTracks.map((tr, i) => ({
        label: tr.title || tr.language || `Subtitle ${i + 1}`,
        value: String(tr.index ?? i),
      })),
    ],
    [textTracks]
  );

  const displayChoices: Choice[] = useMemo(
    () => [
      { label: 'Best Fit', value: 'best' },
      { label: 'Fit Screen', value: 'fit' },
      { label: 'Fill', value: 'fill' },
      { label: '16:9', value: '16:9' },
      { label: '4:3', value: '4:3' },
      { label: 'Centre', value: 'centre' },
    ],
    []
  );

  /**
   * Which display mode is actually in force, for the picker to mark.
   *
   * Derived from the state that produces the picture rather than stored
   * separately, so it cannot drift out of step with what is on screen. Without
   * it the sheet listed six mutually exclusive modes with none of them ticked,
   * which left no way to tell which one was active.
   *
   * "Best Fit" and "Centre" both mean "contained, natural ratio" and so are
   * indistinguishable in state; "Best Fit" is what playback starts in, so it is
   * what gets reported.
   */
  const currentDisplayMode = useMemo(() => {
    if (forcedAspect === '16:9') return '16:9';
    if (forcedAspect === '4:3') return '4:3';
    if (resizeMode === 'cover') return 'fit';
    if (resizeMode === 'stretch') return 'fill';
    return 'best';
  }, [resizeMode, forcedAspect]);

  /**
   * The three-dot menu, replaced wholesale with exactly the five requested
   * entries and nothing else.
   */
  const moreChoices: Choice[] = useMemo(
    () => [
      { label: 'Sleep Timer', value: 'sleep' },
      { label: 'Playback Speed', value: 'speed' },
      { label: 'Equalizer', value: 'equalizer' },
      { label: 'Play as Audio', value: 'playaudio' },
      { label: 'Pop-up Player', value: 'pip' },
    ],
    []
  );

  const sleepChoices: Choice[] = useMemo(
    () => [
      { label: '5 minutes', value: '5' },
      { label: '10 minutes', value: '10' },
      { label: '15 minutes', value: '15' },
      { label: '30 minutes', value: '30' },
      { label: '45 minutes', value: '45' },
      { label: '60 minutes', value: '60' },
    ],
    []
  );

  const [sleepMinutes, setSleepMinutes] = useState<number | null>(null);

  // Sleep Timer actually stops playback when the chosen time is up.
  useEffect(() => {
    if (sleepMinutes == null) return;
    const at = setTimeout(() => {
      void app.services.engine.stop();
      setSleepMinutes(null);
    }, sleepMinutes * 60 * 1000);
    return () => clearTimeout(at);
  }, [sleepMinutes, app.services.engine]);

  const onSelectMore = useCallback(
    (value: string) => {
      if (value === 'sleep') {
        setSheet('sleep');
        return;
      }
      if (value === 'speed') {
        setSheet('speed');
        return;
      }
      if (value === 'equalizer') {
        setSheet('none');
        nav.pop();
        nav.push({ name: 'equalizer' });
        return;
      }
      if (value === 'playaudio') {
        // Hand the same file to the background audio engine, then leave the
        // video screen so the audio player is what the user is looking at.
        setSheet('none');
        if (current) void app.services.engine.playAsAudio(current);
        nav.popToShell();
        return;
      }
      if (value === 'pip') {
        setSheet('none');
        void system.enterPictureInPicture();
        return;
      }
      setSheet('none');
    },
    [app.services.engine, current, nav]
  );

  /*
   * A video has been chosen but the engine has not handed over its source yet.
   *
   * This is the half-second between the tap and the first frame, and it is a
   * normal state rather than an empty one. Treating it as "nothing is loaded" is
   * what made "No video is loaded." flash on the screen every single time a video
   * was opened — a message shown and taken away again in the time it takes to
   * blink.
   *
   * The source arrives a moment later, so nothing is drawn here at all: no
   * message, no spinner, no overlay. The plain background is there, the picture
   * lands, and the user never sees anything intermediate. The timeout is a
   * safety net so that a source which never arrives cannot leave a blank screen
   * forever — after it, the honest empty state comes back, because by then
   * something really is wrong.
   */
  const awaitingSource = current != null && source == null;
  const [stillWaiting, setStillWaiting] = useState(false);
  useEffect(() => {
    if (!awaitingSource) {
      setStillWaiting(false);
      return;
    }
    setStillWaiting(true);
    const timer = setTimeout(() => setStillWaiting(false), SOURCE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [awaitingSource, source]);

  if (!current || (!source && !stillWaiting)) {
    return (
      <View style={[styles.root, { backgroundColor: t.bg }]}>
        <StatusBar barStyle={t.dark ? 'light-content' : 'dark-content'} backgroundColor={t.bg} />
        <EmptyState message="No video is loaded." />
      </View>
    );
  }

  // A source is genuinely on its way. Draw nothing at all: no message, no
  // spinner, no overlay — the picture is a moment away, and anything shown now
  // would be something to see and then watch disappear.
  if (!source) {
    return (
      <View style={[styles.root, { backgroundColor: t.bg }]}>
        <StatusBar barStyle={t.dark ? 'light-content' : 'dark-content'} backgroundColor={t.bg} />
      </View>
    );
  }

  const hudText =
    hudView?.kind === 'volume' || hudView?.kind === 'brightness'
      ? levelLabel(hudView.kind, hudView.level)
      : hudView?.kind === 'seek'
        ? hudView.text
        : hudView?.kind === 'error'
          ? hudView.text
          : '';
  const hudLevel = hudView && 'level' in hudView ? hudView.level : null;
  const hudSide = hudView && 'side' in hudView ? hudView.side : null;

  const pad = 16;
  const timeRowWidth = width - pad * 2;

  return (
    <View style={[styles.root, { backgroundColor: '#000' }]}>
      {/*
        VLC-style immersive playback: while the video is actually running, the
        system status bar (clock, Wi-Fi, signal, battery) and the navigation bar
        both go away, leaving nothing but the picture. Pausing — or leaving the
        player, which the unmount cleanup also covers — brings them straight
        back.
      */}
      <StatusBar barStyle="light-content" hidden={app.playing} />

      {/*
        The picture fills the screen. `resizeMode` handles fit/fill/stretch and
        the zoom transform is uniform, so the aspect ratio is never distorted.
      */}
      <View style={[styles.stage, { width, height }]}>
        {/*
          When a fixed aspect is chosen the surface is letterboxed inside a box of
          that ratio and centred, which is how 16:9 and 4:3 actually change what
          the viewer sees. Everything else fills the stage as before.
        */}
        <View
          style={
            forcedAspect === 'auto'
              ? { width: '100%', height: '100%' }
              : {
                  aspectRatio: ASPECT_RATIOS[forcedAspect],
                  width: '100%',
                  maxHeight: '100%',
                  alignSelf: 'center',
                }
          }
        >
        <Video
          ref={videoRef}
          source={{ uri: source.uri }}
          style={[styles.video, videoTransform ? { transform: videoTransform } : null]}
          resizeMode={resizeMode}
          muted={muted}
          useTextureView
          paused={!app.playing}
          repeat={false}
          playInBackground={false}
          playWhenInactive={false}
          rate={rate}
          selectedAudioTrack={
            audioIndex == null
              ? undefined
              : { type: SelectedTrackType.INDEX, value: audioIndex }
          }
          selectedTextTrack={
            textIndex == null
              ? { type: SelectedTrackType.DISABLED }
              : { type: SelectedTrackType.INDEX, value: textIndex }
          }
          progressUpdateInterval={500}
          onLoad={(data: OnLoadData) => {
            const nw = data.naturalSize?.width || 16;
            const nh = data.naturalSize?.height || 9;
            // The DIMENSIONS decide this, not the reported orientation: ExoPlayer's
            // `naturalSize.orientation` reflects a rotation hint from the container
            // and disagrees with the real frame often enough to put a vertical clip
            // on its side. `nh > nw` is the frame's actual aspect ratio. The hint
            // is only consulted when the dimensions are missing or square, where
            // there is nothing else to go on.
            const isPortraitSource =
              nw > 0 && nh > 0 ? nh > nw : data.naturalSize?.orientation === 'portrait';
            const src = sourceUriRef.current;
            // Auto-orient ONCE per file. `onLoad` re-fires after every rotation,
            // and re-pinning the activity to the video's aspect each time is what
            // made turning the handset do nothing: the window would change and be
            // immediately forced back. After this first pass the physical
            // orientation owns the window.
            if (!orientationByUser.current && src != null && orientedForSource.current !== src) {
              orientedForSource.current = src;
              applyOrientation(isPortraitSource ? 'portrait' : 'landscape');
            }
            setAudioTracks((data.audioTracks ?? []) as TrackInfo[]);
            setTextTracks((data.textTracks ?? []) as TrackInfo[]);
            setProgress((p) => ({ ...p, duration: data.duration || 0 }));
            app.services.engine.handlers.onPlayingChange(true);
            void checkVideoDecodable(data.videoTracks?.[0]?.codecs);
            // Audio half: explains a video that plays but is silent because this
            // phone has no decoder for its audio codec (see checkAudioDecodable).
            void checkAudioDecodable(data.audioTracks as { type?: string }[]);
            poke();
          }}
          onProgress={(data: OnProgressData) => {
            setProgress((p) => ({
              ...p,
              time: data.currentTime,
              duration: data.seekableDuration || p.duration,
            }));
            app.setProgress({ time: data.currentTime, duration: data.seekableDuration || 0 });
          }}
          onEnd={() => {
            app.services.engine.handlers.onEnd();
          }}
          onError={(e) => {
            // Resolved asynchronously: the message has to consult the device's
            // real decoder list before it is allowed to blame the codec.
            void describeFailure(e, sourceUriRef.current ?? '', {
              hasAllFilesAccess: allFilesRef.current,
              canDecode: system.canDecodeMime,
              grantAllFilesAccess: () => {
                void system.openAllFilesAccessSettings();
              },
            }).then((failure) => {
              setFailure(failure);
              app.services.engine.handlers.onError(failure.message);
            });
          }}
          fullscreen={false}
          controls={false}
        />
        </View>

        {failure ? (
          <View style={styles.errorLayer} pointerEvents="box-none">
            <Text style={[styles.errorTitle, { color: t.accent2 }]}>
              {failure.kind === 'access' ? 'Cannot open this file' : 'Cannot play this file'}
            </Text>
            <Text style={[styles.errorText, { color: t.text }]}>{failure.message}</Text>
            {failure.hint ? (
              failure.onHint ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={failure.hint}
                  style={styles.errorHintButton}
                  onPress={failure.onHint}
                >
                  <Text style={[styles.errorHint, styles.errorHintLink, { color: t.accent2 }]}>
                    {failure.hint}
                  </Text>
                </TouchableOpacity>
              ) : (
                <Text style={[styles.errorHint, { color: t.dim }]}>{failure.hint}</Text>
              )
            ) : null}
          </View>
        ) : null}
      </View>
      {/*
        The gesture surface must be a sibling *above* the <Video>: the video
        renders through a native view that consumes touches before React sees
        them, so handlers wrapped around it would never fire.
      */}
      <View
        style={StyleSheet.absoluteFill}
        onStartShouldSetResponder={() => !lockedRef.current}
        onMoveShouldSetResponder={(e: GestureResponderEvent) => {
          if (lockedRef.current) return false;
          // Two fingers always claim the gesture so a pinch is never downgraded
          // into a single-finger seek or a level change.
          if (e.nativeEvent.touches.length >= 2) return true;
          const gr = gesture.current;
          const dx = e.nativeEvent.pageX - gr.startX;
          const dy = e.nativeEvent.pageY - gr.startY;
          // Either axis, once it has travelled far enough to be intentional.
          return Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD;
        }}
        onResponderTerminationRequest={() => true}
        onResponderGrant={onStageGrant}
        onResponderMove={onStageMove}
        onResponderRelease={onStageRelease}
        onResponderTerminate={onStageTerminate}
        accessibilityRole="button"
        accessibilityLabel={
          locked
            ? 'Video locked'
            : controlsVisible
              ? 'Hide controls'
              : 'Show controls. Double tap right to skip ahead, left to go back.'
        }
      />

      {/* Volume / brightness / seek feedback. Only ever shown for a gesture. */}
      {hudView ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.hud,
            {
              // Full width, so a side tap anchors left/right and a horizontal
              // swipe (which has no side) lands dead centre.
              left: 0,
              right: 0,
              alignItems:
                hudSide === 'left' ? 'flex-start' : hudSide === 'right' ? 'flex-end' : 'center',
              opacity: hudFade,
            },
          ]}
        >
          <View style={styles.hudBubble}>
            <Text
              style={[styles.hudText, hudLevel != null ? styles.hudTextFixed : null]}
              allowFontScaling={false}
            >
              {hudText}
            </Text>
            {hudLevel != null ? (
              /*
               * A real slider, not a growing bar: the rail is a fixed height and
               * the handle simply travels along it. Changing a bar's LENGTH is
               * what made the meter look like it was shrinking as the value
               * dropped; moving a handle means nothing ever changes size.
               */
              <View style={styles.hudTrack}>
                <Animated.View
                  style={[
                    styles.hudThumb,
                    {
                      transform: [
                        {
                          translateY: hudLevelAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, -HUD_TRAVEL],
                          }),
                        },
                      ],
                    },
                  ]}
                />
              </View>
            ) : null}

            {/*
              A large, unmistakable symbol beneath the rail — a speaker for
              volume, a sun for brightness. The speaker swaps between
              low / medium / high / muted so the level is readable at a glance,
              and it is deliberately oversized so it stays visible over a bright
              frame.
            */}
            {hudView && (hudView.kind === 'volume' || hudView.kind === 'brightness') ? (
              <Icon
                name={levelSymbol(hudView.kind, hudView.level)}
                size={54}
                color="#fff"
                style={styles.hudIcon}
              />
            ) : null}
          </View>
        </Animated.View>
      ) : null}

      {/* Locked: hide the controls and leave one obvious way back. */}
      {locked ? (
        <View style={styles.lockLayer} pointerEvents="box-none">
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Unlock video controls"
            style={[styles.lockButton, { backgroundColor: t.accent }]}
            hitSlop={14}
            onPress={onToggleLock}
          >
            <Icon name="lock" size={26} color={t.bg} />
          </TouchableOpacity>
          <Text style={styles.lockHint}>Controls locked — tap to unlock</Text>
        </View>
      ) : null}

      {controlsVisible && !locked ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {/*
            A single uniform veil over the whole picture.

            There used to be two separate scrims — one across the top band and
            one across the bottom — which left the middle un-darkened and read as
            a lighter horizontal strip with two hard edges across the screen. One
            full-screen overlay of constant opacity removes both edges: the
            darkness is now identical from the top of the picture to the bottom.
          */}
          <View style={styles.uniformScrim} pointerEvents="none" />

          {/*
            Top: a blue back chevron in landscape only, and the title.

            The reference puts the title high on the picture at display size —
            large, thin, two lines, soft shadow. Landscape centres it; portrait
            aligns it left. Portrait carries no chevron, matching videosample2.
          */}
          <View
            style={[
              styles.topRow,
              { paddingTop: 26, paddingHorizontal: pad },
            ]}
            pointerEvents="box-none"
          >
            {landscape ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Back to videos"
                hitSlop={18}
                onPress={() => {
                  nav.popToShell();
                  nav.setTab('video');
                }}
                style={styles.backHit}
              >
                <Icon name="back" size={32} color="#fff" />
              </TouchableOpacity>
            ) : null}

            <Text
              style={[styles.stageTitle, landscape ? styles.titleCenter : styles.titleLeft]}
              numberOfLines={2}
              ellipsizeMode="tail"
            >
              {source.title}
            </Text>
          </View>

          {/*
            Bottom: elapsed on the left and remaining on the right, the thin rail
            beneath them, then five controls — two on the left, play in the
            middle, two on the right.
          */}
          <View
            style={[
              styles.bottomBlock,
              { paddingHorizontal: pad, paddingBottom: 26 },
            ]}
            pointerEvents="box-none"
          >
            <View style={styles.timeRow} pointerEvents="box-none">
              <Text style={styles.timeText}>{formatTime(shown)}</Text>
              <Text style={[styles.timeText, styles.timeRight]}>
                {duration > 0 ? `- ${formatTime(Math.max(0, duration - shown))}` : '--:--'}
              </Text>
            </View>

            <View style={styles.railRow} pointerEvents="box-none">
              <TrackSlider
                value={Math.min(shown, duration || 1)}
                onChange={setSeekPreview}
                onCommit={(v) => {
                  videoRef.current?.seek(v);
                  app.services.engine.handlers.onProgress(v, duration);
                }}
                min={0}
                max={Math.max(duration, 1)}
                step={0.1}
                width={timeRowWidth}
                trackColor="#f2711c"
                baseColor="rgba(255,255,255,0.34)"
              />
            </View>

            <View style={styles.iconRow} pointerEvents="box-none">
              <View style={styles.iconPair} pointerEvents="box-none">
                <IconButton
                  icon="trackInfo"
                  label="Audio and subtitles"
                  onPress={() => setSheet('tracks')}
                />
                <UnoLockButton locked={locked} onPress={onToggleLock} />
              </View>

              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={app.playing ? 'Pause' : 'Play'}
                style={styles.playRing}
                onPress={onTogglePlay}
              >
                <Icon name={app.playing ? 'pause' : 'play'} size={30} color="#fff" />
              </TouchableOpacity>

              <View style={styles.iconPair} pointerEvents="box-none">
                <IconButton
                  icon="popOut"
                  label="Screen size"
                  onPress={() => setSheet('display')}
                />
                <IconButton icon="more" label="More options" onPress={() => setSheet('more')} />
              </View>
            </View>
          </View>
        </View>
      ) : null}

      <ChoiceDialog
        visible={sheet === 'speed'}
        title="Playback speed"
        choices={SPEEDS}
        selected={String(rate)}
        onSelect={onSelectSpeed}
        onDismiss={() => setSheet('none')}
      />
      <ChoiceDialog
        visible={sheet === 'more'}
        title="Player options"
        choices={moreChoices}
        selected=""
        onSelect={onSelectMore}
        onDismiss={() => setSheet('none')}
        closeOnSelect={false}
        // Every row here opens another sheet; none of them is a choice.
        navigates
      />
      {/*
        The single display-mode sheet.

        There were two of these bound to `sheet === 'display'`, titled "Display
        mode" and "Screen size". The second rendered over the first, so the
        first could never be seen — dead UI that only made the choice harder to
        find in the source. The title kept here is the one the button
        advertises, and it now marks the mode actually in force.
      */}
      <ChoiceDialog
        visible={sheet === 'display'}
        title="Screen size"
        choices={displayChoices}
        selected={currentDisplayMode}
        onSelect={onSelectDisplay}
        onDismiss={() => setSheet('none')}
      />
      <ChoiceDialog
        visible={sheet === 'sleep'}
        title="Sleep Timer"
        choices={sleepChoices}
        selected={sleepMinutes == null ? '' : String(sleepMinutes)}
        onSelect={(v) => {
          setSleepMinutes(Number(v));
          setSheet('none');
        }}
        onDismiss={() => setSheet('none')}
      />
      <AudioSubtitleSheet
        visible={sheet === 'tracks'}
        audioChoices={audioChoices}
        subChoices={subChoices}
        selectedAudio={audioIndex == null ? '' : String(audioIndex)}
        selectedSub={textIndex == null ? 'off' : String(textIndex)}
        onPickAudio={(v) => setAudioIndex(Number(v))}
        onPickSub={(v) => setTextIndex(v === 'off' ? null : Number(v))}
        onClose={() => setSheet('none')}
      />
    </View>
  );
}
/**
 * Audio & Subtitle window.
 *
 * One window holding both lists side by side: AUDIO on the left, SUBTITLE on the
 * right, separated by a vertical divider, with the heading above each column.
 * Tapping a row selects it and the window STAYS OPEN, so switching between an
 * audio and a subtitle track is one tap each rather than reopen-per-choice.
 *
 * NOTE: the reference images for this window ("subtitile1" / "subtitile2") were
 * not present in the project folder or anywhere on the machine, so this follows
 * the written description rather than the artwork.
 */
function AudioSubtitleSheet({
  visible,
  audioChoices,
  subChoices,
  selectedAudio,
  selectedSub,
  onPickAudio,
  onPickSub,
  onClose,
}: {
  visible: boolean;
  audioChoices: Choice[];
  subChoices: Choice[];
  selectedAudio: string;
  selectedSub: string;
  onPickAudio: (v: string) => void;
  onPickSub: (v: string) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <TouchableOpacity activeOpacity={1} style={[styles.asBackdrop, { backgroundColor: t.overlay }]} onPress={onClose}>
        <View style={[styles.asCard, { backgroundColor: t.bg3, shadowColor: t.shadow }]}>
          <Text style={[styles.asTitle, { color: t.text }]}>Audio &amp; Subtitle</Text>

          <View style={styles.asColumns}>
            {/* AUDIO */}
            <View style={styles.asColumn}>
              <Text style={[styles.asHeading, { color: t.dim }]}>AUDIO</Text>
              <ScrollView bounces={false} style={styles.asList}>
                {audioChoices.map((c) => (
                  <TouchableOpacity
                    key={`a-${c.value}`}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: c.value === selectedAudio }}
                    accessibilityLabel={c.label}
                    style={[
                      styles.asRow,
                      { backgroundColor: c.value === selectedAudio ? t.accent : 'transparent' },
                    ]}
                    onPress={() => onPickAudio(c.value)}
                  >
                    <Text
                      style={[styles.asLabel, { color: c.value === selectedAudio ? t.bg : t.text }]}
                      numberOfLines={2}
                    >
                      {c.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            {/* Divider */}
            <View style={[styles.asDivider, { backgroundColor: t.border }]} />

            {/* SUBTITLE */}
            <View style={styles.asColumn}>
              <Text style={[styles.asHeading, { color: t.dim }]}>SUBTITLE</Text>
              <ScrollView bounces={false} style={styles.asList}>
                {subChoices.map((c) => (
                  <TouchableOpacity
                    key={`s-${c.value}`}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: c.value === selectedSub }}
                    accessibilityLabel={c.label}
                    style={[
                      styles.asRow,
                      { backgroundColor: c.value === selectedSub ? t.accent : 'transparent' },
                    ]}
                    onPress={() => onPickSub(c.value)}
                  >
                    <Text
                      style={[styles.asLabel, { color: c.value === selectedSub ? t.bg : t.text }]}
                      numberOfLines={2}
                    >
                      {c.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </View>

          <View style={styles.asActions}>
            <TouchableOpacity accessibilityRole="button" onPress={onClose}>
              <Text style={[styles.asCloseText, { color: t.accent }]}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

/**
 * Screen lock, drawn as an UNO-Reverse-style symbol.
 *
 * The "reverse" body is an outlined oval with the two pointed ends, and the lock
 * glyph fades and scales in INSIDE it once locked. The body itself never moves,
 * so the button reads as the same control in both states — only its contents
 * change. The transition is a spring on scale plus a fade, on the native driver.
 */
function UnoLockButton({ locked, onPress }: { locked: boolean; onPress: () => void }) {
  const anim = useRef(new Animated.Value(locked ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: locked ? 1 : 0,
      // No bounciness: this must read as a smooth swap, not a toy press.
      stiffness: 220,
      damping: 22,
      mass: 0.6,
      useNativeDriver: true,
    }).start();
  }, [locked, anim]);

  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const opacity = anim;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={locked ? 'Unlock the screen' : 'Lock the screen'}
      accessibilityState={{ selected: locked }}
      style={styles.iconBtn}
      hitSlop={8}
      onPress={onPress}
    >
      <View style={styles.unoBody}>
        <View style={styles.unoTipLeft} />
        <View style={styles.unoTipRight} />
        <Animated.View style={[styles.unoLockSlot, { opacity, transform: [{ scale }] }]}>
          <Icon name="lock" size={16} color="#fff" />
        </Animated.View>
      </View>
    </TouchableOpacity>
  );
}

/** Small helper buttons used by the overlay. Icons only, per the reference. */
function IconButton({
  icon,
  label,
  onPress,
  active,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  const t = useTheme();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      style={styles.iconBtn}
      hitSlop={10}
      onPress={onPress}
    >
      {/* Oversized on purpose: these four controls were easy to miss at 19. */}
      <Icon name={icon} size={30} color={active ? t.accent : 'rgba(255,255,255,0.95)'} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  stage: { position: 'absolute', top: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  video: { width: '100%', height: '100%' },

  errorLayer: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  errorTitle: { fontSize: 15, fontWeight: '700', marginBottom: 6 },
  errorText: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  errorHint: { fontSize: 12, marginTop: 10, textAlign: 'center' },
  /** Wraps the hint so it can be pressed when there is an action to offer. */
  errorHintButton: { paddingVertical: 6, paddingHorizontal: 12 },
  errorHintLink: { textDecorationLine: 'underline', fontWeight: '600' },

  hud: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  /**
   * No background, no border, no card — the readout floats straight on the
   * picture. A panel here used to be a black box with a second grey bar drawn
   * inside it, and because the label is centred on a `minWidth` the whole
   * thing visibly changed size as the number grew ("Volume 8%" against
   * "Volume 100%"). The fixed width below removes that reflow.
   */
  hudBubble: {
    alignItems: 'center',
    gap: 14,
  },
  hudText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '300',
    letterSpacing: 0.5,
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowRadius: 10,
    textShadowOffset: { width: 0, height: 2 },
  },
  /**
   * A FIXED width for the level readouts only.
   *
   * This is the last thing that could change size: "Muted" and "Volume 100%"
   * have very different intrinsic widths, so with a natural-width label the
   * readout visibly grew and shrank as you dragged. A constant width keeps the
   * whole indicator identical at every level.
   *
   * It deliberately applies only to volume/brightness. Error messages are much
   * longer, and a fixed box clipped them ("Brightness is not available on this
   * device" became "Brightness is not availa..."), so they keep natural width.
   */
  hudTextFixed: { width: 250, textAlign: 'center' },
  /**
   * Fixed-size rail. Its height is a constant, never derived from the level, so
   * the slider cannot change size while the finger moves.
   */
  hudTrack: {
    width: 4,
    height: HUD_TRACK,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  /**
   * The handle. Deliberately wider than the rail and NOT clipped by it, which is
   * what makes it read as a slider sitting on a track.
   */
  hudThumb: {
    position: 'absolute',
    bottom: 0,
    left: (4 - HUD_THUMB) / 2,
    width: HUD_THUMB,
    height: HUD_THUMB,
    borderRadius: HUD_THUMB / 2,
    backgroundColor: '#fff',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },

  asBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  asCard: {
    width: '100%',
    maxWidth: 460,
    borderRadius: 6,
    paddingVertical: 6,
    elevation: 12,
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  asTitle: { fontSize: 18, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 },
  asColumns: { flexDirection: 'row', paddingHorizontal: 12 },
  asColumn: { flex: 1 },
  asHeading: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textAlign: 'center',
    paddingBottom: 8,
  },
  asDivider: { width: StyleSheet.hairlineWidth, marginHorizontal: 8 },
  asList: { maxHeight: 240, paddingBottom: 8 },
  asRow: {
    paddingHorizontal: 10,
    paddingVertical: 11,
    borderRadius: 4,
    marginBottom: 4,
  },
  asLabel: { fontSize: 15, textAlign: 'center' },
  asActions: { alignItems: 'flex-end', paddingHorizontal: 10, paddingVertical: 6 },
  asCloseText: { fontSize: 15, fontWeight: '600', paddingHorizontal: 12, paddingVertical: 8 },

  lockLayer: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  lockButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockHint: { color: '#fff', fontSize: 12, fontWeight: '600' },

  /**
   * One constant veil across the entire picture.
   *
   * 0.44 is the midpoint of the old top (0.42) and bottom (0.46) scrims, so the
   * overall brightness of the controls' background is unchanged while the
   * lighter middle band disappears completely.
   */
  uniformScrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.44)',
  },

  topRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
  },
  backHit: { paddingVertical: 8, paddingRight: 10, marginLeft: -4 },
  stageTitle: {
    flex: 1,
    color: '#fff',
    // Display size, thin weight, two lines — the title is a headline in the
    // reference, not a status-bar-sized label.
    fontSize: 34,
    fontWeight: '300',
    lineHeight: 40,
    letterSpacing: 0.2,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowRadius: 8,
    textShadowOffset: { width: 0, height: 2 },
  },
  titleCenter: { textAlign: 'center' },
  titleLeft: { textAlign: 'left' },

  /** Outlined play control, as in both references — no filled disc. */
  playRing: {
    width: 66,
    height: 66,
    borderRadius: 33,
    borderWidth: 2.5,
    borderColor: 'rgba(255,255,255,0.92)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },

  bottomBlock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingBottom: 14,
    gap: 4,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  timeText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 5,
  },
  timeRight: { textAlign: 'right' },
  railRow: { alignItems: 'center', marginTop: -2 },
  iconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  /** The two marks either side of the play control, spaced like the reference. */
  iconPair: { flexDirection: 'row', alignItems: 'center', gap: 34 },
  // Bigger hit area to match the bigger glyph, and comfortably above the 44dp
  // minimum touch target.
  iconBtn: {
    width: 46,
    height: 46,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** UNO-Reverse-style outline: an oval with the two pointed ends. */
  unoBody: {
    width: 34,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  unoTipLeft: {
    position: 'absolute',
    left: -9,
    width: 0,
    height: 0,
    borderTopWidth: 6,
    borderBottomWidth: 6,
    borderRightWidth: 9,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderRightColor: 'rgba(255,255,255,0.95)',
  },
  unoTipRight: {
    position: 'absolute',
    right: -9,
    width: 0,
    height: 0,
    borderTopWidth: 6,
    borderBottomWidth: 6,
    borderLeftWidth: 9,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: 'rgba(255,255,255,0.95)',
  },
  unoLockSlot: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The big level symbol under the rail. */
  hudIcon: {
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowRadius: 12,
    textShadowOffset: { width: 0, height: 2 },
  },
});
