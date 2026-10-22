import React, { useMemo, useState } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { useAppState } from '../state/AppContext';
import { useNav, type SettingsPageKey } from '../state/NavContext';
import { useTheme } from '../theme';
import TopBar, { BarTitle, BarButton } from '../ui/TopBar';
import { Row, SectionHeader, Divider } from '../ui/Controls';

/**
 * Settings root.
 *
 * Only the sections Movira actually implements are listed, in the same order
 * and wording as the references. Pages Movira does not have (Casting, Android
 * Auto, Parental control, Remote access) are not rendered at all rather than
 * shown as dead entries.
 */
export default function SettingsScreen() {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();

  const pages = useMemo(() => {
    const list: { key: SettingsPageKey; label: string; icon: 'storage' | 'video' | 'audio' | 'subtitles' | 'wifi' | 'shield' | 'palette' | 'wrench'; summary?: string }[] = [
      { key: 'mediaLibrary', label: 'Media library folders', icon: 'storage', summary: 'Select directories to include in the media library' },
      { key: 'video', label: 'Video', icon: 'video' },
      { key: 'audio', label: 'Audio', icon: 'audio' },
      { key: 'subtitles', label: 'Subtitles', icon: 'subtitles' },
      { key: 'network', label: 'Network', icon: 'wifi' },
      { key: 'permissions', label: 'Permissions', icon: 'shield' },
      { key: 'interface', label: 'Interface', icon: 'palette' },
      { key: 'extra', label: 'Extra settings', icon: 'wrench' },
    ];
    return list;
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <TopBar
        left={<BarButton icon="back" label="Back" onPress={() => nav.pop()} />}
        center={<BarTitle text="Settings" accent />}
        actions={[{ icon: 'search', label: 'Search settings', onPress: () => nav.push({ name: 'search', kind: 'all' }) }]}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <SectionHeader title="Media library" />
        <Row
          title="Media library folders"
          subtitle="Select directories to include in the media library"
          icon="storage"
          chevron
          onPress={() => nav.push({ name: 'settingsPage', page: 'mediaLibrary' })}
        />
        <Divider />

        {pages
          .filter((p) => p.key !== 'mediaLibrary')
          .map((p, i, arr) => (
            <View key={p.key}>
              <Row
                title={p.label}
                icon={p.icon}
                chevron
                onPress={() => nav.push({ name: 'settingsPage', page: p.key })}
              />
              {i < arr.length - 1 ? <Divider /> : null}
            </View>
          ))}
        <View style={{ height: 28 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 24 },
});