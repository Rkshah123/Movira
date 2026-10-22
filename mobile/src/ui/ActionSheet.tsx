import React from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { useTheme } from '../theme';
import Icon, { type IconName } from './Icon';

/**
 * Action list shown from a row's overflow button. Same raised-card treatment as
 * the radio dialogs in the references, without the radio affordance.
 */
export default function ActionSheet({
  visible,
  title,
  actions,
  onDismiss,
  /** Renders the destructive entry in the accent colour. */
  destructiveLast = true,
}: {
  visible: boolean;
  title: string;
  actions: { label: string; icon?: IconName; onPress: () => void; destructive?: boolean }[];
  onDismiss: () => void;
  destructiveLast?: boolean;
}) {
  const t = useTheme();
  if (!visible) return null;
  const ordered = destructiveLast
    ? [...actions.filter((a) => !a.destructive), ...actions.filter((a) => a.destructive)]
    : actions;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss} statusBarTranslucent>
      <TouchableOpacity
        activeOpacity={1}
        style={[styles.backdrop, { backgroundColor: t.overlay }]}
        onPress={onDismiss}
      >
        <View style={[styles.card, { backgroundColor: t.bg3, shadowColor: t.shadow }]}>
          <Text style={[styles.title, { color: t.text }]} numberOfLines={2}>
            {title}
          </Text>
          {ordered.map((a, i) => (
            <TouchableOpacity
              key={a.label}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              style={[
                styles.option,
                i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border },
              ]}
              onPress={() => {
                onDismiss();
                a.onPress();
              }}
            >
              {a.icon ? <Icon name={a.icon} size={19} color={a.destructive ? t.accent : t.dim} /> : null}
              <Text style={[styles.optionLabel, { color: a.destructive ? t.accent : t.text }]}>{a.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 6,
    paddingVertical: 6,
    elevation: 12,
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  title: { fontSize: 16, paddingHorizontal: 22, paddingTop: 16, paddingBottom: 12 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 22, paddingVertical: 14 },
  optionLabel: { fontSize: 15.5, flex: 1 },
});