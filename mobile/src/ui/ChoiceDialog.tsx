import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Modal } from 'react-native';
import { useTheme, metrics } from '../theme';
import Icon from './Icon';
import { Radio } from './Controls';

export interface Choice {
  label: string;
  value: string;
}

/**
 * Modal radio list, matching the "Video screen orientation" / "Hardware
 * Acceleration" / "Action for streams…" dialogs in the references: the page
 * dims behind a raised card of options.
 *
 * Pass `navigates` for a menu whose rows all open another sheet. A radio circle
 * says "choose one of these", and on such a menu nothing is ever chosen — every
 * row is a doorway. Showing six empty circles there told the user the list was a
 * single-choice control it had somehow failed to answer, when in fact it was a
 * plain menu. Those rows get a chevron instead, which says what they actually do.
 */
export default function ChoiceDialog({
  visible,
  title,
  choices,
  selected,
  onSelect,
  onDismiss,
  closeOnSelect = true,
  navigates = false,
}: {
  visible: boolean;
  title: string;
  choices: Choice[];
  selected: string;
  onSelect: (value: string) => void;
  onDismiss: () => void;
  /**
   * A menu that navigates to another sheet must opt out (`false`): the default
   * close would run straight after `onSelect` and undo the navigation.
   */
  closeOnSelect?: boolean;
  /** Renders a chevron instead of a radio: these rows open another sheet. */
  navigates?: boolean;
}) {
  const t = useTheme();
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss} statusBarTranslucent>
      <TouchableOpacity
        style={[styles.backdrop, { backgroundColor: t.overlay }]}
        activeOpacity={1}
        onPress={onDismiss}
      >
        <View style={[styles.card, { backgroundColor: t.bg3, shadowColor: t.shadow }]}>
          <Text style={[styles.title, { color: t.text }]} numberOfLines={2}>
            {title}
          </Text>
          <ScrollView bounces={false} style={styles.list}>
            {choices.map((c) => (
              <TouchableOpacity
                key={c.value}
                accessibilityRole={navigates ? 'button' : 'radio'}
                {...(navigates
                  ? {}
                  : { accessibilityState: { selected: c.value === selected } })}
                accessibilityLabel={c.label}
                style={styles.option}
                onPress={() => {
                  onSelect(c.value);
                  if (closeOnSelect) onDismiss();
                }}
              >
                <Text style={[styles.optionLabel, { color: t.text }]} numberOfLines={2}>
                  {c.label}
                </Text>
                {navigates ? (
                  <Icon name="chevronRight" size={18} color={t.dim} />
                ) : (
                  <Radio checked={c.value === selected} />
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

/** Lightweight confirm prompt with Cancel / OK. */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  /** Hidden when there is nothing meaningful the user could choose instead. */
  cancelLabel?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTheme();
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={[styles.backdrop, { backgroundColor: t.overlay }]}>
        <View style={[styles.card, { backgroundColor: t.bg3, shadowColor: t.shadow }]}>
          <Text style={[styles.title, { color: t.text }]}>{title}</Text>
          <Text style={[styles.message, { color: t.dim }]}>{message}</Text>
          <View style={styles.actions}>
            {cancelLabel ? (
              <TouchableOpacity style={styles.actionBtn} onPress={onCancel}>
                <Text style={[styles.actionText, { color: t.text }]}>{cancelLabel}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.actionBtn} onPress={onConfirm}>
              <Text style={[styles.actionText, { color: t.accent }]}>{confirmLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Single-line text prompt used for creating / renaming playlists. */
export function TextPromptDialog({
  visible,
  title,
  placeholder,
  initial,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  placeholder?: string;
  initial?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const t = useTheme();
  const [value, setValue] = React.useState(initial ?? '');
  React.useEffect(() => {
    if (visible) setValue(initial ?? '');
  }, [visible, initial]);

  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={[styles.backdrop, { backgroundColor: t.overlay }]}>
        <View style={[styles.card, { backgroundColor: t.bg3, shadowColor: t.shadow }]}>
          <Text style={[styles.title, { color: t.text }]}>{title}</Text>
          <TextInputLine value={value} placeholder={placeholder ?? ''} onChange={setValue} color={t.text} accent={t.accent} bg={t.bg1} border={t.border} />
          <View style={styles.actions}>
            <TouchableOpacity style={styles.actionBtn} onPress={onCancel}>
              <Text style={[styles.actionText, { color: t.text }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => {
                onSubmit(value.trim());
                onCancel();
              }}
            >
              <Text style={[styles.actionText, { color: t.accent }]}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * RN's TextInput is imported lazily here to keep the dialog module free of a
 * top-level dependency for the (very common) case where it is never rendered.
 */
function TextInputLine({
  value,
  onChange,
  placeholder,
  color,
  accent,
  bg,
  border,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  color: string;
  accent: string;
  bg: string;
  border: string;
}) {
  const { TextInput } = require('react-native') as typeof import('react-native');
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={border}
      autoFocus
      selectionColor={accent}
      style={[styles.input, { color, backgroundColor: bg, borderColor: border }]}
      allowFontScaling={false}
    />
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
  title: { fontSize: 19, paddingHorizontal: 22, paddingTop: 18, paddingBottom: 12 },
  message: { fontSize: 14, paddingHorizontal: 22, paddingBottom: 8, lineHeight: 20 },
  list: { maxHeight: 320, paddingBottom: 8 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 22,
    paddingVertical: 11,
  },
  optionLabel: { fontSize: 16, flex: 1 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 4,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 6,
  },
  actionBtn: { paddingHorizontal: 16, paddingVertical: 12 },
  actionText: { fontSize: 15, fontWeight: '500' },
  input: {
    marginHorizontal: 22,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 3,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 15,
  },
  metricsHint: { paddingHorizontal: metrics.screenPadding },
});