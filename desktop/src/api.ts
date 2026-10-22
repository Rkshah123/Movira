import type { StorageAdapter } from '@shared/storage';

export const moviraApi: MoviraBridge = (window as unknown as { movira: MoviraBridge }).movira;

/** One audio/subtitle stream as reported by the ffmpeg probe (B / V keys). */
export interface ProbeStream {
  /** Type-relative ordinal: `0:a:N` / `0:s:N`, NOT the absolute stream number. */
  index: number;
  codec: string;
  language: string | null;
  isDefault: boolean;
  /** Audio only: channel count, or null when ffmpeg could not name it. Needed
   *  to hand ffmpeg `-ac N` when transcoding (see streamServer buildArgs). */
  channels?: number | null;
}

export interface MoviraBridge {
  openFiles(): Promise<string[]>;
  /** Single-select picker behind the Media menu's "Open File". */
  openFileSingle(): Promise<string | null>;
  openFolder(): Promise<string | null>;
  openSubtitleFile(): Promise<string | null>;
  listMedia(folder: string): Promise<{ path: string; size: number; mtime: number }[]>;
  exists(p: string): Promise<boolean>;
  stat(p: string): Promise<{ size: number; mtime: number } | null>;
  readSubtitle(p: string): Promise<string>;
  readImage(p: string): Promise<string>;
  readMetadata(p: string): Promise<Record<string, unknown> | null>;
  probeVideo(p: string): Promise<{ width?: number; height?: number; duration?: number } | null>;
  probeMedia(p: string): Promise<{
    durationSec: number | null;
    fps: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
    width: number | null;
    height: number | null;
    audioStreams?: ProbeStream[];
    subtitleStreams?: ProbeStream[];
  } | null>;
  /** Extract one embedded subtitle stream as WebVTT (V key). */
  readEmbeddedSubtitle(src: string, index: number): Promise<string | null>;
  startStream(opts: {
    src: string;
    mode: 'remux' | 'remux-tc-audio' | 'transcode-video' | 'transcode-audio-only';
    seek?: number;
    audioCodec?: string;
    audioTrack?: number;
    audioChannels?: number | null;
  }): Promise<{ ok: boolean; url?: string; id?: string; reason?: string }>;
  stopStream(id: string): Promise<boolean>;
  stopStreams(): Promise<boolean>;
  decideMode(
    probe: { videoCodec: string | null; audioCodec: string | null },
    audioCaps: string[],
    videoCaps: string[]
  ): Promise<'remux' | 'remux-tc-audio' | 'transcode-video' | 'transcode-audio-only'>;
  searchSubtitlesOnline(
    name: string,
    langs?: string[]
  ): Promise<Array<{ id: string; label: string; language: string; url: string; format: 'srt' | 'vtt' }>>;
  downloadSubtitleOnline(id: string): Promise<string>;
  setFullscreen(flag: boolean): Promise<void>;
  isFullscreen(): Promise<boolean>;
  quit(): Promise<void>;
  openDefaultApps(): Promise<boolean>;
  consumeLaunchedFiles(): Promise<string[]>;
  onOpenMediaPaths(cb: (paths: string[]) => void): void;
  version(): Promise<string>;
  setPowerSaveBlocker(on: boolean): Promise<boolean>;
  onMediaKey(cb: (action: string) => void): void;
  onFullscreenChanged(cb: (fs: boolean) => void): void;
}

export function createStorageAdapter(): StorageAdapter {
  const mem = new Map<string, unknown>();
  return {
    async get(key) {
      const raw = localStorage.getItem(`movira:${key}`);
      if (raw === null) return mem.get(key) ?? null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      mem.set(key, value);
      localStorage.setItem(`movira:${key}`, JSON.stringify(value));
    },
    async delete(key) {
      mem.delete(key);
      localStorage.removeItem(`movira:${key}`);
    },
  };
}
