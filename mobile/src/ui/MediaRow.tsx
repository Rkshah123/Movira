import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { MediaItem } from '@shared';
import { formatSize, formatTime } from '@shared';
import Icon from './Icon';
import { useTheme, metrics } from '../theme';

interface Props {
  item: MediaItem;
  onPress: () => void;
  onLongPress?: () => void;
  /** Overrides the right-hand slot (used by playlist rows for drag handles). */
  right?: React.ReactNode;
  subtitle?: string;
  showFavorite?: boolean;
  favorite?: boolean;
  onToggleFavorite?: () => void;
  /** Shows the "now playing" marker in front of the title. */
  active?: boolean;
  /** Suppresses the overflow button when the caller supplies its own actions. */
  hideOverflow?: boolean;
  /**
   * Turns the trailing "..." into a real button. It is a nested touchable, so
   * pressing it claims the gesture before the row's own `onPress` can run —
   * the overflow never plays/opens the item underneath it.
   */
  onOverflow?: () => void;
}

/**
 * One media entry in a list. Leading type icon, title, meta line and a
 * trailing overflow button — the layout used on both the Video and Audio tabs.
 */
export default function MediaRow({
  item,
  onPress,
  onLongPress,
  right,
  subtitle,
  showFavorite,
  favorite,
  onToggleFavorite,
  active,
  hideOverflow,
  onOverflow,
}: Props) {
  const t = useTheme();
  const metaParts: string[] = [];
  if (subtitle) metaParts.push(subtitle);
  else if (item.artist) metaParts.push(item.artist);
  if (item.duration) metaParts.push(formatTime(item.duration));
  if (item.size) metaParts.push(formatSize(item.size));
  if (!metaParts.length) metaParts.push(item.type === 'video' ? 'Video' : 'Audio');

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={item.title}
      style={styles.row}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      <View style={styles.lead}>
        <Icon name={item.type === 'video' ? 'video' : 'audio'} size={26} color={active ? t.accent : t.dim} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, { color: active ? t.accent : t.text }]} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={[styles.meta, { color: t.dim }]} numberOfLines={1}>
          {metaParts.join('  ·  ')}
        </Text>
      </View>
      {showFavorite && onToggleFavorite ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={favorite ? 'Remove from favourites' : 'Add to favourites'}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          onPress={onToggleFavorite}
        >
          <Icon name={favorite ? 'heart' : 'heartOutline'} size={19} color={favorite ? t.accent : t.dim} />
        </TouchableOpacity>
      ) : null}
      {right ??
        hideOverflow ? null : onOverflow ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Options for ${item.title}`}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            style={styles.overflow}
            onPress={onOverflow}
          >
            <Icon name="overflow" size={18} color={t.dim} />
          </TouchableOpacity>
        ) : (
          <View style={styles.overflow}>
            <Icon name="overflow" size={18} color={t.dim} />
          </View>
        )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 62,
    paddingHorizontal: metrics.screenPadding,
    paddingVertical: 8,
    gap: 12,
  },
  lead: { width: 28, alignItems: 'center' },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 15.5 },
  meta: { fontSize: 12.5, marginTop: 3 },
  overflow: { paddingLeft: 6 },
});