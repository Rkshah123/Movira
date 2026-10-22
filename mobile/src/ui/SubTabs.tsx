import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme, metrics } from '../theme';

export interface SubTab {
  key: string;
  label: string;
  /** Right-hand count, as used by the audio tabs in the references. */
  count?: number;
}

interface Props {
  tabs: SubTab[];
  active: string;
  onChange: (key: string) => void;
}

/**
 * Horizontal tab strip under the app bar. The active entry is accent-coloured
 * and carries a short accent underline; inactive entries are dim. The strip
 * scrolls so all five audio tabs stay reachable on narrow phones.
 */
export default function SubTabs({ tabs, active, onChange }: Props) {
  const t = useTheme();
  return (
    <View style={[styles.wrap, { backgroundColor: t.bg, borderBottomColor: t.border }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
        accessibilityRole="tablist"
      >
        {tabs.map((tab) => {
          const on = tab.key === active;
          return (
            <TouchableOpacity
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={tab.label}
              style={styles.tab}
              hitSlop={{ top: 4, bottom: 4 }}
              onPress={() => onChange(tab.key)}
            >
              <Text
                style={[styles.label, { color: on ? t.accent : t.dim }]}
                numberOfLines={1}
                allowFontScaling={false}
              >
                {tab.label.toUpperCase()}
                {tab.count !== undefined ? `  ${tab.count}` : ''}
              </Text>
              <View style={[styles.underline, { backgroundColor: on ? t.accent : 'transparent' }]} />
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: metrics.subTabsHeight, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  content: { paddingHorizontal: metrics.screenPadding, alignItems: 'stretch' },
  tab: { height: metrics.subTabsHeight, justifyContent: 'flex-end', paddingHorizontal: 6, marginRight: 14 },
  label: { fontSize: 14, fontWeight: '500', letterSpacing: 0.9, paddingBottom: 11 },
  underline: { height: 3, borderRadius: 2, marginHorizontal: 2 },
});