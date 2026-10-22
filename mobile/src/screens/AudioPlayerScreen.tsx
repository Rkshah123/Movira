import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  StatusBar,
  Share,
  Animated,
  useWindowDimensions,
  findNodeHandle,
} from 'react-native';
import type { GestureResponderEvent } from 'react-native';
import { formatTime } from '@shared';
import { useAppState } from '../state/AppContext';
import { useNav } from '../state/NavContext';
import { useTheme, metrics } from '../theme';
import Icon from '../ui/Icon';
import { getVolume, setVolume, setViewBlur } from '../system';
import { TrackSlider } from '../ui/Controls';
import EmptyState from '../ui/EmptyState';
import ActionSheet from '../ui/ActionSheet';
import ChoiceDialog, { type Choice } from '../ui/ChoiceDialog';
import { useStatusBarInset } from '../ui/TopBar';

const LOGO = require('../assets/movira_logo.png');

/**
 * Hidden vertical volume gesture.
 *
 * Up increases the volume, down decreases it, and there is deliberately no
 * volume control anywhere on this screen.
 *
 * The cylinder: a tall rounded capsule with the level in it and a slim bar
 * beneath. It is the focal object — opaque, so it reads crisply against the
 * softened player behind it and gives the eye something hard-edged to measure the
 * rest of the screen against.
 *
 * Sized generously so the readout has room and the bar is long enough to read at
 * a glance, while the proportion stays a cylinder rather than a panel: roughly
 * 2.8 : 1.
 */
const CYL_WIDTH = 100;
const CYL_MIN_HEIGHT = 268;
/** Half the width: a fully rounded vertical capsule, i.e. a cylinder. */
const CYL_RADIUS = CYL_WIDTH / 2;

/**
 * How far below the logo tile's centre the cylinder sits.
 *
 * The tile's centre is above the middle of the screen, which left the cylinder
 * sitting a little high. Dropping it a couple of dozen dp keeps it over the
 * artwork while settling into the optical centre of the player, where the eye
 * reads the composition as balanced. Deliberately a nudge, not a move.
 */
const CYL_DROP = 28;

/**
 * The bar inside it.
 *
 * Slim on purpose, and it stays slim as the cylinder grows: the cylinder supplies
 * the mass and the legibility, so the bar only has to show where the level is. A
 * bar that thickened along with the cylinder would swamp the readout and read as
 * bulky. The extra room goes into the bar's LENGTH instead, which makes the level
 * easier to judge without making the control any heavier.
 */
const BAR_WIDTH = 12;
const BAR_HEIGHT = 180;
const BAR_RADIUS = BAR_WIDTH / 2;

/** A drag shorter than this is a stray finger, not a volume gesture. */
const DRAG_THRESHOLD = 12;

/** Fade timings. Short enough that the readout never lingers after the finger lifts. */
const FADE_IN_MS = 130;
const FADE_OUT_MS = 220;

/**
 * Grace period between letting go and the overlay fading away.
 *
 * Without it the cylinder vanished so fast that a quick nudge to raise the volume
 * flashed and was gone before it could be read, which reads as a glitch rather
 * than as feedback.
 */
const HOLD_AFTER_RELEASE_MS = 750;

/**
 * Blur radius applied to the player content behind the cylinder.
 *
 * Kept small deliberately, and this is the fix for "the background looks like it
 * shrinks". A Gaussian blur spreads every edge outward, so at a large radius the
 * artwork tile's border smears away and its boundary becomes ambiguous — the
 * eye then reads the softened shape as a smaller, inset version of itself.
 * Measured on device at radius 9: the blurred tile came out 36px WIDER than the
 * sharp one, so nothing was scaling; the shape was just losing its edges. A
 * gentle blur keeps every boundary readable, and the player's real geometry is
 * untouched — the blur is a GPU filter on the view, and it cannot move or resize
 * a single pixel of layout.
 *
 * There is deliberately NO dark veil on top. The veil was what flattened the
 * whole screen into one dark field and gave the strongest impression of a
 * separate, inset layer; the opaque cylinder already supplies the contrast.
 */
const BLUR_RADIUS = 7;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

const SPEEDS: Choice[] = [
  { label: '0.5x', value: '0.5' },
  { label: '0.75x', value: '0.75' },
  { label: '1x', value: '1' },
  { label: '1.25x', value: '1.25' },
  { label: '1.5x', value: '1.5' },
  { label: '2x', value: '2' },
];

