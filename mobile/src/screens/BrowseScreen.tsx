import React, { useMemo, useState } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { useAppState } from '../state/AppContext';
import { useNav } from '../state/NavContext';
import { useTheme, metrics } from '../theme';
import TopBar, { OverflowMenu, type TopBarAction } from '../ui/TopBar';
import { Tile, SectionHeader, Divider } from '../ui/Controls';
import { formatSize } from '@shared';

/**
 * Browse tab.
 *
 * Two grouped grids exactly as in the references: a collections row
 * (Favourite · Download · Movies · Music) and a "Storages" row listing each
 * readable volume found on the device.
 */
export default function BrowseScreen() {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();
  const [menuOpen, setMenuOpen] = useState(false);

  const actions = useMemo<TopBarAction[]>(
    () => [{ icon: 'overflow', label: 'More options', onPress: () => setMenuOpen((v) => !v) }],
    []
  );

  const menuItems = useMemo(
    () => [
      { label: 'Incognito mode', checked: app.settings.incognito, onPress: () => app.setSetting('incognito', !app.settings.incognito) },
      { label: 'Refresh', checked: false, onPress: () => void app.refreshLibrary() },
    ],
    [app.settings.incognito, app]
  );

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <TopBar title="Movira" actions={actions} />
      <OverflowMenu visible={menuOpen} onDismiss={() => setMenuOpen(false)} items={menuItems} />

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.grid}>
          <View style={styles.cell}>
          <Tile
            label="Favourite"
            icon="heartOutline"
            meta={`${app.favorites.length} items`}
            onPress={() => nav.push({ name: 'collection', kind: 'favorites', title: 'Favourite' })}
          />
          </View>
          <View style={styles.cell}>
          <Tile
            label="Download"
            icon="download"
            meta="Offline files"
            onPress={() => nav.push({ name: 'collection', kind: 'downloads', title: 'Download' })}
          />
          </View>
          <View style={styles.cell}>
          <Tile
            label="Movies"
            icon="movie"
            meta={`${app.videos.length} videos`}
            onPress={() => nav.push({ name: 'collection', kind: 'movies', title: 'Movies' })}
          />
          </View>
          <View style={styles.cell}>
          <Tile
            label="Music"
            icon="music"
            meta={`${app.audios.length} tracks`}
            onPress={() => nav.push({ name: 'collection', kind: 'music', title: 'Music' })}
          />
          </View>
        </View>

        <SectionHeader title="Storages" />
        <View style={styles.grid}>
          {app.storages.length === 0 ? (
            <Tile label="No storage found" icon="storage" onPress={() => void app.refreshLibrary()} />
          ) : (
            app.storages.map((s) => (
              <Tile
                key={s.id}
                label={s.label}
                icon={s.kind === 'sd' ? 'sd' : 'storage'}
                meta={s.totalSpace ? formatSize(s.totalSpace) : undefined}
                onPress={() => nav.push({ name: 'folder', path: s.path, title: s.label })}
              />
            ))
          )}
        </View>

        {app.services.library.getFolders().length > 0 ? (
          <>
            <SectionHeader title="Media library folders" />
            {app.services.library.getFolders().map((f) => (
              <View key={f.id}>
                <Tile label={f.label} icon="folder" meta={f.path} wide onPress={() => nav.push({ name: 'folder', path: f.path, title: f.label })} />
                <View style={{ height: 8 }} />
              </View>
            ))}
          </>
        ) : null}

        <Divider />
        <View style={{ height: metrics.screenPadding }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: metrics.screenPadding, paddingTop: metrics.screenPadding, paddingBottom: 24 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: metrics.screenPadding },
  // Two tiles per row: the reference shows Favourite/Download above Movies/Music.
  cell: { flexBasis: '47%', flexGrow: 1, maxWidth: '48%' },
});