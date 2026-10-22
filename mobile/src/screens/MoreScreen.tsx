import React, { useMemo, useState } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { useAppState } from '../state/AppContext';
import { useNav } from '../state/NavContext';
import { useTheme, metrics } from '../theme';
import TopBar, { OverflowMenu, type TopBarAction } from '../ui/TopBar';
import { OutlineButton, SectionHeader, Tile, Divider, Row } from '../ui/Controls';

/**
 * More tab.
 *
 * The reference layout: a row of outlined Settings / About buttons, then the
 * "Streams" section with a single "New stream" tile.
 */
export default function MoreScreen() {
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
        <View style={styles.actions}>
          <OutlineButton label="Settings" icon="gear" onPress={() => nav.push({ name: 'settings' })} />
          <OutlineButton label="About" icon="info" onPress={() => nav.push({ name: 'about' })} />
        </View>

        <SectionHeader
          title="Streams"
          right={
            <OutlineButton label="All" onPress={() => nav.push({ name: 'search', kind: 'all' })} />
          }
        />
        <View style={styles.tiles}>
          <Tile label="New stream" icon="plus" onPress={() => nav.push({ name: 'search', kind: 'all' })} />
          <Tile label="Equalizer" icon="sliders" meta={app.settings.equalizerEnabled ? 'On' : 'Off'} onPress={() => nav.push({ name: 'equalizer' })} />
        </View>

        <SectionHeader title="Library" />
        <View style={styles.tiles}>
          <Tile label="Favourite" icon="heartOutline" meta={`${app.favorites.length} items`} onPress={() => nav.push({ name: 'collection', kind: 'favorites', title: 'Favourite' })} />
          <Tile label="Playlists" icon="playlist" meta={`${app.playlists.length} playlists`} onPress={() => nav.setTab('playlists')} />
        </View>

        <SectionHeader title="Now playing" />
        <Divider />
        {app.current ? (
          <Row
            title={app.current.title}
            subtitle={`${app.playing ? 'Playing' : 'Paused'}  ·  ${app.current.type === 'video' ? 'Video' : 'Audio'}`}
            icon={app.current.type === 'video' ? 'video' : 'audio'}
            onPress={() => nav.push({ name: 'nowPlaying' })}
          />
        ) : (
          <Row title="Nothing playing" subtitle="Choose a video or a track to start" icon="more" />
        )}

        <View style={{ height: metrics.screenPadding }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: metrics.screenPadding, paddingTop: metrics.screenPadding, paddingBottom: 24 },
  actions: { flexDirection: 'row', gap: metrics.screenPadding },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: metrics.screenPadding },
});