const SLEEP_TIMERS: Choice[] = [
  { label: '5 minutes', value: '5' },
  { label: '10 minutes', value: '10' },
  { label: '15 minutes', value: '15' },
  { label: '30 minutes', value: '30' },
  { label: '45 minutes', value: '45' },
  { label: '60 minutes', value: '60' },
];

/**
 * Audio Now Playing, matching the audio reference screens.
 *
 * Layout, top to bottom: a chevron-down dismiss on the left, a COVER / LYRIC
 * pill in the centre and the overflow menu on the right; the album artwork as a
 * large rounded tile; the title on the left with the download and heart actions
 * on the right; the artist beneath; the scrubber with elapsed / total times at
 * each end; and finally the transport row.
 *
 * The heart is the ONLY favourite control in this UI — it carries the exact
 * `toggleFavorite` behaviour the overflow entry used to, so nothing is lost by
 * removing that menu row.
 */
export default function AudioPlayerScreen() {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();
  const statusInset = useStatusBarInset();

  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheet, setSheet] = useState<'speed' | 'sleep' | null>(null);

  // --- hidden volume gesture ----------------------------------------------
  const { height } = useWindowDimensions();

  /** Only mounted while a volume drag is in flight (plus its hold and fade-out). */
  const [hud, setHud] = useState<{ text: string } | null>(null);
  const hudFade = useRef(new Animated.Value(0)).current;
  /**
   * Drives the filled bar on its own, WITHOUT re-rendering React.
   *
   * The bar follows the finger 1:1, so it needs no timing animation — only a
   * value update per move. Keeping it off component state is what stops the whole
   * player from re-rendering on every frame of the drag.
   */
  const hudLevel = useRef(new Animated.Value(0)).current;
  /** True level, read by the gesture and written by the move handler. */
  const levelRef = useRef(1);
  const gesture = useRef({ startY: 0, base: 1, active: false });
  /** Last label pushed to state, so state only changes when it really does. */
  const lastLabel = useRef('');
  /** Whether the fade-in is currently running, so it is not restarted per move. */
  const hudShown = useRef(false);
  /** Pending fade-out after the finger lifts. */
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The player content, which is the subtree pushed out of focus behind the bar.
   *
   * `collapsable={false}` is required: without a native node the view has no tag
   * and there is nothing to address the blur at.
   */
  const contentRef = useRef<View>(null);
  /** React tag of that subtree, resolved lazily so it is only read once it exists. */
  const contentTag = useRef<number | null>(null);
  /** True once a real blur is applied, so it is known whether it must be taken off. */
  const blurActive = useRef(false);

  /**
   * Vertical centre of the Movira logo tile, in the root's coordinate space.
   *
   * The bar is centred here rather than on the window's middle, so the overlay
   * lands on the artwork the eye is already on. Both numbers are measured rather
   * than hard-coded: the tile centre from its own layout, and the root height from
   * the root's. The root sits BELOW the status bar (the shell insets it), so its
   * middle is not the window's middle — using the window height here left the
   * bar sitting visibly low.
   */
  const [logoCentreY, setLogoCentreY] = useState<number | null>(null);
  const [rootHeight, setRootHeight] = useState(0);

  const current = app.current;
  const duration = app.progress.duration;
  const time = app.progress.time;

  // Start from the volume the phone is actually on, so the first swipe adjusts
  // from the real level rather than jumping to full.
  useEffect(() => {
    let alive = true;
    void getVolume()
      .then((v) => {
        if (alive) levelRef.current = v;
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /** Turns the blur on the player content on or off, and forgets it when it fails. */
  const applyBlur = useCallback((on: boolean) => {
    if (!on && !blurActive.current) return;
    const node = contentRef.current;
    if (!node) return;
    if (contentTag.current == null) {
      const tag = findNodeHandle(node);
      if (tag == null) return;
      contentTag.current = tag;
    }
    void setViewBlur(contentTag.current, on ? BLUR_RADIUS : 0)
      .then((ok) => {
        // A refused blur (API < 31, or the view could not be resolved) must not
        // leave the flag set, or the matching removal would be attempted forever.
        blurActive.current = on && ok;
      })
      .catch(() => {
        blurActive.current = false;
      });
  }, []);

  // Whatever happens to the screen, take the blur and the veil back off: leaving
  // a RenderEffect on the content would keep the player soft for the whole session.
  useEffect(
    () => () => {
      hudFade.stopAnimation();
      if (hideTimer.current) clearTimeout(hideTimer.current);
      const node = contentRef.current;
      if (blurActive.current && node && contentTag.current != null) {
        void setViewBlur(contentTag.current, 0);
      }
      blurActive.current = false;
    },
    [hudFade]
  );

  const hideHud = useCallback(() => {
    gesture.current.active = false;
    hudShown.current = false;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    // The overlay is kept up for a beat after the finger leaves so a quick nudge
    // can be read; only then does it fade.
    hideTimer.current = setTimeout(() => {
      Animated.timing(hudFade, {
        toValue: 0,
        duration: FADE_OUT_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        // Unmount only if this fade was not superseded by a newer one — otherwise
        // lifting and immediately starting a new drag would unmount the fresh HUD.
        if (!finished || hudShown.current) return;
        setHud(null);
        // The blur comes off with the veil, so the player sharpens as it clears.
        applyBlur(false);
      });
    }, HOLD_AFTER_RELEASE_MS);
  }, [applyBlur, hudFade]);

  const showHud = useCallback(
    (text: string) => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      if (lastLabel.current !== text) {
        lastLabel.current = text;
        setHud({ text });
      }
      // Restart the fade-in only when it is not already showing, so a continuous
      // drag does not restart the animation on every single move.
      if (!hudShown.current) {
        hudShown.current = true;
        applyBlur(true);
        hudFade.setValue(0);
        Animated.timing(hudFade, { toValue: 1, duration: FADE_IN_MS, useNativeDriver: true }).start();
      }
    },
    [applyBlur, hudFade]
  );

  const applyVolume = useCallback(
    (dy: number) => {
      // Finger moving UP is a negative dy and must raise the level, hence the
      // inversion. The span is most of the screen so the gesture never needs a
      // long, twitchy swipe to cross the full range.
      const span = Math.max(160, height * 0.7);
      const next = clamp01(gesture.current.base - dy / span);
      levelRef.current = next;
      hudLevel.setValue(next);
      showHud(next <= 0.001 ? 'Muted' : `${Math.round(next * 100)}%`);
      // Applied continuously so the volume tracks the finger. A native failure is
      // logged, never surfaced: the audio engine is system-routed and there is
      // nothing useful the user could do about it mid-swipe.
      void setVolume(next).catch((err) => {
        console.warn('Movira: could not set volume', err);
      });
    },
    [height, hudLevel, showHud]
  );

  /**
   * The gesture must not fire while a menu owns the screen — otherwise a swipe
   * on a sheet's backdrop would change the volume behind the user's back.
   */
  const gestureEnabled = !sheetOpen && sheet === null;

  const onVolumeGrant = useCallback((e: GestureResponderEvent) => {
    gesture.current.startY = e.nativeEvent.pageY;
    gesture.current.base = levelRef.current;
    gesture.current.active = false;
  }, []);

  const onVolumeMove = useCallback(
    (e: GestureResponderEvent) => {
      const dy = e.nativeEvent.pageY - gesture.current.startY;
      // Wait for a deliberate vertical travel before showing anything, so a tap
      // (which is what every button on this screen is) never flashes the HUD.
      if (!gesture.current.active) {
        if (Math.abs(dy) <= DRAG_THRESHOLD) return;
        gesture.current.active = true;
      }
      applyVolume(dy);
    },
    [applyVolume]
  );

  // The displayed position stays on the target until the engine arrives, so a
  // seek does not snap back to the stale position the instant the finger lifts.
  useEffect(() => {
    if (seekPreview === null) return;
    if (Math.abs(time - seekPreview) < 0.75) {
      setSeekPreview(null);
      return;
    }
    const timer = setTimeout(() => setSeekPreview(null), 6000);
    return () => clearTimeout(timer);
  }, [time, seekPreview]);

  // Sleep timer: stop playback once the chosen number of minutes elapses.
  const [sleepMinutes, setSleepMinutes] = useState<number | null>(null);
  useEffect(() => {
    if (sleepMinutes == null) return;
    const stopAt = setTimeout(() => {
      void app.services.engine.stop();
      setSleepMinutes(null);
    }, sleepMinutes * 60 * 1000);
    return () => clearTimeout(stopAt);
  }, [sleepMinutes, app.services.engine]);

  if (!current) {
    return (
      // `styles.root` no longer carries the screen padding (it moved onto the
      // blurred content wrapper), so it is applied here to keep this identical.
      <View style={[styles.root, styles.content, { backgroundColor: t.bg }]}>
        <EmptyState message="Nothing is playing yet." />
      </View>
    );
  }

  const shown = seekPreview ?? time;
  const isFav = app.isFavorite(current.id);

  return (
    <View
      style={[styles.root, { backgroundColor: t.bg }]}
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        setRootHeight((prev) => (prev === h ? prev : h));
      }}
      /*
       * The volume gesture lives on the root rather than on a full-screen
       * overlay: an overlay would have to sit above the controls and would
       * swallow their taps. React Native asks the DEEPEST view first, so every
       * button, the heart and the scrubber still claim their own touch and only
       * the empty background falls through to here. Nothing about the existing
       * layout changes — these are responder props, not layout.
       */
      onStartShouldSetResponder={() => gestureEnabled}
      onResponderTerminationRequest={() => true}
      onResponderGrant={onVolumeGrant}
      onResponderMove={onVolumeMove}
      onResponderRelease={hideHud}
      onResponderTerminate={hideHud}
    >
      <StatusBar barStyle={t.dark ? 'light-content' : 'dark-content'} backgroundColor={t.bg} />

      {/*
        Everything the volume bar dims and blurs.

        This wrapper exists only so the blur has one subtree to address, which is
        why it is `collapsable={false}` — a collapsed view has no native node and
        therefore no tag. It carries `flex: 1` and nothing else, so its children
        lay out exactly as they did inside the root.
      */}
      <View ref={contentRef} collapsable={false} style={styles.content}>
        {/* Top row: dismiss on the left, overflow on the right. */}
        <View style={[styles.topRow, { paddingTop: statusInset + 6, backgroundColor: t.bg }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Minimise player"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={() => nav.pop()}
        >
          <Icon name="chevronDown" size={28} color={t.text} />
        </TouchableOpacity>

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="More options"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={() => setSheetOpen(true)}
        >
          <Icon name="overflow" size={26} color={t.text} />
        </TouchableOpacity>
      </View>

      {/* Artwork. */}
      <View
        style={[styles.art, { backgroundColor: t.bg2 }]}
        onLayout={(e) => {
          // Measured so the volume bar can centre itself on the logo tile rather
          // than on a hard-coded offset that would drift with screen size.
          const { y, height: h } = e.nativeEvent.layout;
          setLogoCentreY((prev) => (prev === y + h / 2 ? prev : y + h / 2));
        }}
      >
        {current.artwork ? (
          <Image source={{ uri: current.artwork }} style={styles.artImage} resizeMode="cover" />
        ) : (
          <Image source={LOGO} style={styles.artLogo} resizeMode="contain" />
        )}
      </View>

      {/* Title + download + heart, then the artist. */}
      <View style={styles.meta}>
        <Text style={[styles.title, { color: t.text }]} numberOfLines={1}>
          {current.title}
        </Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Download"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={() =>
            void Share.share({ message: current.path, title: current.title }).catch(() => {})
          }
        >
          <Icon name="download" size={24} color={t.text} />
        </TouchableOpacity>
        {/*
          The heart is the only favourite control here. It carries the same
          `toggleFavorite` the overflow row used to, and fills red once the item
          is a favourite.
        */}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={isFav ? 'Remove from favourites' : 'Add to favourites'}
          accessibilityState={{ selected: isFav }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={() => app.toggleFavorite(current)}
        >
          <Icon name="heart" size={26} color={isFav ? '#e5484d' : t.text} />
        </TouchableOpacity>
      </View>
      <Text style={[styles.artist, { color: t.dim }]} numberOfLines={1}>
        {current.artist ?? (current.type === 'video' ? 'Video' : 'Unknown artist')}
      </Text>

      {/* Scrubber with elapsed / total at each end. */}
      <View style={styles.scrub}>
        <TrackSlider
          value={Math.min(shown, duration || 1)}
          onChange={(v) => setSeekPreview(v)}
          onCommit={(v) => {
            app.seek(v);
            app.setProgress({ time: v, duration });
          }}
          min={0}
          max={Math.max(duration, 1)}
          step={0.1}
          width={Math.min(360, 340)}
        />
        <View style={styles.times}>
          <Text style={[styles.time, { color: t.dim }]}>{formatTime(shown)}</Text>
          <Text style={[styles.time, { color: t.dim }]}>{formatTime(duration)}</Text>
        </View>
      </View>

      {/* Transport: shuffle, previous, play/pause, next, queue. */}
      <View style={styles.transport}>
        <TransportButton
          icon="shuffle"
          label="Shuffle"
          active={app.queue.shuffle}
          onPress={() => {
            app.services.player.toggleShuffle();
          }}
        />
        <TransportButton icon="prev" label="Previous" size={30} onPress={app.previous} />
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={app.playing ? 'Pause' : 'Play'}
          style={styles.playRing}
          onPress={app.togglePlayPause}
        >
          <Icon name={app.playing ? 'pause' : 'play'} size={30} color={t.text} />
        </TouchableOpacity>
        <TransportButton icon="next" label="Next" size={30} onPress={app.next} />
        <TransportButton
          icon="queue"
          label="Up next"
          onPress={() => {
            nav.pop();
            nav.setTab('playlists');
          }}
        />
      </View>
      </View>

      {/*
        Overflow menu, matching the audio reference sheet: the same seven
        options in the same order. Favorite is deliberately absent — the heart on
        the main screen is the only favourite control.
      */}
      <ActionSheet
        visible={sheetOpen}
        title={current.title}
        onDismiss={() => setSheetOpen(false)}
        actions={[
          { label: 'Sleep Timer', icon: 'timer', onPress: () => setSheet('sleep') },
          { label: 'Speed', icon: 'speed', onPress: () => setSheet('speed') },
          {
            label: 'Equalizer',
            icon: 'sliders',
            onPress: () => {
              nav.pop();
              nav.push({ name: 'equalizer' });
            },
          },
          {
            label: 'Add to Playlist',
            icon: 'playlist',
            onPress: () => {
              // There is no "choose a playlist" route in this app, so this
              // lands on the playlist list where one can be picked or created.
              nav.popToShell();
              nav.setTab('playlists');
            },
          },
          { label: 'Song Info', icon: 'info', onPress: () => {} },
          { label: 'Set as Ringtone', icon: 'ringtone', onPress: () => {} },
          {
            label: 'Share file',
            icon: 'share',
            onPress: () => void Share.share({ message: current.path, title: current.title }).catch(() => {}),
          },
        ]}
      />

      <ChoiceDialog
        visible={sheet === 'speed'}
        title="Speed"
        choices={SPEEDS}
        selected="1"
        onSelect={(v) => app.services.engine.setRate(Number(v))}
        onDismiss={() => setSheet(null)}
      />
      <ChoiceDialog
        visible={sheet === 'sleep'}
        title="Sleep Timer"
        choices={SLEEP_TIMERS}
        selected={sleepMinutes == null ? '' : String(sleepMinutes)}
        onSelect={(v) => {
          setSleepMinutes(Number(v));
          setSheet(null);
        }}
        onDismiss={() => setSheet(null)}
      />

      {/*
        Volume feedback.

        Rendered ONLY while a volume drag is in flight (plus its short hold and
        fade), so it can never sit on the screen permanently, and
        `pointerEvents="none"` keeps it from swallowing any touch of its own.

        It sits OUTSIDE the blurred content wrapper, which is what lets the player
        behind it go soft while the cylinder stays sharp. The player itself is
        never unmounted, re-created, moved or re-laid-out — only filtered.
      */}
      {hud ? (
        <Animated.View pointerEvents="none" style={[styles.hud, { opacity: hudFade }]}>
          <View style={styles.hudCentre}>
            {/* The cylinder: a tall rounded capsule holding the readout and the bar. */}
            <View
              style={[
                styles.hudCyl,
                // Flexbox centres this on the root; it is then shifted onto the
                // logo tile's middle and nudged down by CYL_DROP from there.
                logoCentreY != null && rootHeight > 0
                  ? {
                      transform: [
                        { translateY: logoCentreY - rootHeight / 2 + CYL_DROP },
                      ],
                    }
                  : null,
              ]}
            >
              {/*
                The level. `minWidth` stops it reflowing between "Muted" and
                "100%", which would otherwise make the cylinder's contents jitter.
              */}
              <Text style={styles.hudValue} numberOfLines={1} allowFontScaling={false}>
                {hud.text}
              </Text>

              {/*
                The slider. The track is a FIXED height and only the fill inside it
                changes, so nothing resizes as the level moves.
              */}
              <View style={styles.hudBar}>
                <Animated.View
                  style={[
                    styles.hudBarFill,
                    {
                      height: hudLevel.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, BAR_HEIGHT],
                      }),
                    },
                  ]}
                />
              </View>
            </View>
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

function TransportButton({
  icon,
  label,
  onPress,
  active,
  size = 22,
}: {
  icon: 'shuffle' | 'prev' | 'next' | 'queue';
  label: string;
  onPress: () => void;
  active?: boolean;
  size?: number;
}) {
  const t = useTheme();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      style={styles.transportBtn}
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
      onPress={onPress}
    >
      <Icon name={icon} size={size} color={active ? t.accent : t.text} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 10,
  },
  art: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  artImage: { width: '100%', height: '100%' },
  artLogo: { width: '46%', height: '46%', opacity: 0.9 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 20 },
  title: { fontSize: 21, fontWeight: '700', flex: 1 },
  artist: { fontSize: 14.5, marginTop: 6 },
  scrub: { marginTop: 22 },
  times: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 6, marginTop: 2 },
  time: { fontSize: 11.5, fontVariant: ['tabular-nums'] },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 26,
    marginBottom: 26,
    paddingHorizontal: 6,
  },
  transportBtn: { padding: 6 },
  /** The reference shows the play control as an outlined ring, not a filled dot. */
  playRing: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 2,
    borderColor: '#e8ebf2',
    alignItems: 'center',
    justifyContent: 'center',
  },

  /**
  * The wrapper that carries the player content, and the thing the volume blur is
  * applied to.
 *
 * It holds the screen padding that used to sit on the root, and it is
 * `collapsable={false}` because a collapsed view has no native node and therefore
 * no tag to address a blur at.
 *
 * Moving the padding here is what makes the blur full-bleed. With it on the root,
 * the blurred subtree began inside the side padding, so the leftmost and
 * rightmost ~16dp stayed sharp while everything between them went soft. Those two
 * crisp vertical strips framed the blurred area and made it read as a separate
 * inset layer. The children lay out exactly as before — same padding value, same
 * `flex: 1`, only one level down — and the blurred subtree now spans the full
 * screen width.
 */
