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
import Icon, { type IconName } from '../ui/Icon';
import { pickFile } from '@dr.pogodin/react-native-fs';

const NO_MEDIA =
  'No media files found, please transfer some files to your device or adjust your preferences.';

type AudioTab = 'artists' | 'albums' | 'tracks' | 'genres' | 'playlists';

interface Group {
  key: string;
  name: string;
  icon: IconName;
  items: MediaItem[];
}

/** Buckets tracks by a metadata field, sorted case-insensitively. */
function group(items: MediaItem[], pick: (m: MediaItem) => string | undefined, unknownName: string): Group[] {
  const map = new Map<string, MediaItem[]>();
  for (const m of items) {
    const raw = pick(m);
    const name = raw && raw.trim() ? raw.trim() : unknownName;
    const list = map.get(name);
    if (list) list.push(m);
    else map.set(name, [m]);
  }
  return [...map.entries()].map(([name, list]) => ({ key: name, name, icon: 'music', items: list }));
}

const ICONS: Record<AudioTab, IconName> = {
  artists: 'person',
  albums: 'movie',
  tracks: 'audio',
  genres: 'music',
  playlists: 'playlist',
};

/**
 * Audio tab.
 *
 * Sub-navigation follows the references exactly: Artists · Albums · Tracks ·
 * Genres · Playlists, horizontally scrollable so all five fit on a narrow phone.
 */
export default function AudioScreen() {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();
  const [tab, setTab] = useState<AudioTab>('tracks');
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { open: openItemMenu, node: itemMenuNode } = useMediaItemMenu();

  const groups = useMemo<Group[]>(() => {
    switch (tab) {
      case 'artists':
        return group(app.audios, (m) => m.artist, 'Unknown artist').map((g) => ({ ...g, icon: 'person' }));
      case 'albums':
        return group(app.audios, (m) => m.album, 'Unknown album').map((g) => ({ ...g, icon: 'movie' }));
      case 'genres':
        return group(app.audios, (m) => m.genre, 'Unknown genre').map((g) => ({ ...g, icon: 'music' }));
      default:
        return [];
    }
  }, [app.audios, tab]);

  const tracks = useMemo(() => [...app.audios].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })), [app.audios]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await app.refreshLibrary();
    } finally {
      setRefreshing(false);
    }
  }, [app]);

  const pickFiles = useCallback(async () => {
    try {
      const uris = await pickFile({ mimeTypes: ['audio/*'], pickerType: 'multipleFiles' });
      await app.addPickedFiles(uris, 'audio');
    } catch {
      // Picker dismissed.
    }
  }, [app]);

  const actions = useMemo<TopBarAction[]>(
    () => [
      { icon: 'search', label: 'Search', onPress: () => nav.push({ name: 'search', kind: 'audio' }) },
      { icon: 'overflow', label: 'More options', onPress: () => setMenuOpen((v) => !v) },
    ],
    [nav]
  );

  const menuItems = useMemo(
    () => [
      { label: 'Incognito mode', checked: app.settings.incognito, onPress: () => app.setSetting('incognito', !app.settings.incognito) },
      { label: 'Refresh', checked: false, onPress: () => void onRefresh() },
    ],
    [app.settings.incognito, app, onRefresh]
  );

  const playlistItems = app.playlists;

  const listBody = () => {
    if (tab === 'playlists') {
      if (!playlistItems.length) return <EmptyState message="No playlist found." />;
      return (
        <FlatList
          data={playlistItems}
          keyExtractor={(p) => p.id}
          ItemSeparatorComponent={Divider}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => nav.push({ name: 'playlist', id: item.id })}>
              <View style={styles.lead}>
                <Icon name="playlist" size={26} color={t.dim} />
              </View>
              <View style={styles.body}>
                <Text style={[styles.title, { color: t.text }]} numberOfLines={1}>
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
      );
    }

    if (tab === 'tracks') {
      if (!tracks.length) return <EmptyState message={NO_MEDIA} actionLabel="Go to media library preferences" onAction={() => nav.push({ name: 'settingsPage', page: 'mediaLibrary' })} />;
      return (
        <FlatList
          data={tracks}
          keyExtractor={(i) => i.id}
          ItemSeparatorComponent={Divider}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.bg1} />}
          renderItem={({ item }) => (
            <MediaRow
              item={item}
              active={app.current?.id === item.id}
              onPress={() => app.play(tracks, tracks.indexOf(item))}
              showFavorite
              favorite={app.isFavorite(item.id)}
              onToggleFavorite={() => app.toggleFavorite(item)}
              onOverflow={() => openItemMenu(item, tracks)}
            />
          )}
          ListFooterComponent={
            <View style={styles.footer}>
              <OutlineButton label="Add files from device" icon="plus" onPress={() => void pickFiles()} />
            </View>
          }
        />
      );
    }

    if (!groups.length) {
      return (
        <EmptyState
          message={NO_MEDIA}
          actionLabel="Go to media library preferences"
          onAction={() => nav.push({ name: 'settingsPage', page: 'mediaLibrary' })}
        />
      );
    }
    return (
      <FlatList
        data={groups}
        keyExtractor={(g) => g.key}
        ItemSeparatorComponent={Divider}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.bg1} />}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => app.play(item.items, 0)}>
            <View style={styles.lead}>
              <Icon name={ICONS[tab]} size={26} color={t.dim} />
            </View>
            <View style={styles.body}>
              <Text style={[styles.title, { color: t.text }]} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={[styles.meta, { color: t.dim }]}>
                {item.items.length} {item.items.length === 1 ? 'track' : 'tracks'}
              </Text>
            </View>
            <View style={styles.overflow}>
              <Icon name="overflow" size={20} color={t.dim} />
            </View>
          </TouchableOpacity>
        )}
      />
    );
  };

  const counts = {
    artists: new Set(app.audios.map((m) => m.artist ?? 'Unknown artist')).size,
    albums: new Set(app.audios.map((m) => m.album ?? 'Unknown album')).size,
    genres: new Set(app.audios.map((m) => m.genre ?? 'Unknown genre')).size,
  };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <TopBar title="Movira" actions={actions} />
      <OverflowMenu visible={menuOpen} onDismiss={() => setMenuOpen(false)} items={menuItems} />
      {itemMenuNode}
      <SubTabs
        tabs={[
          { key: 'artists', label: 'Artists', count: counts.artists },
          { key: 'albums', label: 'Albums', count: counts.albums },
          { key: 'tracks', label: 'Tracks', count: app.audios.length },
          { key: 'genres', label: 'Genres', count: counts.genres },
          { key: 'playlists', label: 'Playlists', count: app.playlists.length },
        ]}
        active={tab}
        onChange={(k) => setTab(k as AudioTab)}
      />
      <View style={styles.fill}>{listBody()}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1 },
  listContent: { paddingBottom: 24 },
  footer: { paddingHorizontal: 14, paddingTop: 18 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 62, paddingHorizontal: 14, paddingVertical: 8, gap: 12 },
  lead: { width: 28, alignItems: 'center' },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 15.5 },
  meta: { fontSize: 12.5, marginTop: 3 },
  overflow: { paddingLeft: 10, paddingVertical: 10, marginRight: -4 },
});