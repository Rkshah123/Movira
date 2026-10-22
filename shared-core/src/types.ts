export interface MediaItem {
  id: string;
  type: 'video' | 'audio';
  title: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: number;
  duration?: number;
  size?: number;
  width?: number;
  height?: number;
  format?: string;
  artwork?: string;
  path: string;
  addedAt: number;
}

export interface Playlist {
  id: string;
  name: string;
  items: MediaItem[];
  createdAt: number;
  updatedAt: number;
}

export type RepeatMode = 'off' | 'all' | 'one';
export type ThemeMode = 'dark' | 'light' | 'system';

export interface QueueState {
  items: MediaItem[];
  index: number;
  repeat: RepeatMode;
  shuffle: boolean;
}

export interface RecentEntry {
  item: MediaItem;
  lastPlayed: number;
  position: number;
}

export interface SubtitleTrack {
  id: string;
  label: string;
  language?: string;
  url?: string;
  content?: string;
}

export interface PlaybackSettings {
  defaultSpeed: number;
  seekInterval: number;
  repeat: RepeatMode;
  defaultVolume: number;
  openFullscreen: boolean;
  autoLoadSubtitles: boolean;
  subtitleLanguage: string;
  resumePlayback: boolean;
  confirmExit: boolean;
  autoScan: boolean;
  theme: ThemeMode;
}

export const defaultSettings: PlaybackSettings = {
  defaultSpeed: 1,
  seekInterval: 10,
  repeat: 'off',
  defaultVolume: 0.8,
  openFullscreen: false,
  autoLoadSubtitles: true,
  subtitleLanguage: 'any',
  resumePlayback: true,
  confirmExit: false,
  autoScan: true,
  theme: 'dark',
};

export type MediaType = 'video' | 'audio' | null;

/**
 * Full file-extension support lists (spec §1 and §3).
 *
 * NOTE (spec §2/§4/§19): an extension only identifies a container, never the
 * actual codec. These lists mean "attempt playback", not "guaranteed playable"
 * — actual decode support depends on the platform media engine, and unsupported
 * codec combinations must surface as a clean playback error (handled by the
 * engine error path), never a freeze or crash.
 */
export const videoExtensions = [
  'mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'asf', 'flv', 'f4v',
  'ts', 'm2ts', 'mts', 'vob', 'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'mpv',
  '3gp', '3g2', 'ogv', 'ogg', 'divx', 'xvid', 'rm', 'rmvb', 'mxf', 'dv',
  'mod', 'tod',
];
export const audioExtensions = [
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'alac', 'aiff',
  'aif', 'aifc', 'amr', 'ape', 'mka', 'ac3', 'eac3', 'dts', 'ra', 'rm',
  'mid', 'midi',
];
export const subtitleExtensions = ['srt', 'vtt'];

/** Extensions that stream MPEG-TS / program streams with unreliable duration + seeking metadata. */
export const trickySeekExtensions = new Set(['ts', 'm2ts', 'mts', 'vob', 'mpg', 'mpeg', 'mpe']);

/** Extensions that commonly stream instead of serving a seekable byte range. */
export const streamLikeExtensions = new Set([...trickySeekExtensions, 'flv', 'rm', 'rmvb', 'mkv', 'webm']);

export function fileExtension(filename: string): string {
  return filename.toLowerCase().split('.').pop() ?? '';
}

export function detectMediaType(filename: string): MediaType {
  const ext = fileExtension(filename);
  if (videoExtensions.includes(ext)) return 'video';
  if (audioExtensions.includes(ext)) return 'audio';
  return null;
}

/** Structural probe so these helpers work in any runtime that exposes canPlayType. */
export interface MediaCapabilityProbe {
  canPlayType(type: string): string;
}

export function canPlayType(mediaEl: MediaCapabilityProbe, container: string, codecs: string): boolean {
  try {
    return mediaEl.canPlayType(`video/${container}; codecs="${codecs}"`) !== '';
  } catch {
    return false;
  }
}

/**
 * Best-effort capability check for a file (spec §8: distinguish container from
 * codec support where the platform exposes it). Returns a user-facing reason
 * when the engine definitely cannot decode the combination, or null when the
 * engine does not advertise a decision — in which case playback is attempted
 * and any failure is handled by the regular media-error path.
 */
