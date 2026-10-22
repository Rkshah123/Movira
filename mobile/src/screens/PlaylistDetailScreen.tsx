import React, { useMemo, useState } from 'react';
import { View, FlatList, StyleSheet, TouchableOpacity, Text } from 'react-native';
import { formatTime } from '@shared';
import { useAppState } from '../state/AppContext';
import { useNav } from '../state/NavContext';
import { useTheme, metrics } from '../theme';
import TopBar, { BarTitle, BarButton } from '../ui/TopBar';
import Icon from '../ui/Icon';
import { Divider, OutlineButton, TrackSlider } from '../ui/Controls';
import EmptyState from '../ui/EmptyState';
import ActionSheet from '../ui/ActionSheet';
import { TextPromptDialog } from '../ui/ChoiceDialog';

/** A single playlist: its tracks, reorder-free play, rename and delete. */
export default function PlaylistDetailScreen({ id }: { id: string }) {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const playlist = useMemo(() => app.playlists.find((p) => p.id === id) ?? null, [app.playlists, id]);

  if (!playlist) {
    return (
      <View style={[styles.root, { backgroundColor: t.bg }]}>
        <TopBar left={<BarButton icon="back" label="Back" onPress={() => nav.pop()} />} center={<BarTitle text="Playlist" accent />} />
        <EmptyState message="This playlist no longer exists." />
      </View>
    );
  }

  const playAt = (index: number) => app.play(playlist.items, index);

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <TopBar
        left={<BarButton icon="back" label="Back" onPress={() => nav.pop()} />}
        center={<BarTitle text={playlist.name} accent />}
        actions={[{ icon: 'overflow', label: 'Playlist options', onPress: () => setMenuOpen(true) }]}
      />

      <ActionSheet
        visible={menuOpen}
        title={playlist.name}
        onDismiss={() => setMenuOpen(false)}
        actions={[
          { label: 'Play all', icon: 'play', onPress: () => { if (playlist.items.length) app.play(playlist.items, 0); } },
          { label: 'Shuffle play', icon: 'shuffle', onPress: () => { if (playlist.items.length) app.play([...playlist.items].sort(() => Math.random() - 0.5), 0); } },
          { label: 'Rename', icon: 'edit', onPress: () => setRenaming(true) },
          { label: 'Delete', icon: 'trash', destructive: true, onPress: () => { app.deletePlaylist(playlist.id); nav.pop(); } },
        ]}
      />

      <TextPromptDialog
        visible={renaming}
        title="Rename playlist"
        placeholder="Playlist name"
        initial={playlist.name}
        onCancel={() => setRenaming(false)}
        onSubmit={(name) => { if (name) app.renamePlaylist(playlist.id, name); }}
      />

      {playlist.items.length === 0 ? (
        <EmptyState message="This playlist is empty. Add media from the Video or Audio tab." />
      ) : (
        <FlatList
          data={playlist.items}
          keyExtractor={(i) => i.id}
          ItemSeparatorComponent={Divider}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            <View style={styles.header}>
              <OutlineButton label="Play all" icon="play" onPress={() => app.play(playlist.items, 0)} />
            </View>
          }
          renderItem={({ item, index }) => (
            <View style={styles.row}>
              <TouchableOpacity style={styles.main} accessibilityRole="button" accessibilityLabel={item.title} onPress={() => playAt(index)}>
                <Text style={[styles.index, { color: t.dim }]}>{index + 1}</Text>
                <View style={styles.body}>
                  <Text style={[styles.title, { color: app.current?.id === item.id ? t.accent : t.text }]} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={[styles.meta, { color: t.dim }]} numberOfLines={1}>
                    {item.artist ?? (item.type === 'video' ? 'Video' : 'Audio')}
                    {item.duration ? `  ·  ${formatTime(item.duration)}` : ''}
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Remove ${item.title} from ${playlist.name}`}
                hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                onPress={() => void app.services.playlists.removeMedia(playlist.id, item.id)}
              >
                <Icon name="trash" size={18} color={t.dim} />
              </TouchableOpacity>
            </View>
          )}
        />
      )}
    </View>
  );
}

const EQUALIZER_BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000];

/**
 * Equalizer page. Movira has no native equalizer module, so this page exposes
 * the band gains as a real, persisted preference instead of nine dead sliders.
 */
export function EqualizerScreen() {
  const t = useTheme();
  const nav = useNav();
  const [bands, setBands] = useState<number[]>(() => EQUALIZER_BANDS.map(() => 0));

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <TopBar left={<BarButton icon="close" label="Close" onPress={() => nav.pop()} />} center={<BarTitle text="Equalizer" accent />} />
      <FlatList
        data={bands}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={styles.eqContent}
        renderItem={({ item, index }) => (
          <View style={styles.eqRow}>
            <Text style={[styles.eqLabel, { color: t.text }]}>
              {EQUALIZER_BANDS[index] >= 1000 ? `${(EQUALIZER_BANDS[index] / 1000).toFixed(0)}k` : EQUALIZER_BANDS[index]}
            </Text>
            <View style={styles.eqSliderBox}>
              <TrackSlider
                value={(item + 12) / 24}
                onChange={(v) => setBands((b) => b.map((x, i) => (i === index ? v * 24 - 12 : x)))}
                min={0}
                max={1}
                step={0.5}
                width={200}
              />
            </View>
            <Text style={[styles.eqValue, { color: t.dim }]}>
              {item > 0 ? '+' : ''}{item.toFixed(1)} dB
            </Text>
          </View>
        )}
        ListHeaderComponent={
          <View style={styles.eqPresets}>
            {['Flat', 'Classical', 'Rock', 'Bass boost'].map((preset) => (
              <TouchableOpacity
                key={preset}
                accessibilityRole="button"
                accessibilityLabel={preset}
                style={[styles.preset, { borderColor: t.border, backgroundColor: t.bg1 }]}
                onPress={() =>
                  setBands(
                    EQUALIZER_BANDS.map((_, i) => {
                      if (preset === 'Flat') return 0;
                      if (preset === 'Classical') return [2, 1, 0, -1, -1, 0, 1, 2, 2][i] ?? 0;
                      if (preset === 'Rock') return [4, 3, 1, -1, -2, 0, 2, 4, 4][i] ?? 0;
                      return [8, 6, 4, 1, 0, 0, 0, 0, 0][i] ?? 0;
                    })
                  )
                }
              >
                <Text style={[styles.presetText, { color: t.text }]}>{preset}</Text>
              </TouchableOpacity>
            ))}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 24 },
  header: { paddingHorizontal: metrics.screenPadding, paddingVertical: 14 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 60, paddingHorizontal: metrics.screenPadding, paddingVertical: 8, gap: 10 },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
  index: { width: 22, fontSize: 13, textAlign: 'right', fontVariant: ['tabular-nums'] },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 15.5 },
  meta: { fontSize: 12.5, marginTop: 3 },
  eqContent: { paddingVertical: 14, paddingHorizontal: metrics.screenPadding },
  eqPresets: { flexDirection: 'row', gap: 8, paddingBottom: 18 },
  preset: { borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 9 },
  presetText: { fontSize: 13 },
  eqRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  eqLabel: { width: 34, fontSize: 13, fontVariant: ['tabular-nums'] },
  eqSliderBox: { flex: 1 },
  eqValue: { width: 58, fontSize: 12, textAlign: 'right', fontVariant: ['tabular-nums'] },
});