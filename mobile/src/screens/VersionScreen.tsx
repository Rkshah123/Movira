import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useNav } from '../state/NavContext';
import { useTheme, type SparklePalette } from '../theme';
import Icon from '../ui/Icon';

const LOGO = require('../assets/movira_logo.png');

/** Size of the square stage the logo lives on. */
const STAGE = 260;

/** The four sparkles requested for this screen, each with its own MDI glyph. */
type Glyph = 'sixPointSparkle' | 'sparkles' | 'glowingStar' | 'twinkle';

/** The four glyphs, in palette-slot order. */
const SHAPES: Glyph[] = ['sixPointSparkle', 'sparkles', 'glowingStar', 'twinkle'];

/**
 * Glow shells drawn behind every glyph: copies of the SAME glyph, scaled up and
 * tinted with the theme's glow colour, so the bloom follows the sparkle's own
 * silhouette rather than sitting inside a hard-edged disc.
 *
 * Two shells, not three — every shell is a real animated view, and they all
 * animate at once. Small sparkles use only the first entry; see RICH_MIN_SIZE.
 *
 * The scale here is STATIC. The particle already scales 0.5 → 1 → 0.78, so an
 * extra animated transform on each shell added a native prop update per layer
 * per frame for a bloom pulse you could barely see.
 */
const GLOW_SHELLS: { scale: number; alpha: number }[] = [
  { scale: 1.95, alpha: 0.2 },
  { scale: 1.32, alpha: 0.34 },
];

/**
 * Sparkles alive at once.
 *
 * Each sparkle is 3-5 animated views and they ALL animate at once, so the
 * ceiling is the number of CONCURRENT layers — not how many a single tap adds.
 * Measured on this device: 110 live ran at 40% jank / 48ms median with 65 missed
 * vsyncs; 40 live at 3.6% / 15ms; 22 live at 0.5% / 15ms.
 *
 * This sits between the last two. It only ever bites when taps come faster than
 * sparkles fade, which is exactly when a hard cap is wanted; a single tap always
 * gets its full count.
 */
const MAX_LIVE = 32;

/**
 * Sparkles per tap — about twice the original count.
 *
 * Kept at or under MAX_LIVE so a single tap is never trimmed: overflow is cut
 * from the NEWEST end, so a tap that overflowed would silently lose its own
 * newest stars.
 */
const PER_TAP_MIN = 24;
const PER_TAP_SPREAD = 7;

/**
 * How many sparkles are mounted per frame.
 *
 * Adding them all in ONE commit builds every view node in a single pass, which
 * stalled the main thread badly enough that the burst looked like it never
 * appeared at all. Slicing keeps the first sparkles on screen within a frame or
 * two and spreads the rest across the following frames.
 */
const MOUNT_CHUNK = 3;
const MOUNT_FRAME_MS = 16;

/**
 * Size at which a sparkle gets its second glow shell.
 *
 * Shell count is the main per-particle cost, so the many small ones get a single
 * shell. At this density no sparkle draws a text shadow either: a shadow forces
 * Android onto a software render path, and with dozens of layers animating at
 * once that alone was enough to make the screen stutter. The glow comes from the
 * scaled, low-alpha shell copies, which stay on the GPU.
 */
const RICH_MIN_SIZE = 16;

/**
 * The logo's centre as a fraction of the screen height, and the radius kept
 * clear of sparkles so the logo is never buried.
 */
const LOGO_CENTRE_Y = 0.42;
const LOGO_KEEPOUT = 86;

type Interp = Animated.AnimatedInterpolation<string | number>;

interface Particle {
  key: number;
  /** Absolute screen position of the sparkle centre, in dp. */
  x: number;
  y: number;
  size: number;
  /**
   * Index into the active theme's `sparkles` palette, so switching theme
   * restyles every sparkle with no colour hardcoded here.
   */
  slot: number;
  glyph: Glyph;
  anim: Animated.Value;
  /**
   * How many glow shells this sparkle draws. Small ones get a single shell so
   * the total view count stays affordable at high particle counts.
   */
  shells: number;

  /**
   * Every interpolation, built ONCE when the particle is created.
   *
   * These used to be derived inside render, which meant ~13 `interpolate()`
   * calls per particle on every single re-render — so each tap rebuilt a few
   * hundred animated nodes and the frame cost grew with every burst. These are
   * now created once and reused for the particle's whole life.
   */
  shellScale: number[];
  shellOpacity: Interp[];
  coreOpacity: Interp;
  hotOpacity: Interp;
  hotScale: number;
  translateX: Interp;
  translateY: Interp;
  scale: Interp;
}

