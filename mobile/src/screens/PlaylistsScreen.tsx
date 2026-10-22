import React, { useMemo, useState } from 'react';
import { View, FlatList, StyleSheet, TouchableOpacity, Text } from 'react-native';
import type { Playlist } from '@shared';
import { useAppState } from '../state/AppContext';
import { useNav } from '../state/NavContext';
import { useTheme } from '../theme';
import TopBar, { OverflowMenu, type TopBarAction } from '../ui/TopBar';
import EmptyState from '../ui/EmptyState';
import Icon from '../ui/Icon';
import { Divider, OutlineButton } from '../ui/Controls';
import ActionSheet from '../ui/ActionSheet';
import { TextPromptDialog, ConfirmDialog } from '../ui/ChoiceDialog';

/** Playlists tab: the full playlist list with create / rename / delete. */
export default function PlaylistsScreen() {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Playlist | null>(null);
  const [deleting, setDeleting] = useState<Playlist | null>(null);
  const [actionsFor, setActionsFor] = useState<Playlist | null>(null);

  const actions = useMemo<TopBarAction[]>(
    () => [
      { icon: 'search', label: 'Search', onPress: () => nav.push({ name: 'search', kind: 'all' }) },
      { icon: 'overflow', label: 'More options', onPress: () => setMenuOpen((v) => !v) },
    ],
    [nav]
  );

  const menuItems = useMemo(
    () => [
      { label: 'New playlist', checked: false, onPress: () => setCreating(true) },
      { label: 'Incognito mode', checked: app.settings.incognito, onPress: () => app.setSetting('incognito', !app.settings.incognito) },
      { label: 'Refresh', checked: false, onPress: () => void app.refreshLibrary() },
    ],
    [app.settings.incognito, app]
  );

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <TopBar title="Movira" actions={actions} />
      <OverflowMenu visible={menuOpen} onDismiss={() => setMenuOpen(false)} items={menuItems} />

      {app.playlists.length === 0 ? (
        <EmptyState
          message="No playlist found."
          actionLabel="Create a playlist"
          onAction={() => setCreating(true)}
        />
      ) : (
        <FlatList
          data={app.playlists}
          keyExtractor={(p) => p.id}
          ItemSeparatorComponent={Divider}
          contentContainerStyle={styles.content}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <TouchableOpacity
                style={styles.main}
                accessibilityRole="button"
                accessibilityLabel={item.name}
                onPress={() => nav.push({ name: 'playlist', id: item.id })}
              >
                <View style={styles.lead}>
                  <Icon name="playlist" size={26} color={t.dim} />
                </View>
                <View style={styles.body}>
                  <Text style={[styles.title, { color: t.text }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={[styles.meta, { color: t.dim }]}>
                    {item.items.length} {item.items.length === 1 ? 'item' : 'items'}
                  </Text>
                </View>
              </TouchableOpacity>
              {item.items.length > 0 ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Play ${item.name}`}
                  hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                  onPress={() => app.play(item.items, 0)}
                >
                  <Icon name="play" size={18} color={t.accent} />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Options for ${item.name}`}
                hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                onPress={() => setActionsFor(item)}
              >
                <Icon name="overflow" size={20} color={t.dim} />
              </TouchableOpacity>
            </View>
          )}
          ListFooterComponent={
            <View style={styles.footer}>
              <OutlineButton label="New playlist" icon="plus" onPress={() => setCreating(true)} />
            </View>
          }
        />
      )}

      <ActionSheet
        visible={actionsFor !== null}
        title={actionsFor?.name ?? ''}
        onDismiss={() => setActionsFor(null)}
        actions={[
          {
            label: 'Play',
            icon: 'play',
            onPress: () => {
              const p = actionsFor;
              if (p?.items.length) app.play(p.items, 0);
            },
          },
          {
            label: 'Rename',
            icon: 'edit',
            onPress: () => {
              const p = actionsFor;
              if (p) setRenaming(p);
            },
          },
          {
            label: 'Delete',
            icon: 'trash',
            destructive: true,
            onPress: () => {
              const p = actionsFor;
              if (p) setDeleting(p);
            },
          },
        ]}
      />

      <TextPromptDialog
        visible={creating}
        title="New playlist"
        placeholder="Playlist name"
        onCancel={() => setCreating(false)}
        onSubmit={(name) => {
          void app.createPlaylist(name || 'New Playlist');
        }}
      />

      <TextPromptDialog
        visible={renaming !== null}
        title="Rename playlist"
        placeholder="Playlist name"
        initial={renaming?.name ?? ''}
        onCancel={() => setRenaming(null)}
        onSubmit={(name) => {
          if (renaming && name) app.renamePlaylist(renaming.id, name);
        }}
      />

      <ConfirmDialog
        visible={deleting !== null}
        title="Delete playlist"
        message={`"${deleting?.name ?? ''}" will be removed. The media files stay on your device.`}
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) app.deletePlaylist(deleting.id);
          setDeleting(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 62, paddingHorizontal: 14, paddingVertical: 8, gap: 8 },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
  lead: { width: 28, alignItems: 'center' },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 15.5 },
  meta: { fontSize: 12.5, marginTop: 3 },
  footer: { paddingHorizontal: 14, paddingTop: 18 },
});