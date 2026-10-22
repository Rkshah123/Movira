import React, { useMemo, useRef, useState } from 'react';
import { View, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { Linking } from 'react-native';
import type { SettingsPageKey } from '../state/NavContext';
import { useAppState } from '../state/AppContext';
import { useNav } from '../state/NavContext';
import { useTheme } from '../theme';
import TopBar, { BarTitle, BarButton } from '../ui/TopBar';
import { Row, SectionHeader, Divider, CheckToggle, TrackSlider } from '../ui/Controls';
import ChoiceDialog, { type Choice } from '../ui/ChoiceDialog';
import { formatSize } from '@shared';
import { getFSInfo } from '@dr.pogodin/react-native-fs';
import { listDeviceStorages } from '../devices';

const TITLES: Record<SettingsPageKey, string> = {
  mediaLibrary: 'Media library folders',
  video: 'Video',
  audio: 'Audio',
  headset: 'Headset',
  subtitles: 'Subtitles',
  network: 'Network',
  permissions: 'Permissions',
  interface: 'Interface',
  extra: 'Extra settings',
  advanced: 'Advanced',
};

type DialogId =
  | 'orientation'
  | 'hardware'
  | 'pip'
  | 'stream'
  | 'size'
  | 'outlineColor'
  | 'shadowColor'
  | 'backgroundColor'
  | 'encoding'
  | 'audioLang'
  | 'subtitleLang'
  | 'resumeAudio'
  | 'theme';

const ORIENTATIONS: Choice[] = [
  { label: 'Automatic (sensor)', value: 'auto' },
  { label: 'Portrait', value: 'portrait' },
  { label: 'Landscape', value: 'landscape' },
];

const HARDWARE: Choice[] = [
  { label: 'Automatic', value: 'auto' },
  { label: 'Disabled', value: 'disabled' },
  { label: 'Full', value: 'full' },
];

const PIP: Choice[] = [
  { label: 'Keep playing in the background', value: 'background' },
  { label: 'Show a picture-in-picture window', value: 'pip' },
  { label: 'Stop playback', value: 'stop' },
  { label: 'Keep audio only', value: 'audio-only' },
];

const STREAM: Choice[] = [
  { label: 'Do nothing', value: 'none' },
  { label: 'Stop playback', value: 'stop' },
  { label: 'Resume playback', value: 'resume' },
];

const SIZES: Choice[] = [
  { label: 'Tiny', value: 'tiny' },
  { label: 'Normal', value: 'normal' },
  { label: 'Large', value: 'large' },
  { label: 'Huge', value: 'huge' },
];

const OUTLINE_COLORS: Choice[] = [
  { label: 'Black', value: 'black' },
  { label: 'White', value: 'white' },
  { label: 'Grey', value: 'grey' },
];

const ENCODINGS: Choice[] = [
  { label: 'Default (Windows-1252)', value: 'Default (Windows-1252)' },
  { label: 'UTF-8', value: 'UTF-8' },
  { label: 'UTF-16', value: 'UTF-16' },
];

const THEMES: Choice[] = [
  { label: 'Follow the system', value: 'system' },
  { label: 'Always dark', value: 'dark' },
  { label: 'Always light', value: 'light' },
  { label: 'Ember', value: 'ember' },
  { label: 'Phosphor', value: 'phosphor' },
  { label: 'Nebula', value: 'nebula' },
  { label: 'Tide', value: 'tide' },
];

const RESUME_AUDIO: Choice[] = [
  { label: 'Always', value: 'always' },
  { label: 'Never', value: 'never' },
];

/**
 * Every settings sub-page in one component, dispatched on the route's page key.
 * The markup follows the reference pages: accent section headers, rows with a
 * title + summary line, checkboxes, radio dialogs and sliders.
 */
export default function SettingsPages({ page }: { page: SettingsPageKey }) {
  const t = useTheme();
  const app = useAppState();
  const nav = useNav();
  const { width } = useWindowDimensions();
  const [dialog, setDialog] = useState<DialogId | null>(null);
  const [storageInfo, setStorageInfo] = useState<{ label: string; free: number; total: number }[]>([]);

  // Hidden activation: four taps on "Software version" (Extra settings →
  // Advanced) open the dedicated version screen. The counter collapses after
  // a short gap, so a normal single, double or triple tap never does anything.
  const versionTaps = useRef<number[]>([]);
  const onSoftwareVersionTap = () => {
    const now = Date.now();
    const recent = versionTaps.current.filter((at) => now - at < 3000);
    recent.push(now);
    versionTaps.current = recent;
    if (recent.length >= 4) {
      versionTaps.current = [];
      nav.push({ name: 'version' });
    }
  };

  const s = app.settings;
  const sliderWidth = Math.min(280, width - 80);

  // Storage totals are fetched lazily: the page may be opened without ever
  // needing the numbers, and stat() is comparatively slow.
  React.useEffect(() => {
    if (page !== 'mediaLibrary' || storageInfo.length) return;
    let live = true;
    void (async () => {
      const list = await listDeviceStorages();
      const info = await Promise.all(
        list.map(async (st) => {
          try {
            const f = await getFSInfo();
            return { label: st.label, free: f.freeSpace, total: f.totalSpace };
          } catch {
            return null;
          }
        })
      );
      if (live) setStorageInfo(info.filter((x): x is { label: string; free: number; total: number } => x !== null));
    })();
    return () => {
      live = false;
    };
  }, [page, storageInfo.length]);

  const header = (
    <TopBar
      left={<BarButton icon="back" label="Back" onPress={() => nav.pop()} />}
      center={<BarTitle text={TITLES[page]} accent />}
      actions={[{ icon: 'search', label: 'Search settings', onPress: () => nav.push({ name: 'search', kind: 'all' }) }]}
    />
  );

  const choiceDialog = () => {
    switch (dialog) {
      case 'orientation':
        return (
          <ChoiceDialog
            visible
            title="Video screen orientation"
            choices={ORIENTATIONS}
            selected={s.orientation}
            onSelect={(v) => app.setSetting('orientation', v as typeof s.orientation)}
            onDismiss={() => setDialog(null)}
          />
        );
      case 'hardware':
        return (
          <ChoiceDialog
            visible
            title="Hardware Acceleration"
            choices={HARDWARE}
            selected={s.hardwareAccel}
            onSelect={(v) => app.setSetting('hardwareAccel', v as typeof s.hardwareAccel)}
            onDismiss={() => setDialog(null)}
          />
        );
      case 'pip':
        return (
          <ChoiceDialog
            visible
            title="Background/PiP mode"
            choices={PIP}
            selected={s.pipMode}
            onSelect={(v) => app.setSetting('pipMode', v as typeof s.pipMode)}
            onDismiss={() => setDialog(null)}
          />
        );
      case 'stream':
        return (
          <ChoiceDialog
            visible
            title="Action for streams when the connection is metered"
            choices={STREAM}
            selected={s.streamAction}
            onSelect={(v) => app.setSetting('streamAction', v as typeof s.streamAction)}
            onDismiss={() => setDialog(null)}
          />
        );
      case 'size':
        return (
          <ChoiceDialog
            visible
            title="Subtitles Size"
            choices={SIZES}
            selected={s.subtitleSize}
            onSelect={(v) => app.setSetting('subtitleSize', v as typeof s.subtitleSize)}
            onDismiss={() => setDialog(null)}
          />
        );
      case 'outlineColor':
        return (
          <ChoiceDialog
            visible
            title="Outline colour"
            choices={OUTLINE_COLORS}
            selected={s.subtitleOutlineColor}
            onSelect={(v) => app.setSetting('subtitleOutlineColor', v as typeof s.subtitleOutlineColor)}
            onDismiss={() => setDialog(null)}
          />
        );
      case 'shadowColor':
        return (
          <ChoiceDialog
            visible
            title="Shadow colour"
            choices={OUTLINE_COLORS}
            selected={s.subtitleShadowColor}
            onSelect={(v) => app.setSetting('subtitleShadowColor', v as typeof s.subtitleShadowColor)}
            onDismiss={() => setDialog(null)}
          />
        );
      case 'backgroundColor':
        return (
          <ChoiceDialog
            visible
            title="Background colour"
            choices={OUTLINE_COLORS}
            selected={s.subtitleBackgroundColor}
            onSelect={(v) => app.setSetting('subtitleBackgroundColor', v as typeof s.subtitleBackgroundColor)}
            onDismiss={() => setDialog(null)}
          />
        );
      case 'encoding':
        return (
          <ChoiceDialog
            visible
            title="Subtitle text encoding"
            choices={ENCODINGS}
            selected={s.subtitleEncoding}
            onSelect={(v) => app.setSetting('subtitleEncoding', v)}
            onDismiss={() => setDialog(null)}
          />
        );
      case 'audioLang':
        return (
          <ChoiceDialog
            visible
            title="Preferred audio language"
            choices={[
              { label: 'No language preference', value: '' },
              { label: 'English', value: 'en' },
              { label: 'Arabic', value: 'ar' },
              { label: 'Urdu', value: 'ur' },
              { label: 'Hindi', value: 'hi' },
              { label: 'French', value: 'fr' },
              { label: 'Spanish', value: 'es' },
              { label: 'German', value: 'de' },
            ]}
            selected={s.preferredAudioLanguage}
            onSelect={(v) => app.setSetting('preferredAudioLanguage', v)}
            onDismiss={() => setDialog(null)}
          />
        );
      case 'subtitleLang':
        return (
          <ChoiceDialog
            visible
            title="Preferred subtitle language"
            choices={[
              { label: 'No language preference', value: '' },
              { label: 'English', value: 'en' },
              { label: 'Arabic', value: 'ar' },
              { label: 'Urdu', value: 'ur' },
              { label: 'Hindi', value: 'hi' },
            ]}
            selected={s.preferredSubtitleLanguage}
            onSelect={(v) => app.setSetting('preferredSubtitleLanguage', v)}
            onDismiss={() => setDialog(null)}
          />
        );
      case 'resumeAudio':
        return (
          <ChoiceDialog
            visible
            title="Resume played audio"
            choices={RESUME_AUDIO}
            selected={s.resumePlayedAudio}
            onSelect={(v) => app.setSetting('resumePlayedAudio', v as typeof s.resumePlayedAudio)}
            onDismiss={() => setDialog(null)}
          />
        );
      case 'theme':
        return (
          <ChoiceDialog
            visible
            title="Theme"
            choices={THEMES}
            selected={s.theme}
            onSelect={(v) => app.setSetting('theme', v as typeof s.theme)}
            onDismiss={() => setDialog(null)}
          />
        );
      default:
        return null;
    }
  };

  const body = useMemo(() => {
    switch (page) {
      case 'mediaLibrary':
        return (
          <>
            <SectionHeader title="Scanning" />
            <Row
              title="Automatically scan device for new or deleted media at application startup"
              right={<CheckToggle checked={s.autoScan} onPress={() => app.setSetting('autoScan', !s.autoScan)} label="Automatically scan device" />}
            />
            <Divider />

            <SectionHeader title="Media library folders" />
            <Row
              title="Add a folder to the media library"
              icon="folder"
              chevron
              onPress={() => nav.push({ name: 'folder', path: app.storages[0]?.path ?? '/', title: 'Select directories to include', selectMode: true })}
            />
            <Divider />
            {app.services.library.getFolders().map((f) => (
              <View key={f.id}>
                <Row
                  title={f.label}
                  subtitle={f.path}
                  icon="folder"
                  right={
                    <BarButton
                      icon="trash"
                      label={`Remove ${f.label}`}
                      color={t.accent}
                      size={20}
                      onPress={() => void app.removeLibraryFolder(f.id)}
                    />
                  }
                />
                <Divider />
              </View>
            ))}

            {storageInfo.length ? (
              <>
                <SectionHeader title="Device storage" />
                {storageInfo.map((info) => (
                  <View key={info.label}>
                    <Row
                      title={info.label}
                      subtitle={`${formatSize(info.free)} free of ${formatSize(info.total)}`}
                      icon="storage"
                    />
                    <Divider />
                  </View>
                ))}
              </>
            ) : null}

            <SectionHeader title="Playback history" />
            <Row
              title="Save all media played in History section"
              subtitle="Movira never records or stores watch history — this stays off permanently."
            />
            <Row
              title="Video play queue history"
              subtitle="Resume the video where you left off"
              right={<CheckToggle checked={s.saveVideoQueue} onPress={() => app.setSetting('saveVideoQueue', !s.saveVideoQueue)} label="Video play queue history" />}
            />
            <Row
              title="Audio play queue history"
              subtitle="Resume the track where you left off"
              right={<CheckToggle checked={s.saveAudioQueue} onPress={() => app.setSetting('saveAudioQueue', !s.saveAudioQueue)} label="Audio play queue history" />}
            />
            <View style={{ height: 24 }} />
          </>
        );

      case 'video':
        return (
          <>
            <SectionHeader title="Video" />
            <Row
              title="Background/PiP mode"
              subtitle="Select Movira behaviour when you switch to another application from video playback"
              value={PIP.find((p) => p.value === s.pipMode)?.label}
              onPress={() => setDialog('pip')}
            />
            <Divider />
            <Row
              title="Hardware Acceleration"
              subtitle={
                s.hardwareAccel === 'disabled'
                  ? 'Disabled: better stability'
                  : s.hardwareAccel === 'full'
                    ? 'Full: may improve performance further'
                    : 'Decoding: may improve performance'
              }
              value={HARDWARE.find((p) => p.value === s.hardwareAccel)?.label}
              onPress={() => setDialog('hardware')}
            />
            <Divider />
            <Row
              title="Video screen orientation"
              subtitle={ORIENTATIONS.find((o) => o.value === s.orientation)?.label}
              onPress={() => setDialog('orientation')}
            />
            <Divider />
            <SectionHeader title="Audio" />
            <Row
              title="Resume playback after a call"
              subtitle="Stay in pause otherwise"
              right={<CheckToggle checked={s.resumeAfterCall} onPress={() => app.setSetting('resumeAfterCall', !s.resumeAfterCall)} label="Resume playback after a call" />}
            />
            <Row
              title="Stop on application swipe"
              subtitle="Stop playback when application is dismissed"
              right={<CheckToggle checked={s.stopOnSwipe} onPress={() => app.setSetting('stopOnSwipe', !s.stopOnSwipe)} label="Stop on application swipe" />}
            />
            <Divider />
            <Row
              title="Digital audio output (passthrough)"
              subtitle={s.digitalAudioOut ? 'Digital audio output enabled' : 'Audio digital output disabled'}
              right={<CheckToggle checked={s.digitalAudioOut} onPress={() => app.setSetting('digitalAudioOut', !s.digitalAudioOut)} label="Digital audio output" />}
            />
            <Row
              title="Preferred audio language"
              subtitle={s.preferredAudioLanguage ? s.preferredAudioLanguage.toUpperCase() : 'No language preference'}
              onPress={() => setDialog('audioLang')}
            />
            <Divider />
            <SectionHeader title="Headset" />
            <Row
              title="Detect headset"
              subtitle="Detect headset insertion and removal"
              right={<CheckToggle checked={s.detectHeadset} onPress={() => app.setSetting('detectHeadset', !s.detectHeadset)} label="Detect headset" />}
            />
            <Row
              title="Resume on headset insertion"
              subtitle="Pause otherwise"
              right={<CheckToggle checked={s.resumeOnHeadset} onPress={() => app.setSetting('resumeOnHeadset', !s.resumeOnHeadset)} label="Resume on headset insertion" />}
            />
            <Row
              title="Ignore headset media button"
              subtitle="Ignore the media keys on a connected headset"
              right={<CheckToggle checked={s.ignoreHeadsetButtons} onPress={() => app.setSetting('ignoreHeadsetButtons', !s.ignoreHeadsetButtons)} label="Ignore headset media button" />}
            />
            <View style={{ height: 24 }} />
          </>
        );

      case 'audio':
        return (
          <>
            <SectionHeader title="Audio" />
            <Row
              title="Preferred audio language"
              subtitle={s.preferredAudioLanguage ? s.preferredAudioLanguage.toUpperCase() : 'No language preference'}
              onPress={() => setDialog('audioLang')}
            />
            <Divider />
            <Row
              title="Resume played audio"
              subtitle={s.resumePlayedAudio === 'always' ? 'Always' : 'Never'}
              onPress={() => setDialog('resumeAudio')}
            />
            <Divider />
            <Row
              title="Digital audio output (passthrough)"
              subtitle={s.digitalAudioOut ? 'Digital audio output enabled' : 'Audio digital output disabled'}
              right={<CheckToggle checked={s.digitalAudioOut} onPress={() => app.setSetting('digitalAudioOut', !s.digitalAudioOut)} label="Digital audio output" />}
            />
            <Divider />
            <SectionHeader title="Headset" />
            <Row
              title="Detect headset"
              subtitle="Detect headset insertion and removal"
              right={<CheckToggle checked={s.detectHeadset} onPress={() => app.setSetting('detectHeadset', !s.detectHeadset)} label="Detect headset" />}
            />
            <Row
              title="Resume on headset insertion"
              subtitle="Pause otherwise"
              right={<CheckToggle checked={s.resumeOnHeadset} onPress={() => app.setSetting('resumeOnHeadset', !s.resumeOnHeadset)} label="Resume on headset insertion" />}
            />
            <Row
              title="Ignore headset media button"
              right={<CheckToggle checked={s.ignoreHeadsetButtons} onPress={() => app.setSetting('ignoreHeadsetButtons', !s.ignoreHeadsetButtons)} label="Ignore headset media button" />}
            />
            <View style={{ height: 24 }} />
          </>
        );

      case 'headset':
        return (
          <>
            <SectionHeader title="Headset" />
            <Row
              title="Detect headset"
              subtitle="Detect headset insertion and removal"
              right={<CheckToggle checked={s.detectHeadset} onPress={() => app.setSetting('detectHeadset', !s.detectHeadset)} label="Detect headset" />}
            />
            <Row
              title="Resume on headset insertion"
              subtitle="Pause otherwise"
              right={<CheckToggle checked={s.resumeOnHeadset} onPress={() => app.setSetting('resumeOnHeadset', !s.resumeOnHeadset)} label="Resume on headset insertion" />}
            />
            <Row
              title="Ignore headset media button"
              right={<CheckToggle checked={s.ignoreHeadsetButtons} onPress={() => app.setSetting('ignoreHeadsetButtons', !s.ignoreHeadsetButtons)} label="Ignore headset media button" />}
            />
            <View style={{ height: 24 }} />
          </>
        );

      case 'subtitles':
        return (
          <>
            <SectionHeader title="Subtitles presets" />
            <Row
              title="Auto load subtitles"
              right={<CheckToggle checked={s.autoLoadSubtitles} onPress={() => app.setSetting('autoLoadSubtitles', !s.autoLoadSubtitles)} label="Auto load subtitles" />}
            />
            <Row
              title="Subtitle text encoding"
              subtitle={s.subtitleEncoding}
              onPress={() => setDialog('encoding')}
            />
            <Row
              title="Preferred subtitle language"
              subtitle={s.preferredSubtitleLanguage ? s.preferredSubtitleLanguage.toUpperCase() : 'No language preference'}
              onPress={() => setDialog('subtitleLang')}
            />
            <Divider />

            <SectionHeader title="Subtitles font style" />
            <Row title="Subtitles Size" subtitle={SIZES.find((x) => x.value === s.subtitleSize)?.label} onPress={() => setDialog('size')} />
            <Row
              title="Bold subtitles"
              right={<CheckToggle checked={s.boldSubtitles} onPress={() => app.setSetting('boldSubtitles', !s.boldSubtitles)} label="Bold subtitles" />}
            />
            <Divider />
            <Row title="Opacity" subtitle={`${Math.round(s.subtitleOpacity * 100)}%`} />
            <View style={styles.sliderRow}>
              <TrackSlider value={s.subtitleOpacity} onChange={(v) => app.setSetting('subtitleOpacity', v)} width={sliderWidth} />
            </View>
            <Divider />

            <SectionHeader title="Subtitles Background" />
            <Row
              title="Subtitles Background"
              right={<CheckToggle checked={s.subtitleBackground} onPress={() => app.setSetting('subtitleBackground', !s.subtitleBackground)} label="Subtitles Background" />}
            />
            <Row
              title="Colour"
              subtitle={OUTLINE_COLORS.find((x) => x.value === s.subtitleBackgroundColor)?.label}
              onPress={() => setDialog('backgroundColor')}
            />
            <Divider />

            <SectionHeader title="Subtitles shadow" />
            <Row
              title="Subtitles shadow"
              right={<CheckToggle checked={s.subtitleShadow} onPress={() => app.setSetting('subtitleShadow', !s.subtitleShadow)} label="Subtitles shadow" />}
            />
            <Row
              title="Colour"
              subtitle={OUTLINE_COLORS.find((x) => x.value === s.subtitleShadowColor)?.label}
              onPress={() => setDialog('shadowColor')}
            />
            <Divider />
            <Row title="Opacity" subtitle={`${Math.round(s.subtitleOpacity * 100)}%`} />
            <View style={styles.sliderRow}>
              <TrackSlider value={s.subtitleOpacity} onChange={(v) => app.setSetting('subtitleOpacity', v)} width={sliderWidth} />
            </View>
            <Divider />

            <SectionHeader title="Subtitles outline" />
            <Row
              title="Subtitles outline"
              right={<CheckToggle checked={s.subtitleOutline} onPress={() => app.setSetting('subtitleOutline', !s.subtitleOutline)} label="Subtitles outline" />}
            />
            <Row title="Size" subtitle={SIZES.find((x) => x.value === s.subtitleSize)?.label} onPress={() => setDialog('size')} />
            <Row title="Colour" subtitle={OUTLINE_COLORS.find((x) => x.value === s.subtitleOutlineColor)?.label} onPress={() => setDialog('outlineColor')} />
            <Divider />
            <Row title="Opacity" subtitle={`${Math.round(s.subtitleOutlineOpacity * 100)}%`} />
            <View style={styles.sliderRow}>
              <TrackSlider
                value={s.subtitleOutlineOpacity}
                onChange={(v) => app.setSetting('subtitleOutlineOpacity', v)}
                width={sliderWidth}
              />
            </View>
            <View style={{ height: 24 }} />
          </>
        );

      case 'network':
        return (
          <>
            <SectionHeader title="Network" />
            <Row
              title="Action for streams when the connection is metered"
              subtitle={STREAM.find((x) => x.value === s.streamAction)?.label}
              onPress={() => setDialog('stream')}
            />
            <Divider />
            <SectionHeader title="Caching" />
            <Row title="Allow metadata network access" subtitle="Keep this off to stay fully offline" right={<CheckToggle checked={s.allowMetadataNetwork} onPress={() => app.setSetting('allowMetadataNetwork', !s.allowMetadataNetwork)} label="Allow metadata network access" />} />
            <View style={{ height: 24 }} />
          </>
        );

      case 'permissions':
        return (
          <>
            <SectionHeader title="Permissions" />
            <Row
              title="Storage access"
              subtitle={
                app.storages.length
                  ? `${app.storages.length} storage location${app.storages.length === 1 ? '' : 's'} readable`
                  : 'No storage location could be read'
              }
              icon="storage"
              onPress={() => {
                void Linking.openSettings().catch(() => {});
              }}
            />
            <Divider />
            <Row
              title="Notification permission"
              subtitle="Required for playback controls"
              icon="info"
              onPress={() => {
                void Linking.openSettings().catch(() => {});
              }}
            />
            <View style={{ height: 24 }} />
          </>
        );

      case 'interface':
        return (
          <>
            <SectionHeader title="Interface" />
            <Row
              title="Theme"
              subtitle={THEMES.find((x) => x.value === s.theme)?.label}
              onPress={() => setDialog('theme')}
            />
            <Divider />
            <Row
              title="Continue playback"
              subtitle="Resume the last item when Movira opens"
              right={<CheckToggle checked={s.resumeOnLaunch} onPress={() => app.setSetting('resumeOnLaunch', !s.resumeOnLaunch)} label="Continue playback" />}
            />
            <Row
              title="Start Minimized"
              subtitle="Open Movira in the background"
              right={<CheckToggle checked={s.startMinimized} onPress={() => app.setSetting('startMinimized', !s.startMinimized)} label="Start Minimized" />}
            />
            <Row
              title="Allow only one instance"
              subtitle="Open Movira links in the running window"
              right={<CheckToggle checked={s.oneInstance} onPress={() => app.setSetting('oneInstance', !s.oneInstance)} label="Allow only one instance" />}
            />
            <Divider />
            <SectionHeader title="Privacy" />
            <Row
              title="Incognito mode"
              subtitle="Do not show recently played items on the home screen"
              right={<CheckToggle checked={s.incognito} onPress={() => app.setSetting('incognito', !s.incognito)} label="Incognito mode" />}
            />
            <View style={{ height: 24 }} />
          </>
        );

      case 'extra':
        return (
          <>
            <SectionHeader title="Extra settings" />
            <Row
              title="Equalizer"
              subtitle={s.equalizerEnabled ? 'Enabled' : 'Disabled'}
              icon="sliders"
              chevron
              onPress={() => nav.push({ name: 'equalizer' })}
            />
            <Divider />
            <Row
              title="Network streams"
              subtitle="Play an address from the clipboard or a web link"
              icon="wifi"
              onPress={() => nav.push({ name: 'search', kind: 'all' })}
            />
            <Divider />
            <SectionHeader title="Advanced" />
            <Row
              title="Software version"
              subtitle="Movira for Android"
              icon="wrench"
              onPress={onSoftwareVersionTap}
            />
            <View style={{ height: 24 }} />
          </>
        );

      case 'advanced':
        return (
          <>
            <SectionHeader title="Advanced" />
            <Row title="Software version" subtitle="Movira for Android" icon="wrench" onPress={onSoftwareVersionTap} />
            <Divider />
            <Row title="Media library size" subtitle={`${app.media.length} items indexed`} icon="storage" />
            <View style={{ height: 24 }} />
          </>
        );

      default:
        return null;
    }
  }, [page, s, app, nav, sliderWidth, storageInfo, t]);

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      {header}
      <ScrollView contentContainerStyle={styles.content}>{body}</ScrollView>
      {choiceDialog()}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 24 },
  sliderRow: { paddingHorizontal: 22, paddingBottom: 14, alignItems: 'flex-start' },
});