function makeParticle(
  key: number,
  x: number,
  y: number,
  size: number,
  slot: number,
  glyph: Glyph
): Particle {
  const anim = new Animated.Value(0);

  /**
   * One value drives the whole sparkle and each layer reads a different slice of
   * that curve:
   *
   *   0 -------- 0.45 --- 1 --- 1.4 ----- 2
   *   invisible  bloom    peak  soft     gone
   *
   * The shells peak slightly BEFORE the glyph and linger slightly after it,
   * which is what makes the effect read as light dissipating rather than a
   * symbol being switched off.
   */
  const layerOpacity = (peak: number, lead: number): Interp =>
    anim.interpolate({
      inputRange: [0, Math.max(0.02, 0.5 - lead), 1, 1.4, 2],
      outputRange: [0, peak * 0.6, peak, peak * 0.92, 0],
    });

  return {
    key,
    x,
    y,
    size,
    slot,
    glyph,
    anim,
    shells: size >= RICH_MIN_SIZE ? GLOW_SHELLS.length : 1,
    // Static multipliers — see GLOW_SHELLS.
    shellScale: GLOW_SHELLS.map((s) => s.scale),
    shellOpacity: GLOW_SHELLS.map((s) => layerOpacity(s.alpha, 0.3)),
    coreOpacity: layerOpacity(1, 0.18),
    hotOpacity: layerOpacity(0.8, 0),
    hotScale: 0.82,
    translateX: anim.interpolate({ inputRange: [0, 1, 2], outputRange: [-5, 0, 7] }),
    translateY: anim.interpolate({ inputRange: [0, 1, 2], outputRange: [-9, 0, 11] }),
    scale: anim.interpolate({ inputRange: [0, 1, 2], outputRange: [0.5, 1, 0.78] }),
  };
}

/**
 * One sparkle.
 *
 * Memoised so that tapping again only mounts the NEW particles: the ones already
 * fading out keep their own tree and are never re-rendered. Without this, every
 * tap re-rendered the whole live set and the cost compounded with each burst.
 */
const Sparkle = React.memo(function Sparkle({
  p,
  pal,
}: {
  p: Particle;
  pal: SparklePalette;
}) {
  const sz = p.size;
  // "Rich" sparkles are the large ones: second glow shell plus a hot centre.
  const rich = p.shells > 1;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.particle,
        {
          left: p.x - sz / 2,
          top: p.y - sz / 2,
          width: sz,
          height: sz,
          // A slow, weightless drift — a few dp only, so a sparkle never appears
          // to rush across the screen.
          transform: [
            { translateX: p.translateX },
            { translateY: p.translateY },
            { scale: p.scale },
          ],
        },
      ]}
    >
      {GLOW_SHELLS.slice(0, p.shells).map((_shell, i) => (
        <Animated.View
          key={i}
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.layer,
            // Opacity and scale live on the SAME view, and the scale is a STATIC
            // number. They used to be split across a nested pair with an animated
            // transform: identical geometry, so the extra view and the per-frame
            // transform update bought nothing.
            { transform: [{ scale: p.shellScale[i] }] },
            { opacity: p.shellOpacity[i] },
          ]}
        >
          <Icon name={p.glyph} size={sz} color={pal.glow} />
        </Animated.View>
      ))}

      {/* Core: the glyph in the theme's bright colour. */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.layer, { opacity: p.coreOpacity }]}
      >
        <Icon name={p.glyph} size={sz} color={pal.core} />
      </Animated.View>

      {/*
       * White-hot centre: a slightly smaller copy over the core.
       *
       * Only the larger sparkles get one. At 10-15px the hot centre is barely a
       * pixel across, so on the small ones it was a whole extra animated view
       * buying nothing — and the small ones are the majority of a big shower.
       */}
      {rich ? (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.layer,
            { transform: [{ scale: p.hotScale }] },
            { opacity: p.hotOpacity },
          ]}
        >
          <Icon name={p.glyph} size={sz} color={pal.hot} />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
});

