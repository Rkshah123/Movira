import React, { useMemo, useState } from 'react';
import { View, FlatList, TextInput, StyleSheet, TouchableOpacity, Text, Keyboard } from 'react-native';
import type { MediaItem } from '@shared';
import { useAppState } from '../state/AppContext';
import { useNav } from '../state/NavContext';
import { useTheme, metrics } from '../theme';
import TopBar, { BarTitle, BarButton } from '../ui/TopBar';
import Icon from '../ui/Icon';
import { Divider } from '../ui/Controls';
import EmptyState from '../ui/EmptyState';

/**
 * Search page. `kind` narrows the search to one tab's media, which is how the
 * search icon on the Video and Audio bars behaves in the references.
 */
export default function SearchScreen({ kind }: { kind: 'video' | 'audio' | 'all' }) {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();
  const [query, setQuery] = useState('');

  const pool = useMemo<MediaItem[]>(() => {
    if (kind === 'video') return app.videos;
    if (kind === 'audio') return app.audios;
    return app.media;
  }, [kind, app.videos, app.audios, app.media]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? pool.filter((m) => {
          const hay = `${m.title} ${m.artist ?? ''} ${m.album ?? ''} ${m.genre ?? ''} ${m.path}`.toLowerCase();
          return hay.includes(q);
        })
      : pool;
    return [...base].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
  }, [pool, query]);

  const playlistHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return app.playlists.filter((p) => p.name.toLowerCase().includes(q));
  }, [app.playlists, query]);

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <TopBar
        left={<BarButton icon="back" label="Back" onPress={() => nav.pop()} />}
        center={<BarTitle text="Search" accent />}
      />

      <View style={[styles.searchBar, { backgroundColor: t.bg1, borderColor: t.border }]}>
        <Icon name="search" size={17} color={t.dim} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={kind === 'video' ? 'Search videos' : kind === 'audio' ? 'Search audio' : 'Search everything'}
          placeholderTextColor={t.dim}
          selectionColor={t.accent}
          style={[styles.input, { color: t.text }]}
          autoFocus
          returnKeyType="search"
          allowFontScaling={false}
        />
        {query.length > 0 ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={() => setQuery('')}
          >
            <Icon name="close" size={16} color={t.dim} />
          </TouchableOpacity>
        ) : null}
      </View>

      {results.length === 0 && playlistHits.length === 0 ? (
        <EmptyState
          message={query.trim() ? `No results for "${query.trim()}"` : 'Type to search your media library'}
        />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(i) => i.id}
          ItemSeparatorComponent={Divider}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.content}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.row}
              onPress={() => {
                Keyboard.dismiss();
                app.play(results, results.indexOf(item));
              }}
            >
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
          ListFooterComponent={
            playlistHits.length ? (
              <>
                <Text style={[styles.footerHead, { color: t.accent }]}>Playlists</Text>
                {playlistHits.map((p) => (
                  <TouchableOpacity
                    key={p.id}
                    style={styles.row}
                    onPress={() => {
                      Keyboard.dismiss();
                      nav.push({ name: 'playlist', id: p.id });
                    }}
                  >
                    <View style={styles.lead}>
                      <Icon name="playlist" size={24} color={t.dim} />
                    </View>
                    <View style={styles.body}>
                      <Text style={[styles.title, { color: t.text }]} numberOfLines={1}>
                        {p.name}
                      </Text>
                      <Text style={[styles.meta, { color: t.dim }]}>{p.items.length} items</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 24 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: metrics.screenPadding,
    marginVertical: 12,
    paddingHorizontal: 12,
    height: 44,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, fontSize: 15, padding: 0 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 60, paddingHorizontal: metrics.screenPadding, paddingVertical: 8, gap: 12 },
  lead: { width: 26, alignItems: 'center' },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 15.5 },
  meta: { fontSize: 12.5, marginTop: 3 },
  footerHead: { fontSize: 15, paddingHorizontal: metrics.screenPadding, paddingTop: 18, paddingBottom: 6 },
});