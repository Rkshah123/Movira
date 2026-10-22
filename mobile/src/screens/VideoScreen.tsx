import React, { useCallback, useMemo, useState } from 'react';
import { View, FlatList, RefreshControl, StyleSheet, TouchableOpacity, Text } from 'react-native';
import type { MediaItem } from '@shared';
import { useAppState } from '../state/AppContext';
import { useNav } from '../state/NavContext';
import { useTheme } from '../theme';
import TopBar, { OverflowMenu, type TopBarAction } from '../ui/TopBar';
import SubTabs from '../ui/SubTabs';
import EmptyState from '../ui/EmptyState';
import MediaRow from '../ui/MediaRow';
import { useMediaItemMenu } from '../ui/MediaItemMenu';
import { Divider, OutlineButton } from '../ui/Controls';
import Icon from '../ui/Icon';
import { pickFile } from '@dr.pogodin/react-native-fs';

const NO_MEDIA =
  'No media files found, please transfer some files to your device or adjust your preferences.';

/**
 * Video tab.
 *
 * Sub-navigation is `Videos | Playlists`, matching the first reference
 * screenshot. The empty state carries the "Go to media library preferences"
 * action from the references, which jumps straight into the settings page.
 */
export default function VideoScreen() {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();
  const [tab, setTab] = useState<'videos' | 'playlists'>('videos');
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState<'title' | 'date' | 'size'>('date');
  const { open: openItemMenu, node: itemMenuNode } = useMediaItemMenu();

  const sorted = useMemo(() => {
    const items = [...app.videos];
    if (sort === 'title') items.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
    else if (sort === 'size') items.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    else items.sort((a, b) => b.addedAt - a.addedAt);
    return items;
  }, [app.videos, sort]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await app.refreshLibrary();
    } finally {
      setRefreshing(false);
    }
  }, [app]);

  // Tapping a row only has to enqueue: App.tsx opens the player for video, which
  // needs its <Video> surface mounted before the engine will start playing.
  const startVideo = useCallback((items: MediaItem[], index: number) => {
    app.play(items, index);
  }, [app]);

  const pickFiles = useCallback(async () => {
    try {
      const uris = await pickFile({ mimeTypes: ['video/*'], pickerType: 'multipleFiles' });
      if (!uris.length) return;
      // Play the files this pick actually added — the context's `videos` array
      // is still the pre-pick snapshot inside this callback.
      const added = await app.addPickedFiles(uris, 'video');
      if (added.length) startVideo(added, 0);
    } catch {
      // The picker was dismissed — nothing to do.
    }
  }, [app, startVideo]);

  const actions: TopBarAction[] = useMemo(
    () => [
      { icon: 'search', label: 'Search', onPress: () => nav.push({ name: 'search', kind: 'video' }) },
      { icon: 'sort', label: 'Change sort order', onPress: () => setSort((s) => (s === 'date' ? 'title' : s === 'title' ? 'size' : 'date')) },
      { icon: 'overflow', label: 'More options', onPress: () => setMenuOpen((v) => !v) },
    ],
    [nav]
  );

  const menuItems = useMemo(
    () => [
      {
        label: 'Incognito mode',
        checked: app.settings.incognito,
        onPress: () => app.setSetting('incognito', !app.settings.incognito),
      },
      { label: 'Add files from device', checked: false, onPress: () => void pickFiles() },
      { label: 'Refresh', checked: false, onPress: () => void onRefresh() },
    ],
    [app.settings.incognito, app, onRefresh, pickFiles]
  );

  const renderItem = useCallback(
    ({ item }: { item: MediaItem }) => (
      <MediaRow
        item={item}
        active={app.current?.id === item.id}
        onPress={() => {
          startVideo(sorted, sorted.indexOf(item));
          // App.tsx opens the player when the current item changes to a video.
          // Re-tapping the item that is already loaded changes nothing, so open
          // it here instead.
          if (app.current?.id === item.id) nav.push({ name: 'nowPlaying' });
        }}
        showFavorite
        favorite={app.isFavorite(item.id)}
        onToggleFavorite={() => app.toggleFavorite(item)}
        onOverflow={() => openItemMenu(item, sorted)}
      />
    ),
    [app, sorted, startVideo, openItemMenu]
  );

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <TopBar title="Movira" actions={actions} />
      <OverflowMenu visible={menuOpen} onDismiss={() => setMenuOpen(false)} items={menuItems} />
      {itemMenuNode}

      <SubTabs
        tabs={[
          { key: 'videos', label: 'Videos', count: app.videos.length },
          { key: 'playlists', label: 'Playlists', count: app.playlists.length },
        ]}
        active={tab}
        onChange={(k) => setTab(k as 'videos' | 'playlists')}
      />

      {tab === 'videos' ? (
        sorted.length === 0 ? (
          <EmptyState
            message={NO_MEDIA}
            actionLabel="Go to media library preferences"
            onAction={() => nav.push({ name: 'settingsPage', page: 'mediaLibrary' })}
          />
        ) : (
          <FlatList
            data={sorted}
            keyExtractor={(i) => i.id}
            renderItem={renderItem}
            ItemSeparatorComponent={Divider}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.bg1} />
            }
            contentContainerStyle={styles.listContent}
            ListFooterComponent={
              <View style={styles.footer}>
                <OutlineButton label="Add files from device" icon="plus" onPress={() => void pickFiles()} />
              </View>
            }
          />
        )
      ) : (
        <View style={styles.fill}>
          {app.playlists.length === 0 ? (
            <EmptyState message="No playlist found." />
          ) : (
            <FlatList
              data={app.playlists}
              keyExtractor={(p) => p.id}
              ItemSeparatorComponent={Divider}
              contentContainerStyle={styles.listContent}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.playlistRow} onPress={() => nav.push({ name: 'playlist', id: item.id })}>
                  <View style={styles.playlistLead}>
                    <Icon name="playlist" size={26} color={t.dim} />
                  </View>
                  <View style={styles.body}>
                    <Text style={[styles.playlistTitle, { color: t.text }]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={[styles.meta, { color: t.dim }]}>{item.items.length} items</Text>
                  </View>
                  <View style={styles.overflow}>
                    <Icon name="overflow" size={20} color={t.dim} />
                  </View>
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1 },
  listContent: { paddingBottom: 24 },
  footer: { paddingHorizontal: 14, paddingTop: 18 },
  body: { flex: 1, minWidth: 0 },
  playlistRow: { flexDirection: 'row', alignItems: 'center', minHeight: 62, paddingHorizontal: 14, paddingVertical: 8, gap: 12 },
  playlistLead: { width: 28, alignItems: 'center' },
  playlistTitle: { fontSize: 15.5 },
  meta: { fontSize: 12.5, marginTop: 3 },
  overflow: { paddingLeft: 10, paddingVertical: 10, marginRight: -4 },
});