export function detectUnsupportedCodec(
  mediaEl: MediaCapabilityProbe,
  filename: string,
  isAudioOnly: boolean
): string | null {
  const ext = fileExtension(filename);
  const videoC = (codecs: string) => canPlayType(mediaEl, 'mp4', codecs);
  const audioC = (codecs: string) => mediaEl.canPlayType(`audio/mp4; codecs="${codecs}"`) !== '';
  const audioFl = (codecs: string) => mediaEl.canPlayType(`audio/flac; codecs="${codecs}"`) !== '';

  if (!isAudioOnly) {
    switch (ext) {
      case 'webm':
        if (!canPlayType(mediaEl, 'webm', 'vp9') && !canPlayType(mediaEl, 'webm', 'vp8') && mediaEl.canPlayType('video/webm') === '') {
          return 'WebM video is not supported by this system decoder';
        }
        break;
      case 'ogv':
        if (mediaEl.canPlayType('video/ogg') === '') return 'Ogg video (Theora) is not supported by this system decoder';
        break;
      case 'wmv':
      case 'asf':
      case 'rm':
      case 'rmvb':
      case 'divx':
      case 'xvid':
        // Legacy/proprietary containers Chromium cannot demux at all.
        return `${ext.toUpperCase()} is not supported by the built-in player engine`;
      default:
        break;
    }
    // H.264 is by far the most common codec inside mp4/mkv/mov/ts/avi/3gp.
    if (['mp4', 'm4v', 'mov', 'mkv', 'ts', 'm2ts', 'mts', '3gp', '3g2', 'avi', 'flv', 'f4v'].includes(ext)) {
      if (!videoC('avc1') && !videoC('hvc1') && !videoC('hev1') && !videoC('vp09') && !videoC('av01')) {
        return 'No compatible video decoder (H.264/HEVC/VP9/AV1) available for this file';
      }
    }
  }

  switch (ext) {
    case 'wma':
      if (mediaEl.canPlayType('audio/x-ms-wma') === '') return 'WMA audio is not supported by this system decoder';
      break;
    case 'ape':
      if (mediaEl.canPlayType('audio/ape') === '') return 'Monkey\'s Audio (APE) is not supported by this system decoder';
      break;
    case 'ra':
      if (mediaEl.canPlayType('audio/vnd.rn-realaudio') === '') return 'RealAudio is not supported by this system decoder';
      break;
    case 'ac3':
      if (!audioC('ac-3') && mediaEl.canPlayType('audio/ac3') === '') return 'AC-3 audio is not supported by this system decoder';
      break;
    case 'eac3':
      if (!audioC('ec-3') && mediaEl.canPlayType('audio/eac3') === '') return 'E-AC-3 audio is not supported by this system decoder';
      break;
    case 'dts':
      if (!audioC('dts-') && !audioC('dtsc') && mediaEl.canPlayType('audio/vnd.dts') === '') return 'DTS audio is not supported by this system decoder';
      break;
    case 'flac':
      if (!audioFl('flac') && mediaEl.canPlayType('audio/flac') === '') return 'FLAC audio is not supported by this system decoder';
      break;
    case 'amr':
      if (!audioC('amr') && mediaEl.canPlayType('audio/amr') === '') return 'AMR audio is not supported by this system decoder';
      break;
    default:
      break;
  }
  return null;
}

/** Human-friendly explanation for a MediaError code, with container-specific hints. */
export function describeMediaError(
  code: number,
  filename: string,
  extra?: string
): string {
  const name = baseName(filename);
  const ext = fileExtension(filename);
  const streamy = streamLikeExtensions.has(ext);
  switch (code) {
    case 1:
      return `Playback of "${name}" was interrupted`;
    case 2:
      return `Temporary problem loading "${name}"${streamy ? ' (stream may need a moment to buffer)' : ''}${extra ? ` — ${extra}` : ''}`;
    case 3:
      return `"${name}" is corrupted, or its codec is not supported by this system decoder`;
    case 4:
      return `"${name}" uses a format or codec this player engine cannot decode`;
    default:
      return `Cannot play "${name}"${extra ? ` — ${extra}` : ''}`;
  }
}

export function formatTime(seconds?: number): string {
  // TS/M2TS/VOB streams can report NaN/Infinity while probing; never render garbage.
  if (seconds === undefined || !isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function formatSize(bytes?: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`;
}

export function uniqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
