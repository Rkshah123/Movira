import React from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { useTheme } from '../theme';

const LOGO = require('../assets/movira_logo.png');

interface Props {
  message: string;
  /** Outlined accent button under the message (the references show "Go to …"). */
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * Empty-state block: a faded logo, a centred message and — when the user has
 * somewhere to go — an outlined accent button. Used by Video, Audio and the
 * playlist list.
 */
export default function EmptyState({ message, actionLabel, onAction }: Props) {
  const t = useTheme();
  return (
    <View style={styles.wrap}>
      <Image source={LOGO} style={[styles.logo, { opacity: t.dark ? 0.3 : 0.4 }]} resizeMode="contain" />
      <Text style={[styles.message, { color: t.dim }]} numberOfLines={4}>
        {message}
      </Text>
      {actionLabel && onAction && (
        <TouchableOpacity
          accessibilityRole="button"
          style={[styles.action, { borderColor: t.dim }]}
          onPress={onAction}
        >
          <Text style={[styles.actionText, { color: t.accent }]} numberOfLines={2}>
            {actionLabel.toUpperCase()}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 34,
    gap: 14,
  },
  logo: { width: 84, height: 84 },
  message: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  action: {
    marginTop: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: { fontSize: 13, letterSpacing: 0.8, textAlign: 'center', fontWeight: '500' },
});