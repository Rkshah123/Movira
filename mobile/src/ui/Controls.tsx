import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon, { type IconName } from './Icon';
import { useTheme, metrics } from '../theme';

export function Divider() {
  const t = useTheme();
  return <View style={[styles.divider, { backgroundColor: t.border }]} />;
}

/** Accent-coloured group heading ("Media library", "Video", "Storages" …). */
export function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text style={[styles.sectionTitle, { color: t.accent }]} numberOfLines={1} allowFontScaling={false}>
        {title}
      </Text>
      {right ? <View style={styles.sectionRight}>{right}</View> : null}
    </View>
  );
}

interface RowProps {
  title: string;
  subtitle?: string;
  /** Right-hand value text, as used for setting summaries. */
  value?: string;
  icon?: IconName;
  onPress?: () => void;
  right?: React.ReactNode;
  /** Small chevron, used on rows that navigate deeper. */
  chevron?: boolean;
  /** Vertical rhythm; playlist/track lists use a tighter variant. */
  compact?: boolean;
  titleColor?: string;
}

/** Standard settings/list row: optional leading icon, title, subtitle, trailing slot. */
export function Row({
  title,
  subtitle,
  value,
  icon,
  onPress,
  right,
  chevron,
  compact,
  titleColor,
}: RowProps) {
  const t = useTheme();
  const body = (
    <>
      {icon ? (
        <View style={styles.rowIcon}>
          <Icon name={icon} size={21} color={t.dim} />
        </View>
      ) : null}
      <View style={styles.rowBody}>
        <Text
          style={[styles.rowTitle, { color: titleColor ?? t.text, fontSize: compact ? 15 : 16 }]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.rowSub, { color: t.dim }]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
        {value ? (
          <Text style={[styles.rowValue, { color: t.dim }]} numberOfLines={2}>
            {value}
          </Text>
        ) : null}
      </View>
      {right}
      {chevron ? (
        <View style={styles.rowChevron}>
          <Icon name="chevronRight" size={18} color={t.dim} />
        </View>
      ) : null}
    </>
  );

  if (!onPress) return <View style={[styles.row, compact && styles.rowCompact]}>{body}</View>;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={title}
      style={[styles.row, compact && styles.rowCompact]}
      onPress={onPress}
    >
      {body}
    </TouchableOpacity>
  );
}

interface TileProps {
  label: string;
  icon: IconName;
  /** Optional trailing meta line shown under the label. */
  meta?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  wide?: boolean;
}

/** Grid tile used by Browse and the More screen. */
export function Tile({ label, icon, meta, trailing, onPress, wide }: TileProps) {
  const t = useTheme();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.tile, { backgroundColor: t.bg1, borderColor: t.border }, wide && styles.tileWide]}
      onPress={onPress}
    >
      <View style={styles.tileIcon}>
        <Icon name={icon} size={30} color={t.dim} />
      </View>
      <View style={styles.tileFoot}>
        <Text style={[styles.tileLabel, { color: t.text }]} numberOfLines={2} allowFontScaling={false}>
          {label}
        </Text>
        {trailing ??
          (meta ? (
            <Text style={[styles.tileMeta, { color: t.dim }]} numberOfLines={1} allowFontScaling={false}>
              {meta}
            </Text>
          ) : null)}
      </View>
    </TouchableOpacity>
  );
}

/** Outlined pill button used for Settings / About on the More screen. */
export function OutlineButton({
  label,
  icon,
  onPress,
  wide,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  wide?: boolean;
}) {
  const t = useTheme();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.outline, { borderColor: t.accent }, wide && { flex: 1 }]}
      onPress={onPress}
    >
      {icon ? <Icon name={icon} size={19} color={t.accent} /> : null}
      <Text style={[styles.outlineText, { color: t.accent }]} numberOfLines={1} allowFontScaling={false}>
        {label.toUpperCase()}
      </Text>
    </TouchableOpacity>
  );
}

export function Checkbox({ checked, color }: { checked: boolean; color?: string }) {
  const t = useTheme();
  const on = color ?? t.accent;
  return (
    <View
      style={[
        styles.checkbox,
        { borderColor: checked ? on : t.dim, backgroundColor: checked ? on : 'transparent' },
      ]}
    >
      {checked && <Icon name="check" size={14} color={t.bg1} />}
    </View>
  );
}

/** Square checkbox with an explicit hit area, for setting toggles. */
export function CheckToggle({ checked, onPress, label }: { checked: boolean; onPress: () => void; label: string }) {
  return (
    <TouchableOpacity
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={styles.checkHit}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      onPress={onPress}
    >
      <Checkbox checked={checked} />
    </TouchableOpacity>
  );
}

export function Radio({ checked, color }: { checked: boolean; color?: string }) {
  const t = useTheme();
  const on = color ?? t.accent;
  return (
    <View style={[styles.radio, { borderColor: checked ? on : t.dim }]}>
      {checked && <View style={[styles.radioDot, { backgroundColor: on }]} />}
    </View>
  );
}

