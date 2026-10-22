import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, FlatList, StyleSheet, TouchableOpacity, Text, ActivityIndicator } from 'react-native';
import type { MediaItem } from '@shared';
import { detectMediaType, baseName } from '@shared';
import { useAppState } from '../state/AppContext';
import { useNav } from '../state/NavContext';
import { useTheme, metrics } from '../theme';
import TopBar, { BarTitle, BarButton, OverflowMenu } from '../ui/TopBar';
import Icon from '../ui/Icon';
import { Divider } from '../ui/Controls';
import EmptyState from '../ui/EmptyState';
import { readFolder, type FolderNode, type ScannedEntry } from '../devices';

/**
 * Device folder browser.
 *
 * Doubles as the "Select directories to include" page from the media-library
 * settings: `selectMode` reveals a tick per folder and adds the chosen paths to
 * the library instead of navigating into them.
 */
export default function FolderBrowserScreen({
  path,
  title,
  selectMode,
}: {
  path: string;
  title: string;
  selectMode?: boolean;
}) {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();
  const [node, setNode] = useState<FolderNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setNode(await readFolder(path));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (p: string) =>
    setChosen((c) => (c.includes(p) ? c.filter((x) => x !== p) : [...c, p]));

  const confirm = useCallback(() => {
    if (!chosen.length) return;
    void (async () => {
      for (const p of chosen) {
        try {
          await app.addLibraryFolder(p);
        } catch (e) {
          console.warn('Movira: could not add folder', p, e);
        }
      }
      nav.pop();
    })();
  }, [chosen, app, nav]);

  const rows = useMemo(() => {
    if (!node) return [];
    const folders = node.subfolders.map((f) => ({ kind: 'folder' as const, path: f.path, name: f.name }));
    const files = node.files.map((f) => ({ kind: 'file' as const, path: f.path, name: f.name, entry: f }));
    return [...folders, ...files];
  }, [node]);

  const menuItems = useMemo(
    () => [
      { label: 'Add this folder to the library', checked: false, onPress: () => { void app.addLibraryFolder(path); } },
      { label: 'Refresh', checked: false, onPress: () => void load() },
    ],
    [app, path, load]
  );

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <TopBar
        left={<BarButton icon="back" label="Back" onPress={() => nav.pop()} />}
        center={<BarTitle text={title} accent />}
        actions={selectMode ? [] : [{ icon: 'overflow', label: 'Folder options', onPress: () => setMenuOpen((v) => !v) }]}
      />
      <OverflowMenu visible={menuOpen} onDismiss={() => setMenuOpen(false)} items={menuItems} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={t.accent} />
        </View>
      ) : rows.length === 0 ? (
        <EmptyState
          message={
            node?.error
              ? `This folder could not be read.\n${node.error}`
              : 'This folder has no media and no sub-folders.'
          }
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.path}
          ItemSeparatorComponent={Divider}
          contentContainerStyle={styles.content}
          renderItem={({ item }) => {
            if (item.kind === 'folder') {
              const on = chosen.includes(item.path);
              return (
                <TouchableOpacity
                  style={styles.row}
                  accessibilityRole="button"
                  accessibilityLabel={item.name}
                  onPress={() =>
                    selectMode ? toggle(item.path) : nav.push({ name: 'folder', path: item.path, title: item.name })
                  }
                >
                  <View style={styles.lead}>
                    <Icon name="folder" size={26} color={t.dim} />
                  </View>
                  <Text style={[styles.title, { color: t.text }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {selectMode ? (
                    <View style={[styles.tick, { borderColor: on ? t.accent : t.dim, backgroundColor: on ? t.accent : 'transparent' }]}>
                      {on && <Icon name="check" size={13} color={t.bg1} />}
                    </View>
                  ) : (
                    <Icon name="chevronRight" size={17} color={t.dim} />
                  )}
                </TouchableOpacity>
              );
            }
            const type = detectMediaType(item.name);
            return (
              <TouchableOpacity
                style={styles.row}
                accessibilityRole="button"
                accessibilityLabel={item.name}
                onPress={() => {
                  const items = rows
                    .filter((r) => r.kind === 'file' && detectMediaType(r.name))
                    .map((r) => toItem((r as { entry: ScannedEntry }).entry));
                  const idx = items.findIndex((i) => i.path === item.path);
                  if (idx >= 0) app.play(items, idx);
                }}
              >
                <View style={styles.lead}>
                  <Icon name={type === 'video' ? 'video' : 'audio'} size={24} color={t.dim} />
                </View>
                <Text style={[styles.title, { color: t.text }]} numberOfLines={1}>
                  {item.name}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {selectMode ? (
        <View style={[styles.footer, { borderTopColor: t.border, backgroundColor: t.bg1 }]}>
          <Text style={[styles.footerText, { color: t.dim }]}>{chosen.length} selected</Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Add selected folders to the media library"
            style={[styles.confirm, { backgroundColor: t.accent }]}
            onPress={confirm}
          >
            <Text style={[styles.confirmText, { color: t.bg1 }]}>Add to library</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

function toItem(entry: ScannedEntry): MediaItem {
  const type = detectMediaType(entry.name) ?? 'video';
  return {
    id: `${entry.path}-${entry.size}`,
    type,
    title: baseName(entry.name).replace(/\.[^.]+$/, ''),
    path: entry.path,
    size: entry.size,
    addedAt: entry.mtime || Date.now(),
  };
}

/**
 * Browse collection page (Favourite / Download / Movies / Music). Each kind maps
 * to a real slice of the library so no entry point is a dead end.
 */
export function CollectionScreen({ kind, title }: { kind: 'favorites' | 'downloads' | 'movies' | 'music'; title: string }) {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();

  const items = useMemo<MediaItem[]>(() => {
    switch (kind) {
      case 'favorites':
        return app.favorites;
      case 'movies':
        return app.videos;
      case 'music':
        return app.audios;
      default:
        return app.media.filter((m) => m.path.startsWith('content://') || m.path.startsWith('/storage/emulated/0/Download'));
    }
  }, [kind, app.favorites, app.videos, app.audios, app.media]);

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <TopBar
        left={<BarButton icon="back" label="Back" onPress={() => nav.pop()} />}
        center={<BarTitle text={title} accent />}
        actions={[{ icon: 'search', label: 'Search', onPress: () => nav.push({ name: 'search', kind: kind === 'music' ? 'audio' : kind === 'movies' ? 'video' : 'all' }) }]}
      />
      {items.length === 0 ? (
        <EmptyState
          message={
            kind === 'favorites'
              ? 'No favourite yet.'
              : kind === 'downloads'
                ? 'Nothing in your downloads folder.'
                : kind === 'movies'
                  ? 'No video files found.'
                  : 'No audio files found.'
          }
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          ItemSeparatorComponent={Divider}
          contentContainerStyle={styles.content}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => app.play(items, items.indexOf(item))}>
              <View style={styles.lead}>
                <Icon name={item.type === 'video' ? 'video' : 'audio'} size={24} color={t.dim} />
              </View>
              <View style={styles.body}>
                <Text style={[styles.title, { color: t.text }]} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={[styles.meta, { color: t.dim }]} numberOfLines={1}>
                  {item.artist ?? (item.type === 'video' ? 'Video' : 'Audio')}
                </Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 58, paddingHorizontal: metrics.screenPadding, paddingVertical: 8, gap: 12 },
  lead: { width: 26, alignItems: 'center' },
  body: { flex: 1, minWidth: 0 },
  title: { flex: 1, fontSize: 15.5 },
  meta: { fontSize: 12.5, marginTop: 3 },
  tick: { width: 20, height: 20, borderRadius: 3, borderWidth: 1.6, alignItems: 'center', justifyContent: 'center' },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
  footerText: { fontSize: 13 },
  confirm: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: 4 },
  confirmText: { fontSize: 14, fontWeight: '600' },
});