/**
 * Version screen behind the four-tap activation on
 * Settings → Extra settings → Software version.
 *
 * The logo runs a continuous, organic animation (breathe + sway + float, each
 * on its own period so the loop never looks mechanical).
 *
 * Tapping anywhere scatters a shower of sparkles across the WHOLE screen, spread
 * by stratified sampling rather than pure random so the field reads as even
 * instead of clumping. The motion is unhurried: each eases in, hangs and drifts a
 * little, then dissolves slowly, with no bounce or overshoot anywhere.
 *
 * Performance notes, because this screen used to stutter badly. Every one of these
 * was measured on-device, not guessed:
 *  - one animated value drives a whole sparkle, and all of its interpolations are
 *    built once (see `makeParticle`) rather than during render;
 *  - `Sparkle` is memoised, so a new tap only mounts the new particles;
 *  - NO sparkle draws a text shadow. On Android a shadow forces the software
 *    render path, and with dozens of layers animating that alone was enough to
 *    stutter. The glow comes from the scaled, low-alpha shell copies instead;
 *  - glow shells are one view, not a nested pair, and their scale is static — so
 *    a per-frame native update only ever touches `opacity`;
 *  - small sparkles skip the hot centre and the second shell entirely, since at
 *    10-15px they were a whole extra animated view buying nothing;
 *  - a tap mounts its sparkles a few per frame (MOUNT_CHUNK). Committing them all
 *    at once blocked the main thread so badly the burst looked like it never
 *    appeared at all.
 *
 * Exit simply pops this route, so the user lands back on Extra settings; it
 * never closes the application.
 */
