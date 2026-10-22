import { contextBridge, ipcRenderer } from 'electron';

/** One audio/subtitle stream as reported by the ffmpeg probe (B / V keys). */
export interface ProbeStream {
  /** Type-relative ordinal: `0:a:N` / `0:s:N`, NOT the absolute stream number. */
  index: number;
  codec: string;
  language: string | null;
  isDefault: boolean;
}

const api = {
  openFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:openFile'),
  openFileSingle: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFileSingle'),
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  openSubtitleFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:openSubtitle'),
  listMedia: (folder: string): Promise<{ path: string; size: number; mtime: number }[]> =>
    ipcRenderer.invoke('fs:listMedia', folder),
  exists: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:exists', p),
  stat: (p: string): Promise<{ size: number; mtime: number } | null> => ipcRenderer.invoke('fs:stat', p),
  readSubtitle: (p: string): Promise<string> => ipcRenderer.invoke('fs:readText', p),
  readImage: (p: string): Promise<string> => ipcRenderer.invoke('fs:readDataUrl', p),
  readMetadata: (p: string): Promise<Record<string, unknown> | null> => ipcRenderer.invoke('media:metadata', p),
  probeVideo: (p: string): Promise<{ width?: number; height?: number; duration?: number } | null> =>
    ipcRenderer.invoke('media:probeVideo', p),
  searchSubtitlesOnline: (name: string, langs?: string[]): Promise<Array<{ id: string; label: string; language: string; url: string; format: 'srt' | 'vtt' }>> =>
    ipcRenderer.invoke('subtitles:searchOnline', name, langs),
  downloadSubtitleOnline: (id: string): Promise<string> => ipcRenderer.invoke('subtitles:downloadOnline', id),
  setFullscreen: (flag: boolean): Promise<void> => ipcRenderer.invoke('app:setFullscreen', flag),
  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke('app:isFullscreen'),
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
  openDefaultApps: (): Promise<boolean> => ipcRenderer.invoke('app:openDefaultApps'),
  // File-association support: files passed at launch / via "Open with".
  consumeLaunchedFiles: (): Promise<string[]> => ipcRenderer.invoke('app:consumeLaunchedFiles'),
  onOpenMediaPaths: (cb: (paths: string[]) => void): void => {
    ipcRenderer.on('open-media-paths', (_e, paths) => cb(paths));
  },
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
  setPowerSaveBlocker: (on: boolean): Promise<boolean> => ipcRenderer.invoke('power:keepAwake', on),
  onMediaKey: (cb: (action: string) => void): void => {
    ipcRenderer.on('mediaKey', (_e, action) => cb(action));
  },
  onFullscreenChanged: (cb: (fs: boolean) => void): void => {
    ipcRenderer.on('fullscreenChanged', (_e, fs) => cb(fs));
  },
  probeMedia: (p: string): Promise<{ durationSec: number | null; fps: number | null; videoCodec: string | null; audioCodec: string | null; width: number | null; height: number | null; audioStreams?: ProbeStream[]; subtitleStreams?: ProbeStream[] } | null> =>
    ipcRenderer.invoke('media:probe', p),
  readEmbeddedSubtitle: (src: string, index: number): Promise<string | null> =>
    ipcRenderer.invoke('media:readEmbeddedSubtitle', src, index),
  startStream: (opts: { src: string; mode: 'remux' | 'remux-tc-audio' | 'transcode-video' | 'transcode-audio-only'; seek?: number; audioCodec?: string; audioTrack?: number; audioChannels?: number | null }): Promise<{ ok: boolean; url?: string; reason?: string }> =>
    ipcRenderer.invoke('media:startStream', opts),
  stopStream: (id: string): Promise<boolean> => ipcRenderer.invoke('media:stopStream', id),
  stopStreams: (): Promise<boolean> => ipcRenderer.invoke('media:stopStreams'),
  decideMode: (probe: { videoCodec: string | null; audioCodec: string | null }, audioCaps: string[], videoCaps: string[]): Promise<string> =>
    ipcRenderer.invoke('media:decideMode', probe, audioCaps, videoCaps),
};

export type MoviraApi = typeof api;

contextBridge.exposeInMainWorld('movira', api);
