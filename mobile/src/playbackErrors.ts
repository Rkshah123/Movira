/**
 * Turning a playback failure into an accurate, actionable message.
 *
 * The player used to answer every error with "this file uses a format or codec
 * this device cannot decode". That was wrong for most of the failures it was
 * shown for. A file the app is not allowed to read fails long before any decoder
 * is consulted, and a damaged file is not a codec problem either — both were
 * reported as one.
 *
 * ExoPlayer distinguishes these precisely in its error codes, so the codes are
 * used here instead of a catch-all string. Only a failure that really is about
 * decoding produces a codec message, and even then the claim is checked against
 * the device's actual decoder list first.
 */

/** What kind of failure this is. Drives the wording and the offered action. */
export type FailureKind =
  /** The file could not be opened: no permission, or it is gone. */
  | 'access'
  /** The device has no decoder for the stream's format. */
  | 'codecMissing'
  /** A decoder exists but the stream could not be decoded — usually a damaged file. */
  | 'decodeFailed'
  /** Anything else. */
  | 'unknown';

export interface PlaybackFailure {
  kind: FailureKind;
  message: string;
  /** Second line. Present whenever there is something the user can actually do. */
  hint?: string;
  /** Set when the hint is a button rather than plain text. */
  onHint?: () => void;
}

/**
 * Codes that mean the bytes never arrived.
 *
 * `ERROR_CODE_IO_NO_PERMISSION` is the one that matters here: on Android 11+
 * scoped storage refuses a direct read of any file the media store has never
 * indexed, and an unusual extension such as `.t` never gets indexed at all. The
 * player was reporting that as a codec failure.
 */
const ACCESS_CODES = new Set([
  'ERROR_CODE_IO_NO_PERMISSION',
  'ERROR_CODE_IO_FILE_NOT_FOUND',
  'ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE',
  'ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED',
  'ERROR_CODE_IO_UNSPECIFIED',
  'ERROR_CODE_IO_BAD_HTTP_STATUS',
  'ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE',
]);

const ACCESS_TEXT = /permission|eacces|no such file|file not found|denied/i;

/** Codes that mean the container or the stream itself could not be handled. */
const CODEC_CODES = new Set([
  'ERROR_CODE_PARSING_CONTAINER_MALFORMED',
  'ERROR_CODE_PARSING_MANIFEST_MALFORMED',
  'ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED',
  'ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED',
  'ERROR_CODE_DECODER_INIT_FAILED',
  'ERROR_CODE_DECODER_QUERY_FAILED',
  'ERROR_CODE_DECODING_FAILED',
  'ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES',
  'ERROR_CODE_DECODING_FORMAT_UNSUPPORTED',
]);

const CODEC_TEXT = /unsupported|no decoder|codec|demux|container|malformed|parse/i;

/** A MIME type spelled the way a person would say it out loud. */
export function humanCodec(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'video/mpeg2':
    case 'video/mpeg':
      return 'MPEG-2 video';
    case 'video/avc':
      return 'H.264 video';
    case 'video/hevc':
      return 'H.265 (HEVC) video';
    case 'video/mp4v':
      return 'MPEG-4 Part 2 video';
    case 'video/av01':
      return 'AV1 video';
    case 'video/x-vnd.on2.vp9':
      return 'VP9 video';
    case 'video/x-vnd.on2.vp8':
      return 'VP8 video';
    case 'video/mvc':
      return 'H.263 video';
    default:
      return mime;
  }
}

/**
 * An audio MIME type spelled the way a person would say it out loud.
 *
 * The audio half of `humanCodec`, added for the silent-video case: an MKV whose * only audio is AC-3 / E-AC-3 / DTS plays normally on a phone with no decoder * for that codec, and the message has to name the codec without dumping raw * MIME text on the user.
 */
export function humanAudioCodec(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'audio/ac3':
      return 'AC-3 (Dolby Digital) audio';
    case 'audio/eac3':
      return 'E-AC-3 (Dolby Digital Plus) audio';
    case 'audio/eac3-joc':
      return 'Dolby Digital Plus audio';
    case 'audio/vnd.dts':
      return 'DTS audio';
    case 'audio/vnd.dts.hd':
      return 'DTS-HD audio';
    // `audio/mpeg` is MPEG audio (MP3), NOT AAC — grouping it with AAC named
    // the wrong format on any device that lacks an MP3 decoder.
    case 'audio/mpeg':
      return 'MP3 audio';
    case 'audio/mp4a-latm':
    case 'audio/aac':
      return 'AAC audio';
    default:
      return mime;
  }
}

/**
 * The MIME type of a video track, from what the demuxer reported.
 *
 * ExoPlayer hands over either a MIME (`video/mpeg2`) or a codec string
 * (`avc1.640028`, `hev1.1.6.L93.B0`). The container's MIME is useless here —
 * asking whether the device can decode `video/mp2t` only ever answers about the
 * container, never the video codec inside it, which is the thing actually
 * missing.
 *
 * Returns null for anything unrecognised. That matters: the caller uses a null to
 * stay quiet, and a guessed MIME would produce confident, wrong "this device
 * cannot play this" claims on files that are playing perfectly well.
 */