export default function VersionScreen() {
  const t = useTheme();
  const nav = useNav();
  const { width, height } = useWindowDimensions();

  // --- continuous logo animation ---------------------------------------
  const breathe = useRef(new Animated.Value(0)).current;
  const sway = useRef(new Animated.Value(0)).current;
  const floatY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const oscillate = (value: Animated.Value, duration: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(value, {
            toValue: 1,
            duration,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(value, {
            toValue: 0,
            duration,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ])
      );
    const animations = [oscillate(breathe, 1500), oscillate(sway, 2600), oscillate(floatY, 2100)];
    animations.forEach((a) => a.start());
    return () => animations.forEach((a) => a.stop());
  }, [breathe, sway, floatY]);

  const scale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });
  const rotate = sway.interpolate({ inputRange: [0, 1], outputRange: ['-5deg', '5deg'] });
  const lift = floatY.interpolate({ inputRange: [0, 1], outputRange: [0, -10] });

  // --- tap-triggered full-screen shower -----------------------------------
  const [particles, setParticles] = useState<Particle[]>([]);
  const nextKey = useRef(0);

  const spawnParticles = useCallback(() => {
    const count = PER_TAP_MIN + Math.floor(Math.random() * PER_TAP_SPREAD);
    const cx = width / 2;
    const cy = height * LOGO_CENTRE_Y;

    /*
     * Stratified placement rather than pure random.
     *
     * Pure `Math.random()` clumps: with 50+ sparkles you get bare patches and
     * tight knots, which reads as uneven rather than rich. Instead the screen is
     * divided into a grid with at least `count` cells, the cells are shuffled and
     * the first `count` are used, and each sparkle is jittered inside its own
     * cell. Every region therefore gets roughly the same number — a natural,
     * even spread — while the jitter stops it looking like a grid.
     */
    const cols = Math.max(1, Math.round(Math.sqrt((count * width) / Math.max(1, height))));
    const rows = Math.max(1, Math.ceil(count / cols));
    const cellW = width / cols;
    const cellH = height / rows;

    const cells: number[] = [];
    for (let i = 0; i < cols * rows; i += 1) cells.push(i);
    // Fisher-Yates so the chosen cells differ on every tap.
    for (let i = cells.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = cells[i];
      cells[i] = cells[j];
      cells[j] = tmp;
    }

    const batch: Particle[] = [];
    for (let i = 0; i < count; i += 1) {
      const cell = cells[i % cells.length];
      const col = cell % cols;
      const row = Math.floor(cell / cols);

      // Jitter within ~70% of the cell so neighbours can still overlap slightly.
      let x = (col + 0.15 + Math.random() * 0.7) * cellW;
      let y = (row + 0.15 + Math.random() * 0.7) * cellH;

      // Nudge out of the logo's keep-out circle.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (Math.hypot(x - cx, y - cy) > LOGO_KEEPOUT) break;
        x = Math.min(width - 8, Math.max(8, x + (Math.random() - 0.5) * cellW * 2));
        y = Math.min(height - 8, Math.max(8, y + (Math.random() - 0.5) * cellH * 2));
      }

      batch.push(
        makeParticle(
          nextKey.current + i,
          x,
          y,
          // Small on purpose: an elegant sparkle, never a cartoon star.
          10 + Math.floor(Math.random() * 11),
          i % SHAPES.length,
          SHAPES[i % SHAPES.length]
        )
      );
    }
    nextKey.current += count;

    /*
     * Mount the batch in slices rather than one big commit.
     *
     * Adding all of them at once meant React built every view node in a single
     * pass, which blocked the main thread long enough that the animation was
     * never seen. Slicing keeps the very first sparkles on screen within a frame
     * or two of the tap, and spreads the rest across the following frames.
     *
     * Their animations still start immediately, so each sparkle is already
     * partway through its fade-in by the time its view appears — the stagger
     * delay doubles as a mount schedule.
     */
    let mounted = 0;
    const mountNext = () => {
      if (mounted >= batch.length) return;
      const chunk = batch.slice(mounted, mounted + MOUNT_CHUNK);
      mounted += MOUNT_CHUNK;
      // Overflow is trimmed from the NEWEST end, and those particles are still
      // on their stagger delay at opacity 0 — so trimming never makes a visible
      // sparkle vanish.
      setParticles((prev) => [...prev, ...chunk].slice(0, MAX_LIVE));
      if (mounted < batch.length) {
        setTimeout(mountNext, MOUNT_FRAME_MS);
      }
    };
    mountNext();

    batch.forEach((p, i) => {
      Animated.sequence([
        Animated.delay(i * 55),
        // Ease in. No `back`/overshoot easing anywhere — a bounce reads as a snap.
        Animated.timing(p.anim, {
          toValue: 1,
          duration: 900,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.delay(700),
        // Dissolve: longer than the fade-in and eased at both ends.
        Animated.timing(p.anim, {
          toValue: 2,
          duration: 1800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        // Only reached once opacity is already 0, so removal is invisible.
        if (finished) setParticles((prev) => prev.filter((s) => s.key !== p.key));
      });
    });
  }, [width, height]);

  // Palette lookup is memoised so each memoised Sparkle keeps a stable `pal`
  // reference and is not re-rendered when unrelated state changes.
  const palettes = t.sparkles;
  const paletteFor = useCallback(
    (slot: number) => palettes[slot % palettes.length],
    [palettes]
  );

  return (
    <Pressable style={[styles.root, { backgroundColor: t.bg }]} onPress={spawnParticles}>
      <View style={styles.center}>
        <View style={styles.stage}>
          <Animated.Image
            source={LOGO}
            resizeMode="contain"
            style={[styles.logo, { transform: [{ translateY: lift }, { rotate }, { scale }] }]}
          />
        </View>
        <Text style={[styles.versionText, { color: t.text }]} allowFontScaling={false}>
          Movira Version 1.0.0
        </Text>
      </View>

      <View style={styles.bottom}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Exit version screen"
          activeOpacity={0.85}
          style={[styles.exit, { backgroundColor: t.accent }]}
          onPress={() => nav.pop()}
        >
          <Text style={[styles.exitText, { color: t.bg }]} allowFontScaling={false}>
            Exit
          </Text>
        </TouchableOpacity>
      </View>

      {/*
        Full-screen sparkle layer, painted last so it covers the whole window.
        `pointerEvents="none"` keeps every tap reaching the Pressable underneath,
        so the shower can be re-triggered from anywhere.
      */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {particles.map((p) => (
          <Sparkle key={p.key} p={p} pal={paletteFor(p.slot)} />
        ))}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'space-between' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18 },
  stage: { width: STAGE, height: STAGE, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 140, height: 140 },
  particle: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  /** Centre-align helper for absolute-fill layers (pair with absoluteFill). */
  layer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  versionText: { fontSize: 21, fontWeight: '600', letterSpacing: 0.3 },
  bottom: { alignItems: 'center', paddingBottom: 44 },
  exit: {
    height: 52,
    paddingHorizontal: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    shadowColor: '#000',
  },
  exitText: { fontSize: 16, fontWeight: '700', letterSpacing: 0.6 },
});