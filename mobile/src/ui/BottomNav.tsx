import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon, { type IconName } from './Icon';
import { useTheme, metrics } from '../theme';

export type TabKey = 'video' | 'audio' | 'browse' | 'playlists' | 'more';

export const TABS: { key: TabKey; label: string; icon: IconName }[] = [
  { key: 'video', label: 'Video', icon: 'video' },
  { key: 'audio', label: 'Audio', icon: 'audio' },
  { key: 'browse', label: 'Browse', icon: 'folder' },
  { key: 'playlists', label: 'Playlists', icon: 'playlist' },
  { key: 'more', label: 'More', icon: 'more' },
];

interface Props {
  active: TabKey;
  onChange: (key: TabKey) => void;
  /** Android gesture-bar inset. */
  bottomInset: number;
}

/**
 * Five-item bottom navigation, matching the references: icon above a small
 * label, active item in the accent colour. A persistent mini-player sits
 * directly above it, which is why the bar itself is only as tall as it needs to be.
 */
export default function BottomNav({ active, onChange, bottomInset }: Props) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: t.bg1, borderTopColor: t.border, paddingBottom: bottomInset },
      ]}
    >
      {TABS.map((tab) => {
        const on = tab.key === active;
        const color = on ? t.accent : t.dim;
        return (
          <TouchableOpacity
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={tab.label}
            style={styles.item}
            onPress={() => onChange(tab.key)}
          >
            <Icon name={tab.icon} size={22} color={color} filled={on} />
            <Text style={[styles.label, { color }]} numberOfLines={1} allowFontScaling={false}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
  },
  item: {
    flex: 1,
    minHeight: metrics.bottomNavMinHeight - 6,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  label: { fontSize: 11 },
});