export function codecToMime(codecs?: string | null): string | null {
  if (!codecs) return null;
  const raw = codecs.trim();
  if (!raw) return null;
  if (raw.toLowerCase().startsWith('video/')) return raw.toLowerCase();
  // Only the leading identifier matters; the rest is a profile and level.
  const head = raw.split(/[.\s,]/)[0].toLowerCase();
  switch (head) {
    case 'avc':
    case 'avc1':
    case 'h264':
    case 'x264':
      return 'video/avc';
    case 'hevc':
    case 'hev1':
    case 'hvc1':
      return 'video/hevc';
    case 'vp8':
      return 'video/x-vnd.on2.vp8';
    case 'vp9':
      return 'video/x-vnd.on2.vp9';
    case 'av01':
      return 'video/av01';
    case 'mp4v':
      return 'video/mp4v';
    case 'mpeg2':
    case 'mpeg-2':
    case 'm2v':
      return 'video/mpeg2';
    case 'mpeg4':
    case 'mp4a':
      return 'video/mp4v';
    case 'mvc':
      return 'video/mvc';
    default:
      return null;
  }
}

/**
 * Best-effort MIME type from a filename, so a decoder check has something to
 * ask about. Only the containers Movira lists are mapped; anything else returns
 * an empty string, which makes the decoder check report "unknown" rather than
 * guessing.
 */
export function mimeFromFilename(filename: string): string {
  const ext = (filename.toLowerCase().split('.').pop() ?? '').replace(/[^a-z0-9]/g, '');
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    ts: 'video/mp2t',
    t: 'video/mp2t',
    m2t: 'video/mp2t',
    m2ts: 'video/mp2t',
    mts: 'video/mp2t',
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
    mp2: 'video/mpeg',
    m1v: 'video/mpeg',
    m2v: 'video/mpeg',
    mpe: 'video/mpeg',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    wmv: 'video/x-ms-wmv',
    '3gp': 'video/3gpp',
    '3g2': 'video/3gpp',
    ogv: 'video/x-ogg',
    flv: 'video/x-flv',
    rm: 'video/vnd.rn-realvideo',
    rmvb: 'video/vnd.rn-realvideo',
    divx: 'video/divx',
    xvid: 'video/xvid',
    asf: 'video/x-ms-asf',
    vob: 'video/mpeg',
    mxf: 'application/mxf',
  };
  return map[ext] ?? '';
}

interface RawError {
  code?: string;
  errorCode?: string | number;
  message?: string;
  errorString?: string;
  localizedDescription?: string;
  errorType?: string;
}

/**
 * Reads whatever identifying field this version of react-native-video put on the
 * error. The shape has changed between releases, so several spellings are tried
 * and the object is probed structurally rather than cast blindly.
 */
function readCode(e: unknown): string {
  if (!e || typeof e !== 'object') return '';
  const o = e as Record<string, unknown>;
  const inner =
    (o.error && typeof o.error === 'object' ? (o.error as Record<string, unknown>) : undefined) ?? o;
  const code = inner.errorCode ?? inner.code;
  if (typeof code === 'string') return code;
  if (typeof code === 'number') return String(code);
  return '';
}

function readText(e: unknown): string {
  if (!e || typeof e !== 'object') return '';
  const o = e as Record<string, unknown>;
  const inner =
    (o.error && typeof o.error === 'object' ? (o.error as Record<string, unknown>) : undefined) ?? o;
  const parts = [inner.localizedDescription, inner.errorString, inner.message, inner.errorType, inner.playbackError];
  return parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' · ');
}

export function classifyFailure(e: unknown): FailureKind {
  const code = readCode(e).toUpperCase();
  const text = readText(e);
  if (ACCESS_CODES.has(code) || ACCESS_TEXT.test(text)) return 'access';
  if (CODEC_CODES.has(code) || CODEC_TEXT.test(text)) return 'codecMissing';
  return 'unknown';
}

/**
 * Builds the message the player shows.
 *
 * `hasDecoder` is the result of asking the platform's codec list, so the
 * "this device cannot decode" claim is only made once that has been confirmed.
 * When a decoder does exist, saying so is what stops a damaged or unusual file
 * being blamed on the hardware.
 */
export async function describeFailure(
  e: unknown,
  filename: string,
  opts: { hasAllFilesAccess: boolean; canDecode: (mime: string) => Promise<boolean>; grantAllFilesAccess: () => void }
): Promise<PlaybackFailure> {
  const kind = classifyFailure(e);
  const detail = readText(e);

  if (kind === 'access') {
    if (!opts.hasAllFilesAccess) {
      return {
        kind,
        message:
          'Movira is not allowed to read this file. Android hides files it does not recognise — including MPEG transport streams saved with a .t extension — unless the app has access to all files.',
        hint: 'Tap to grant access to all files',
        onHint: opts.grantAllFilesAccess,
      };
    }
    return {
      kind,
      message:
        detail ||
        'Movira could not open this file. It may have been moved, renamed or deleted since it was added.',
      hint: 'Pick another file — the player is still fine.',
    };
  }

  const mime = mimeFromFilename(filename);
  const decodable = mime ? await opts.canDecode(mime) : false;

  if (mime && !decodable) {
    return {
      kind: 'codecMissing',
      message: `This phone has no decoder for ${mime}, which is what this file needs.`,
      hint: 'Pick another file — the player is still fine.',
    };
  }

  return {
    kind: 'decodeFailed',
    message:
      (detail ? `${detail}. ` : '') +
      'The file could not be decoded. It is most likely damaged or incompletely downloaded.',
    hint: 'Pick another file — the player is still fine.',
  };
}