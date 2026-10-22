import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image, StatusBar, Platform, useWindowDimensions } from 'react-native';
import Icon, { type IconName } from './Icon';
import { useTheme, metrics } from '../theme';
import { logToAndroid } from '../system';

/**
 * Height of the Android system status bar (clock / Wi-Fi / battery), in the
 * density-independent pixels React Native lays out in.
 *
 * Android draws the app edge-to-edge and paints the status bar on top of the
 * window, so every screen has to be pushed down by this much or the header,
 * logo and action icons end up underneath the system UI.
 *
 * `StatusBar.currentHeight` already reports this in dp (measured 36.67 on the
 * test device). The native `getStatusBarHeight` bridge returns the same
 * measurement in *pixels* (110), so it must not be used directly as a layout
 * value — that pushed the whole header off-screen.
 */
export function useStatusBarInset(): number {
  if (Platform.OS !== 'android') return 0;
  const h = StatusBar.currentHeight;
  return typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : 0;
}

export interface TopBarAction {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** Renders in the accent colour to mark an active/toggled tool. */
  active?: boolean;
}

interface Props {
  /** Page title shown next to the logo. Omit it when `center` is supplied. */
  title?: string | null;
  actions?: TopBarAction[];
  /** Left slot replaces the logo (used by the Settings/About sub-pages). */
  left?: React.ReactNode;
  /** Centre slot replaces the title (used by the Settings/About sub-pages). */
  center?: React.ReactNode;
  /** Accent-coloured title, as on the settings sub-pages. */
  accentTitle?: boolean;
}

const LOGO = require('../assets/movira_logo.png');

export default function TopBar({ title, actions = [], left, center, accentTitle }: Props) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 360;
  const iconSize = compact ? 24 : 26;

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: t.bg1,
          borderBottomColor: t.border,
          height: metrics.topBarHeight,
        },
      ]}
    >
      {left ?? (
        <View style={styles.brand}>
          <Image source={LOGO} style={styles.logo} resizeMode="contain" />
          {title !== null && (
            <Text
              style={[styles.brandName, { color: t.text, fontSize: compact ? 17 : 19 }]}
              numberOfLines={1}
              allowFontScaling={false}
            >
              {title}
            </Text>
          )}
        </View>
      )}

      {center ?? (
        title === null && !left ? (
          <View style={styles.spacer} />
        ) : null
      )}

      <View style={styles.actions}>
        {actions.map((a) => (
          <TouchableOpacity
            key={a.label}
            accessibilityLabel={a.label}
            accessibilityRole="button"
            style={styles.action}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            onPress={a.onPress}
          >
            <Icon name={a.icon} size={iconSize} color={a.active ? t.accent : t.text} />
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export function BarTitle({ text, accent }: { text: string; accent?: boolean }) {
  const t = useTheme();
  return (
    <Text style={[styles.barTitle, { color: accent ? t.accent : t.text }]} numberOfLines={1} allowFontScaling={false}>
      {text}
    </Text>
  );
}

export function BarButton({
  icon,
  label,
  onPress,
  color,
  size = 24,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  color?: string;
  size?: number;
}) {
  const t = useTheme();
  return (
    <TouchableOpacity
      accessibilityLabel={label}
      accessibilityRole="button"
      style={styles.action}
      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      onPress={onPress}
    >
      <Icon name={icon} size={size} color={color ?? t.text} />
    </TouchableOpacity>
  );
}

/**
 * The "..." popup from the references. Rendered in place (not as a native
 * modal, so a tap outside it always reaches the app itself).
 *
 * Two details matter on Android:
 *
 *  - the layer must carry an explicit z-index + elevation. Rendered in place,
 *    it used to share the z-plane with the siblings that follow it on each
 *    screen, so the list painted *over* the card — which is what made the menu
 *    look transparent and let taps fall through to the rows underneath.
 *  - an explicit backdrop child claims every tap outside the card: one press
 *    dismisses the menu, and that press can never reach content below it.
 */
export function OverflowMenu({
  visible,
  onDismiss,
  items,
}: {
  visible: boolean;
  onDismiss: () => void;
  items: { label: string; checked?: boolean; onPress: () => void }[];
}) {
  const t = useTheme();
  if (!visible) return null;
  return (
    <View style={[StyleSheet.absoluteFill, styles.menuLayer]} pointerEvents="box-none">
      <TouchableOpacity
        accessibilityLabel="Close menu"
        accessibilityRole="button"
        activeOpacity={1}
        style={StyleSheet.absoluteFill}
        onPress={onDismiss}
      />
      <View
        style={[styles.menu, { backgroundColor: t.bg2, borderColor: t.border, shadowColor: t.shadow }]}
        pointerEvents="auto"
      >
        {items.map((it, i) => (
          <TouchableOpacity
            key={it.label}
            style={[
              styles.menuRow,
              i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border },
            ]}
            onPress={() => {
              // Close first, then run the action — the same order the modal
              // action sheets use, so navigation or a picker never opens on
              // top of a menu that is still visible.
              onDismiss();
              it.onPress();
            }}
          >
            <Text style={[styles.menuLabel, { color: t.text }]} numberOfLines={1}>
              {it.label}
            </Text>
            <View
              style={[
                styles.checkbox,
                { borderColor: it.checked ? t.accent : t.dim, backgroundColor: it.checked ? t.accent : 'transparent' },
              ]}
            >
              {it.checked && <Icon name="check" size={13} color={t.bg} />}
            </View>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: metrics.topBarHeight,
    paddingHorizontal: metrics.screenPadding,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  logo: { width: 26, height: 26 },
  brandName: { fontWeight: '600', letterSpacing: 0.1 },
  barTitle: { fontSize: 18, fontWeight: '600' },
  spacer: { flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto', gap: 2 },
  action: { padding: 7 },
  menuLayer: {
    // Above every sibling (list, sub-tabs, bottom nav) both for drawing and
    // for hit-testing; elevation settles Android draw order, zIndex iOS.
    zIndex: 1000,
    elevation: 24,
  },
  menu: {
    position: 'absolute',
    top: metrics.topBarHeight + 4,
    right: metrics.screenPadding - 6,
    minWidth: 190,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    elevation: 8,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    height: 48,
    gap: 12,
  },
  menuLabel: { fontSize: 15 },
  checkbox: {
    width: 19,
    height: 19,
    borderRadius: 3,
    borderWidth: 1.6,
    alignItems: 'center',
    justifyContent: 'center',
  },
});