export function RadioToggle({
  checked,
  onPress,
  label,
  description,
}: {
  checked: boolean;
  onPress: () => void;
  label: string;
  description?: string;
}) {
  const t = useTheme();
  return (
    <TouchableOpacity accessibilityRole="radio" accessibilityState={{ checked }} accessibilityLabel={label} style={styles.radioRow} onPress={onPress}>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: t.text }]}>{label}</Text>
        {description ? (
          <Text style={[styles.rowSub, { color: t.dim }]} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>
      <Radio checked={checked} />
    </TouchableOpacity>
  );
}

/**
 * Slider matching the references: a thin accent track with a round thumb and a
 * muted remainder. Implemented on the shared slider so both the settings pages
 * and the player use one control.
 */
export function TrackSlider({
  value,
  onChange,
  onCommit,
  trackColor,
  baseColor,
  min = 0,
  max = 1,
  step = 0.01,
  width = 240,
}: {
  value: number;
  onChange: (v: number) => void;
  /**
   * Fired once when the drag ends, with the final value. The player scrubbers
   * use this to seek: `onChange` fires on every pixel of movement and is only
   * meant to move the preview thumb.
   */
  onCommit?: (v: number) => void;
  trackColor?: string;
  /**
   * Colour of the unfilled part of the rail. Optional and defaulted, so a screen
   * that needs a specific rail colour (the video player's thin translucent rail)
   * can ask for one without changing every other screen.
   */
  baseColor?: string;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
}) {
  const t = useTheme();
  const accent = trackColor ?? t.accent;
  const span = max - min || 1;
  const ratio = Math.max(0, Math.min(1, (value - min) / span));
  const usable = width - 16;
  const [dragging, setDragging] = React.useState(false);
  const startRatio = React.useRef(0);
  const last = React.useRef(value);

  // pageX rather than locationX: locationX is relative to the responder view and
  // stops being meaningful once the finger travels past its 300px edge, so a
  // long drag would freeze partway instead of following the thumb.
  const startPageX = React.useRef(0);

  const move = (dx: number) => {
    const next = startRatio.current + dx / usable;
    const clamped = Math.max(0, Math.min(1, next));
    const raw = min + clamped * span;
    const snapped = Math.round(raw / step) * step;
    const out = Math.max(min, Math.min(max, snapped));
    last.current = out;
    onChange(out);
  };

  const release = () => {
    setDragging(false);
    onCommit?.(last.current);
  };

  return (
    <View
      accessibilityRole="adjustable"
      style={[styles.sliderHit, { width }]}
      onStartShouldSetResponder={() => {
        setDragging(true);
        startRatio.current = ratio;
        return true;
      }}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        setDragging(true);
        startRatio.current = ratio;
        startPageX.current = e.nativeEvent.pageX;
      }}
      onResponderMove={(e) => {
        if (!dragging) return;
        move(e.nativeEvent.pageX - startPageX.current);
      }}
      onResponderRelease={release}
      onResponderTerminate={release}
    >
      <View style={[styles.sliderTrack, { backgroundColor: baseColor ?? t.track, width: usable }]}>
        <View style={[styles.sliderFill, { backgroundColor: accent, width: usable * ratio }]} />
      </View>
      <View
        style={[
          styles.sliderThumb,
          { backgroundColor: accent, left: Math.max(0, usable * ratio - 7) },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: metrics.screenPadding },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: metrics.screenPadding,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sectionTitle: { fontSize: 16, fontWeight: '500' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: metrics.screenPadding,
    paddingVertical: 9,
    gap: 12,
  },
  rowCompact: { minHeight: 48, paddingVertical: 6 },
  rowIcon: { width: 24, alignItems: 'center' },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 16 },
  rowSub: { fontSize: 13.5, marginTop: 3, lineHeight: 19 },
  rowValue: { fontSize: 13.5, marginTop: 3, lineHeight: 19 },
  rowChevron: { paddingLeft: 4 },
  tile: {
    flex: 1,
    minHeight: 92,
    borderRadius: metrics.tileRadius,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    justifyContent: 'space-between',
  },
  tileWide: { minHeight: 92 },
  tileIcon: { alignItems: 'flex-start' },
  // Grid tiles are two-per-row on a 360 dp phone, so the label needs room to
  // wrap to two lines without colliding with the meta line underneath.
  // Stacked, not side-by-side: a row let the meta text squeeze the label down
  // to a few characters on narrow phones, which is what made the option names
  // unreadable.
  tileFoot: { flexDirection: 'column', alignItems: 'flex-start', gap: 3, width: '100%' },
  tileLabel: { fontSize: 14, fontWeight: '500', lineHeight: 18 },
  tileMeta: { fontSize: 11, lineHeight: 14 },
  outline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 46,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  outlineText: { fontSize: 13, letterSpacing: 0.9, fontWeight: '500' },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 3,
    borderWidth: 1.8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkHit: { padding: 4, marginRight: -4 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 9, height: 9, borderRadius: 5 },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  sliderHit: { height: 34, justifyContent: 'center' },
  sliderTrack: { height: 3, borderRadius: 2, overflow: 'hidden' },
  sliderFill: { height: 3 },
  sliderThumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    top: 10,
  },
});