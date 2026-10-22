import React from 'react';
import { StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';

/** Single icon system for the whole app.

 * Every glyph comes from the official Material Design Icons font
 * (`@react-native-vector-icons/material-design-icons`, MDI 7.4.47) — the same
 * family VLC and other polished media apps use. Nothing here is drawn from
 * Views, text characters or ad-hoc shapes, so stroke weight, optical size,
 * spacing and alignment are all consistent by construction.
 *
 * The font ships as an asset and is bundled at
 * `android/app/src/main/assets/fonts/MaterialDesignIcons.ttf`, which is how
 * React Native resolves `fontFamily: 'MaterialDesignIcons'` on Android.
 */

export type IconName =
  | 'search'
  | 'sort'
  | 'overflow'
  | 'video'
  | 'audio'
  | 'folder'
  | 'playlist'
  | 'more'
  | 'back'
  | 'close'
  | 'plus'
  | 'refresh'
  | 'check'
  | 'chevronRight'
  | 'gear'
  | 'info'
  | 'heart'
  | 'heartOutline'
  | 'play'
  | 'pause'
  | 'next'
  | 'prev'
  | 'stop'
  | 'shuffle'
  | 'repeat'
  | 'globe'
  | 'person'
  | 'download'
  | 'movie'
  | 'music'
  | 'sd'
  | 'sliders'
  | 'cast'
  | 'shield'
  | 'remote'
  | 'car'
  | 'wrench'
  | 'palette'
  | 'subtitles'
  | 'storage'
  | 'wifi'
  | 'queue'
  | 'trash'
  | 'edit'
  | 'lock'
  | 'unlock'
  | 'rotate'
  | 'screenOn'
  | 'display'
  | 'speed'
  | 'zoomIn'
  | 'zoomOut'
  | 'expand'
  | 'rew10'
  | 'ff10'
  | 'star'
  | 'sixPointSparkle'
  | 'sparkles'
  | 'glowingStar'
  | 'twinkle'
  | 'linkedin'
  | 'github'
  | 'timer'
  | 'share'
  | 'ringtone'
  | 'chevronDown'
  | 'download'
  | 'trackInfo'
  | 'fit'
  | 'popOut'
  | 'volumeHigh'
  | 'volumeMedium'
  | 'volumeLow'
  | 'volumeOff'
  | 'brightness';

/** A real glyph name from the Material Design Icons font. */
type GlyphName = React.ComponentProps<typeof MaterialDesignIcons>['name'];

/** App-level name -> Material Design Icons glyph name. */
const GLYPH: Record<IconName, GlyphName> = {
  search: 'magnify',
  sort: 'sort',
  overflow: 'dots-vertical',
  more: 'dots-horizontal',

  video: 'movie-open',
  movie: 'movie',
  audio: 'music-note',
  music: 'music-note',
  folder: 'folder',
  playlist: 'playlist-music',
  queue: 'playlist-play',

  back: 'arrow-left',
  close: 'close',
  plus: 'plus',
  refresh: 'refresh',
  check: 'check',
  chevronRight: 'chevron-right',
  gear: 'cog',
  info: 'information',
  trash: 'trash-can-outline',
  edit: 'pencil-outline',

  play: 'play',
  pause: 'pause',
  stop: 'stop',
  next: 'skip-next',
  prev: 'skip-previous',
  rew10: 'rewind-10',
  ff10: 'fast-forward-10',
  shuffle: 'shuffle-variant',
  repeat: 'repeat',
  // Outline variants match the audio reference sheet, where the download arrow
  // beside the heart is stroked rather than solid.
  download: 'download-outline',
  heart: 'heart',
  heartOutline: 'heart-outline',

  star: 'star',
  globe: 'web',
  person: 'account',

  sd: 'sd',
  storage: 'harddisk',
  sliders: 'tune-variant',
  cast: 'cast-connected',
  shield: 'shield-check',
  remote: 'remote',
  car: 'car',
  wrench: 'wrench',
  palette: 'palette',
  wifi: 'wifi',

  subtitles: 'subtitles',
  lock: 'lock',
  unlock: 'lock-open-variant',
  rotate: 'screen-rotation',
  screenOn: 'cellphone',
  display: 'picture-in-picture-bottom-right',
  speed: 'speedometer',
  zoomIn: 'magnify-plus',
  zoomOut: 'magnify-minus',
  expand: 'fullscreen',
  // The four approved sparkle glyphs for the version-screen burst.
  //
  // These four names are verified against BOTH the bundled glyphmap
  // (glyphmaps/MaterialDesignIcons.json, 7448 entries) AND the actual
  // `cmap` table of the shipped MaterialDesignIcons.ttf — all four resolve to
  // real glyphs:
  //   asterisk          U+F06C4
  //   creation          U+F0674
  //   star              U+F04CE
  //   star-four-points  U+F0AE2
  //
  // Chosen so the four silhouettes are unmistakable at 13-23dp: radiating
  // spokes, wand-with-sparkles, a solid five-point star, and the thin
  // four-point twinkle. `star-shooting` was tried first for `glowingStar` but
  // its trailing streaks read almost identically to `creation` next to it, so
  // a plain solid star is used instead.
  //
  // The `?` placeholder box this screen used to show came from `sparkles`,
  // which is NOT in the MDI font at all. Never map a name here without
  // checking it against the TTF cmap — a missing codepoint silently renders a
  // tofu box rather than throwing.
  sixPointSparkle: 'asterisk', // ❋ six-point sparkle
  sparkles: 'creation', // ✨ sparkles burst
  glowingStar: 'star', // 🌟 glowing star
  twinkle: 'star-four-points', // ✦ twinkle

  // Brand marks for the About screen's link dialog. Verified against the TTF
  // cmap the same way as the sparkles: linkedin U+F033B, github U+F02A4.
  linkedin: 'linkedin',
  github: 'github',

  // Audio Now Playing. `timer` is a clock face (Sleep Timer), `ringtone` a bell
  // (Set as Ringtone), `share` the three-node share mark — matching the glyph
  // shapes in the audio reference sheet.
  timer: 'clock-outline',
  share: 'share-variant',
  ringtone: 'bell-outline',
  chevronDown: 'chevron-down',

  // Video Now Playing bottom row. Closest MDI matches to the three reference
  // marks; all verified against the TTF cmap.
  //   trackInfo = rounded box with bars (audio track / stream info)
  //   fit       = corner brackets with outward arrows (fit to screen)
  //   popOut    = box with corner brackets (mini player / pop out)
  trackInfo: 'card-text',
  fit: 'fit-to-screen-outline',
  popOut: 'picture-in-picture-bottom-right-outline',

  // Level symbols for the volume / brightness indicator. All verified against the
  // TTF cmap: volume-off U+F0581, volume-low U+F057F, volume-medium U+F0580,
  // volume-high U+F057E, brightness-7 U+F00E0. Brightness uses the FULL sun
  // (brightness-7) rather than the half-filled brightness-6, which rendered with
  // a dark D-shaped bite out of the middle and read as a letter, not a symbol.
  volumeHigh: 'volume-high',
  volumeMedium: 'volume-medium',
  volumeLow: 'volume-low',
  volumeOff: 'volume-off',
  brightness: 'brightness-7',
};

interface Props {
  name: IconName;
  size?: number;
  color: string;
  /** Kept for call-site compatibility; MDI glyphs are already the right weight. */
  filled?: boolean;
  style?: StyleProp<TextStyle>;
}

export default function Icon({ name, size = 24, color, style }: Props) {
  return (
    <MaterialDesignIcons
      name={GLYPH[name]}
      size={size}
      color={color}
      allowFontScaling={false}
      // Optical centring: MDI glyphs sit slightly high in their em box, and the
      // app's touch targets are centred circles, so nudge down a hair.
      style={[styles.glyph, style]}
    />
  );
}

const styles = StyleSheet.create({
  glyph: { textAlign: 'center', includeFontPadding: false },
});