content: { flex: 1, paddingHorizontal: metrics.screenPadding },

  /**
   * Full-screen layer that hosts the volume overlay.
   *
   * `hudCentre` centres the slider on the root, and the slider is then shifted
   * onto the logo tile. Keeping that shift on the slider rather than on this
   * container is deliberate: `hudFade` animates `opacity` on the native driver
   * here, and a static `transform` on a child cannot conflict with that.
   */
  hud: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
  },
  hudCentre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  /**
   * The cylinder: a tall rounded capsule.
   *
   * Near-opaque and completely borderless. The `borderWidth`/`borderColor` pair is
   * deliberately absent — an outline traced the capsule against the blurred
   * artwork and read as a framed dialog rather than a soft cylinder. Shape and
   * contrast alone carry it.
   */
  hudCyl: {
    width: CYL_WIDTH,
    minHeight: CYL_MIN_HEIGHT,
    borderRadius: CYL_RADIUS,
    paddingTop: 30,
    paddingBottom: 30,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(23,25,31,0.95)',
    elevation: 16,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  hudValue: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
    marginBottom: 18,
    // Fixed width so the readout never reflows between "Muted" and "100%".
    minWidth: CYL_WIDTH - 28,
    textAlign: 'center',
  },
  /**
   * The track. Fixed width and height, so neither the bar nor anything above it
   * changes size while the level moves.
   */
  hudBar: {
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    borderRadius: BAR_RADIUS,
    backgroundColor: 'rgba(255,255,255,0.26)',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  /** Grows from the bottom, like the native volume fill. */
  hudBarFill: {
    width: BAR_WIDTH,
    borderRadius: BAR_RADIUS,
    backgroundColor: '#fff',
  },
});
