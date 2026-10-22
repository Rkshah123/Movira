import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MobileThemeMode } from './theme';

/**
 * Mobile-local preferences.
 *
 * Deliberately separate from `PlaybackSettings` in `@shared`: that type is
 * compiled into the desktop app, and this redesign must not change shared
 * behaviour. Every toggle the settings tree exposes is persisted here under a
 * single AsyncStorage key.
 */
export interface MobileSettings {
  // Appearance
  theme: MobileThemeMode;

  // Media library
  autoScan: boolean;
  saveVideoQueue: boolean;
  saveAudioQueue: boolean;

  // Video
  pipMode: 'background' | 'pip' | 'stop' | 'audio-only';
  hardwareAccel: 'auto' | 'disabled' | 'full';
  orientation: 'auto' | 'portrait' | 'landscape';
  resumeAfterCall: boolean;
  stopOnSwipe: boolean;
  digitalAudioOut: boolean;
  preferredAudioLanguage: string;
  resumePlayedAudio: 'always' | 'never';

  // Headset
  detectHeadset: boolean;
  resumeOnHeadset: boolean;
  ignoreHeadsetButtons: boolean;

  // Subtitles
  autoLoadSubtitles: boolean;
  subtitleEncoding: string;
  preferredSubtitleLanguage: string;
  subtitleSize: 'tiny' | 'normal' | 'large' | 'huge';
  boldSubtitles: boolean;
  subtitleOpacity: number;
  subtitleShadow: boolean;
  subtitleShadowColor: 'black' | 'white' | 'grey';
  subtitleOutline: boolean;
  subtitleOutlineColor: 'black' | 'white' | 'grey';
  subtitleOutlineOpacity: number;
  subtitleBackground: boolean;
  subtitleBackgroundColor: 'black' | 'white' | 'grey';

  // Network
  streamAction: 'none' | 'stop' | 'resume';

  // Interface
  /**
   * Legacy flag from the first release: its default (`true`) was persisted
   * wholesale into stored settings by any later toggle, so it can no longer
   * distinguish "user asked for resume" from "default leaked". Kept only so
   * old payloads keep parsing; nothing reads it any more.
   */
  continuePlayback: boolean;
  /** Reload the last session's item when Movira opens — loaded paused, so
   * tapping the item is still what starts playback. */
  resumeOnLaunch: boolean;
  startMinimized: boolean;
  oneInstance: boolean;
  allowMetadataNetwork: boolean;

  // Privacy
  incognito: boolean;

  // Extra settings
  equalizerEnabled: boolean;
  castingEnabled: boolean;
  parentalControl: boolean;
  remoteAccess: boolean;
  androidAuto: boolean;
}

export const defaultMobileSettings: MobileSettings = {
  theme: 'system',
  autoScan: true,
  saveVideoQueue: false,
  saveAudioQueue: false,
  pipMode: 'background',
  hardwareAccel: 'auto',
  orientation: 'auto',
  resumeAfterCall: true,
  stopOnSwipe: false,
  digitalAudioOut: false,
  preferredAudioLanguage: '',
  resumePlayedAudio: 'always',
  detectHeadset: true,
  resumeOnHeadset: false,
  ignoreHeadsetButtons: false,
  autoLoadSubtitles: true,
  subtitleEncoding: 'Default (Windows-1252)',
  preferredSubtitleLanguage: '',
  subtitleSize: 'normal',
  boldSubtitles: false,
  subtitleOpacity: 1,
  subtitleShadow: true,
  subtitleShadowColor: 'black',
  subtitleOutline: true,
  subtitleOutlineColor: 'black',
  subtitleOutlineOpacity: 1,
  subtitleBackground: false,
  subtitleBackgroundColor: 'black',
  streamAction: 'none',
  continuePlayback: false,
  resumeOnLaunch: false,
  startMinimized: false,
  oneInstance: true,
  allowMetadataNetwork: false,
  incognito: false,
  equalizerEnabled: false,
  castingEnabled: false,
  parentalControl: false,
  remoteAccess: false,
  androidAuto: false,
};

const KEY = 'movira:mobileSettings';

type Listener = (s: MobileSettings) => void;

class SettingsStore {
  private value: MobileSettings = { ...defaultMobileSettings };
  private listeners = new Set<Listener>();
  private loaded = false;

  async load(): Promise<MobileSettings> {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<MobileSettings>;
        this.value = { ...defaultMobileSettings, ...parsed };
      }
    } catch {
      // Corrupt payload: fall back to defaults rather than blocking startup.
      this.value = { ...defaultMobileSettings };
    }
    this.loaded = true;
    this.notify();
    return this.value;
  }

  get(): MobileSettings {
    return this.value;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async set<K extends keyof MobileSettings>(key: K, value: MobileSettings[K]): Promise<void> {
    if (this.value[key] === value) return;
    this.value = { ...this.value, [key]: value };
    this.notify();
    await this.persist();
  }

  async patch(patch: Partial<MobileSettings>): Promise<void> {
    this.value = { ...this.value, ...patch };
    this.notify();
    await this.persist();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.value);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify() {
    for (const fn of this.listeners) fn(this.value);
  }

  private async persist() {
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify(this.value));
    } catch {
      // A failed write only means the preference resets next launch; never crash.
    }
  }
}

export const settingsStore = new SettingsStore();