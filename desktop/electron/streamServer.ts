import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Movira playback fallback tier (spec: strongest technically feasible solution
 * for formats the Chromium media engine cannot decode natively).
 *
 * Chromium <video> cannot demux MPEG-TS/AVI/VOB containers AT ALL — piping raw
 * TS bytes into the element can never play. Instead this server feeds ffmpeg's
 * output as FRAGMENTED MP4 over a localhost HTTP connection; the renderer
 * fetch()es it and appends into a MediaSource SourceBuffer, which Chromium
 * plays natively:
 *
 *   Tier 1 (native)   — file:// direct streaming, GPU/hardware decode (default).
 *   Tier 2 (fallback) — ffmpeg remux/transcode → fragmented-MP4 over 127.0.0.1 → MSE.
 *                       'remux'              : video+audio streams COPIED untouched
 *                                              (H.264/HEVC/MPEG-4/VP9/AV1 + aac/mp3/opus/flac).
 *                       'remux-tc-audio'     : video copied, audio re-encoded to AAC
 *                                              (AC-3/DTS/WMA/MP2 audio sources).
 *                       'transcode-video'    : video re-encoded (libx264 veryfast) —
 *                                              WMV/VC-1/MPEG-2/RealVideo sources.
 *                       'transcode-audio-only': audio-only files → AAC.
 *
 * Exactly one session is active at a time; a new stream request (new file or a
 * seek) supersedes the previous one immediately. A session is also torn down
 * when its client really disconnects (fetch abort) or ffmpeg exits — never on
 * speculative connection churn, because the MSE client uses ONE long-lived
 * fetch connection.
 *
 * Timestamps are preserved (-copyts) so the element timeline always matches the
 * source file: after a seek-restart the element resumes at the correct media
 * time without any offset bookkeeping.
 *
 * The server binds to 127.0.0.1 on an ephemeral port — nothing is exposed to
 * the network.
 */

/** One audio/subtitle stream discovered by the probe. */
export interface ProbeStreamInfo {
  /** Type-relative ordinal (`0:a:N` / `0:s:N`) — what `-map` selectors take. */
  index: number;
  codec: string;
  language: string | null;
  isDefault: boolean;
  /** Audio only: how many channels the track has (null for subtitles/unknown). */
  channels?: number | null;
}

export interface MediaProbe {
  durationSec: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  /** Every audio stream in the file (B key cycles these). `index` is the
   *  type-relative ordinal (`0:a:N`), not the absolute stream number. */
  audioStreams: ProbeStreamInfo[];
  /** Every subtitle/text stream in the file (V key cycles these). */
  subtitleStreams: ProbeStreamInfo[];
}

export type StreamMode = 'remux' | 'remux-tc-audio' | 'transcode-video' | 'transcode-audio-only';

const MODES: StreamMode[] = ['remux', 'remux-tc-audio', 'transcode-video', 'transcode-audio-only'];

interface Session {
  id: string;
  src: string;
  mode: StreamMode;
  seek: number;
  child: ChildProcessWithoutNullStreams;
  res: http.ServerResponse;
}

const sessions = new Map<string, Session>();
const idGeneration = new Map<string, number>();
let generation = 0;
let server: http.Server | null = null;
let serverPort = 0;
let ffmpegPath: string | null = null;

function resolveFfmpeg(): string | null {
  if (ffmpegPath) return ffmpegPath;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require('ffmpeg-static') as string | null;
    if (ffmpegStatic) {
      candidates.push(ffmpegStatic);
      // electron-builder asarUnpack keeps the real binary next to app.asar.
      candidates.push(String(ffmpegStatic).replace('app.asar', 'app.asar.unpacked'));
    }
  } catch {
    /* ffmpeg-static not installed */
  }
  // Direct resources fallback (works even if require() resolution changes in
  // packaged builds): <resources>/app.asar.unpacked/node_modules/ffmpeg-static[/ffmpeg.exe]
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', exe));
    candidates.push(path.join(process.resourcesPath, 'ffmpeg-static', exe));
    candidates.push(path.join(process.resourcesPath, 'ffmpeg', exe));
  }
  for (const c of candidates) {
    try {
      // A path INSIDE app.asar is not a real file on disk: Electron's fs shim
      // reports it as existing, but Windows cannot spawn it — probe/stream
      // would fail forever while the REAL unpacked binary sits one candidate
      // later. Skip asar-embedded paths (keep app.asar.unpacked ones).
      if (c && c.includes('app.asar') && !c.includes('app.asar.unpacked')) continue;
      if (c && fs.existsSync(c)) {
        ffmpegPath = c;
        return ffmpegPath;
      }
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function killSession(id: string, reason = 'unknown') {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  console.log(`[movira:stream] kill ${id.slice(-4)} (${path.basename(s.src)}, seek=${s.seek}) — ${reason}`);
  try {
    s.child.stdin.end();
    s.child.kill('SIGKILL');
  } catch {
    /* already dead */
  }
  try {
    if (!s.res.writableEnded) s.res.end();
  } catch {
    /* response already gone */
  }
}

function killAllSessions() {
  // Bumping the generation marks every previously issued session id stale so a
  // LATE "stop my session" IPC (renderer Stop pressed just before Play) can
  // never kill a session that was started afterwards — that cross-kill used to
  // leave the freshly started stream frozen with the timeline stuck.
  generation++;
  for (const id of Array.from(sessions.keys())) killSession(id, 'kill-all');
}

/** Kill exactly one session (the caller's). Stops issued before a kill-all are
 *  dropped: the session is already gone and a newer playback must not die. */
export function stopStream(id: string) {
  if (generation !== idGeneration.get(id)) return;
  killSession(id, 'renderer stopStream');
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Build the ffmpeg argument list for a mode. Output is fragmented MP4 (MSE-
 *  compatible) with source timestamps preserved, so the renderer element's
 *  timeline always matches the file timeline (seek = restart at offset).
 *  audioCodec: source audio codec from the probe — TS/MPEG-PS files carry AAC
 *  in ADTS framing which the MP4 muxer rejects, so copy-modes apply the
 *  aac_adtstoasc bitstream filter (a no-op on non-ADTS AAC). */
export function buildArgs(
  src: string,
  mode: StreamMode,
  seek: number,
  audioCodec?: string,
  audioTrack = 0,
  audioChannels?: number | null
): string[] {
  const pre: string[] = [];
  if (seek > 0) pre.push('-ss', String(Math.max(0, seek - 0.35)));
  const input = ['-hide_banner', '-loglevel', 'error', ...pre, '-i', src];
  // fMP4 flags: empty_moov = streamable init segment up front; frag_keyframe =
  // fragment boundaries on keyframes; default_base_moof = broad compatibility.
  // -copyts preserves the source timeline: after a seek-restart the first
  // fragment carries the true media timestamp, so the element's currentTime
  // resumes at the correct position with no offset bookkeeping (MSE supports
  // arbitrary positive timeline offsets — this is how live DASH works).
  const out = [
    '-copyts',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ];
  // Audio track selection (B key): pick the requested stream instead of always
  // the first one, so a movie with several languages really switches language.
  const aSel = audioTrack > 0 ? `0:a:${audioTrack}` : '0:a:0';
  const map = ['-map', '0:v:0?', '-map', aSel + '?', '-sn', '-dn'];
  // ADTS -> ASC conversion is required when copying AAC out of MPEG-TS into MP4.
  const aacBsf = audioCodec && ['aac', 'aac_latm'].includes(audioCodec) ? ['-bsf:a', 'aac_adtstoasc'] : [];
  // Tell ffmpeg the channel count explicitly whenever we re-encode audio.
  // Without it the AAC encoder inherits an unnamed layout from sources like
  // AC3 "5.1(side)" and emits an AudioSpecificConfig with no channel
  // configuration, which Chromium refuses — the first appendBuffer errors and
  // the file NEVER plays (measured: every DVD-style 5.1 rip). `-ac N` with the
  // track's real channel count changes nothing about the audio; it only makes
  // the init segment conformant. Verified against the packaged build: stereo,
  // 5.1 and 4ch all append with it; unnamed 6ch is rejected without it.
  const ac = typeof audioChannels === 'number' && audioChannels > 0 ? ['-ac', String(audioChannels)] : [];
  switch (mode) {
    case 'remux':
      // Copy both streams untouched — no re-encode, no quality loss, minimal CPU.
      return [...input, ...map, '-c', 'copy', ...aacBsf, ...out];
    case 'remux-tc-audio':
      // Video stream copied untouched; only the audio track is re-encoded to AAC.
      return [
        ...input, ...map,
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k', ...ac,
        ...out,
      ];
    case 'transcode-video':
      // Video needs a real decoder; keep it lightweight and smooth. Keyframes
      // every ~2s give the MSE stream clean fragment boundaries.
      return [
        ...input, ...map,
        // 'superfast' keeps encode headroom on weaker machines (transcode
        // smoothness beats marginal compression gains in a player).
        '-c:v', 'libx264', '-preset', 'superfast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-g', '60',
        '-force_key_frames', 'expr:gte(t,n_forced*2)',
        '-c:a', 'aac', '-b:a', '192k', ...ac,
        ...out,
      ];
    case 'transcode-audio-only':
      return [
        ...input, '-vn', '-map', aSel + '?',
        '-c:a', 'aac', '-b:a', '192k', ...ac,
        ...out,
      ];
  }
}

function startServer(): number {
  if (server) return serverPort;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/stream') {
      res.writeHead(404).end();
      return;
    }
    const id = url.searchParams.get('id') ?? newId();
    const src = url.searchParams.get('src') ?? '';
    const mode = (url.searchParams.get('mode') ?? 'remux') as StreamMode;
    const seek = Number(url.searchParams.get('seek') ?? '0') || 0;
    const ac = url.searchParams.get('ac') ?? undefined;
    const at = Number(url.searchParams.get('at') ?? '0') || 0;
    // Channel count of the selected audio track, so the AAC encoder emits a
    // conformant init segment for unnamed multichannel layouts (see buildArgs).
    const ach = Number(url.searchParams.get('ch') ?? '0') || 0;

    // Path confinement: only existing local media files are ever streamed.
    if (!src || !path.isAbsolute(src) || !fs.existsSync(src)) {
      res.writeHead(403).end();
      return;
    }
    if (!MODES.includes(mode)) {
      res.writeHead(400).end();
      return;
    }

    const ff = resolveFfmpeg();
    if (!ff) {
      res.writeHead(503).end();
      return;
    }

    // Cancel the previous session: one file, one decoder — a new stream request
    // (new file or a seek) supersedes whatever was running.
    killAllSessions();
    console.log(`[movira:stream] request ${id.slice(-4)} ${path.basename(src)} mode=${mode} seek=${seek}`);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(ff, buildArgs(src, mode, seek, ac, at, ach), {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch {
      res.writeHead(500).end();
      return;
    }

    idGeneration.set(id, generation);
    sessions.set(id, { id, src, mode, seek, child, res });

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': 'null',
      'Access-Control-Allow-Headers': '*',
    });

    // pipe() honours backpressure: if the client stops reading (pause), ffmpeg
    // blocks on write and idles cheaply instead of burning CPU.
    child.stdout.pipe(res);

    // The MSE client uses ONE long-lived fetch: a closed connection is a real
    // abort (new load/seek/stop/app quit) — tear the decoder down with it.
    req.on('close', () => killSession(id, 'client connection closed'));

    // Collect stderr for failure diagnostics (bounded).
    let errTail = '';
    child.stderr.on('data', (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-800);
    });

    child.on('error', () => {
      sessions.delete(id);
      try { if (!res.writableEnded) res.destroy(); } catch { /* gone */ }
    });

    // Debug visibility: did the client read ALL output, or did the pipe stall?
    res.on('close', () => {
      const s = sessions.get(id);
      if (s) console.log(`[movira:stream] response closed while session ${id.slice(-4)} still active`);
    });

    // ffmpeg finished (file EOF) or died: end the client response cleanly so
    // MSE endOfStream() fires and 'ended' reaches the app.
    const startedAtMs = Date.now();
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (sessions.get(id)?.child === child) sessions.delete(id);
      try {
        if (!res.writableEnded) {
          if (code === 0) res.end();
          else {
            // Failure after headers already sent: log via response trailer the
            // renderer can see as a truncated stream (it treats <init bytes as failure).
            res.end();
          }
        }
      } catch { /* gone */ }
      const lifetime = Date.now() - startedAtMs;
      console.log(`[movira:stream] session ${id.slice(-4)} ffmpeg closed code=${code} sig=${signal ?? '-'} lifetime=${lifetime}ms${errTail ? ' err: ' + errTail.split('\n').slice(-2).join(' | ') : ''}`);
    });
  });

  server.listen(0, '127.0.0.1', () => {
    const addr = server?.address();
    serverPort = typeof addr === 'object' && addr ? addr.port : 0;
  });
  server.on('close', () => {
    server = null;
    serverPort = 0;
  });
  return serverPort;
}

/** Probe a media file by parsing `ffmpeg -i` output (ffmpeg-static has no ffprobe). */
function probeDebugLog(msg: string) {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'movira-probe-debug.log'), `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
}

export function probeMedia(src: string): Promise<MediaProbe | null> {
  return new Promise((resolve) => {
    const ff = resolveFfmpeg();
    if (!ff || !src || !fs.existsSync(src)) {
      probeDebugLog(`unavailable ff=${ff} srcExists=${src ? fs.existsSync(src) : 'n/a'}`);
      resolve(null);
      return;
    }
    const child = spawn(ff, ['-hide_banner', '-i', src], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      finish();
    }, 15000);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      resolve(parseProbe(stderr));
    };
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => {
      probeDebugLog(`spawn error: ${e.message}`);
      finish();
    });
    child.on('close', () => {
      if (!/Video:|Audio:/.test(stderr)) probeDebugLog(`no stream info in stderr ${stderr.length}B: ${stderr.slice(0, 300).replace(/\n/g, ' | ')}`);
      finish();
    });
  });
}

/**
 * Collect every Audio or Subtitle stream from `ffmpeg -i` output.
 *
 * The B (audio) and V (subtitle) keys must act on the file's REAL tracks, so
 * the renderer needs the list, their languages and which one ffmpeg marked
 * default. `index` is deliberately the TYPE-RELATIVE ordinal (`0:a:0`,
 * `0:s:1`, …) because that is what the `-map` selectors in buildArgs and
 * readEmbeddedSubtitle take — the absolute `Stream #0:2` number is only a
 * label here and would pick the wrong track in a file that mixes stream types.
 */
function parseStreams(out: string, kind: 'Audio' | 'Subtitle'): ProbeStreamInfo[] {
  const re = new RegExp(
    String.raw`Stream #\d+:\d+(?:\[[^\]]*\])?(?:\(([^)]*)\))?:\s*${kind}:\s*([A-Za-z0-9_]+)([^\n]*)`,
    'gi'
  );
  const found: ProbeStreamInfo[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    // The language tag is the first parenthetical; ffmpeg writes "und" for
    // unknown, which is noise in the UI, so it is normalised to null.
    const rawLang = (m[1] ?? '').trim().split(/\s+/)[0] ?? '';
    const lang = !rawLang || rawLang.toLowerCase() === 'und' ? null : rawLang;
    // The disposition marker "(default)" trails the codec description.
    const isDefault = /\(default\)/.test(m[3] ?? '');
    found.push({
      index: found.length,
      codec: m[2].toLowerCase(),
      language: lang,
      isDefault,
      channels: kind === 'Audio' ? parseChannels(m[3] ?? '') : null,
    });
  }
  return found;
}

/**
 * Channel count of an audio stream line.
 *
 * Needed because ffmpeg's AAC encoder, handed a multichannel stream whose
 * LAYOUT it cannot name (AC3 "5.1(side)" is the common case — every DVD and
 * most web rips), writes an AudioSpecificConfig with no channel configuration.
 * Chromium rejects that init segment outright: `appendBuffer` fires the
 * SourceBuffer error on the very first chunk and the file never plays, with no
 * error anywhere except a dead pipeline. Passing `-ac <count>` — a semantic
 * no-op, the track already has that many channels — makes ffmpeg emit a
 * conformant init segment and the file plays in full surround.
 *
 * ffmpeg reports either "N channels" or a layout name after the sample rate
 * ("5.1(side)", "stereo", "7.1"); both are accepted here.
 */
function parseChannels(rest: string): number | null {
  const n = /,\s*(\d{1,2})\s*channels/.exec(rest);
  if (n) return Number(n[1]);
  // The channel description is whatever follows the sample rate: "mono",
  // "stereo", "5.1", "5.1(side)". Anchoring on the "<rate> Hz," prefix is what
  // keeps "44100" from being mistaken for a layout — matching a bare token
  // between commas silently returned null for every mono track.
  const m = /,\s*\d{2,6}\s*Hz,\s*([^,]+)/.exec(rest);
  if (!m) return null;
  const key = m[1].trim().toLowerCase();
  if (key === 'mono') return 1;
  if (key === 'stereo') return 2;
  // "X.Y" means X full-range channels plus Y (normally the LFE), so 5.1 -> 6.
  const xy = /^(\d)\.(\d)(?:\((?:side|back)\))?$/.exec(key);
  if (xy) return Number(xy[1]) + Number(xy[2]);
  return null;
}

function parseProbe(out: string): MediaProbe | null {
  try {
    const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
    const durationSec = durMatch
      ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3])
      : null;
    const fpsMatch = /(\d+(?:\.\d+)?)\s*fps/.exec(out);
    const fps = fpsMatch ? Number(fpsMatch[1]) : null;
    const video = /Video:\s*([a-zA-Z0-9_]+)/.exec(out);
    const audio = /Audio:\s*([a-zA-Z0-9_]+)/.exec(out);
    const dimMatch = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(out);
    if (!video && !audio) return null;
    return {
      durationSec,
      fps,
      videoCodec: video ? video[1].toLowerCase() : null,
      audioCodec: audio ? audio[1].toLowerCase() : null,
      width: dimMatch ? Number(dimMatch[1]) : null,
      height: dimMatch ? Number(dimMatch[2]) : null,
      audioStreams: parseStreams(out, 'Audio'),
      subtitleStreams: parseStreams(out, 'Subtitle'),
    };
  } catch {
    return null;
  }
}

export interface StreamStartResult {
  ok: boolean;
  url?: string;
  /** Stream session id — the renderer passes it to stopStream() for a
   *  session-scoped teardown that can never kill a newer playback. */
  id?: string;
  reason?: string;
}

export async function startStream(opts: {
  src: string;
  mode: StreamMode;
  seek?: number;
  audioCodec?: string;
  audioTrack?: number;
  audioChannels?: number | null;
}): Promise<StreamStartResult> {
  const ff = resolveFfmpeg();
  if (!ff) return { ok: false, reason: 'ffmpeg-unavailable' };
  if (!fs.existsSync(opts.src)) return { ok: false, reason: 'file-missing' };
  startServer();
  // Wait for the listen callback to assign the ephemeral port.
  for (let i = 0; i < 40 && !serverPort; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const port = serverPort;
  if (!port) return { ok: false, reason: 'server-failed' };
  const id = newId();
  const ac = opts.audioCodec ? `&ac=${encodeURIComponent(opts.audioCodec)}` : '';
  const at = opts.audioTrack && opts.audioTrack > 0 ? `&at=${opts.audioTrack}` : '';
  const ach = opts.audioChannels ? `&ch=${opts.audioChannels}` : '';
  const url = `http://127.0.0.1:${serverPort}/stream?id=${id}&src=${encodeURIComponent(opts.src)}&mode=${opts.mode}&seek=${Math.max(0, opts.seek ?? 0)}${ac}${at}${ach}`;
  return { ok: true, url, id };
}

/**
 * Extract one embedded subtitle stream as WebVTT (V key).
 *
 * Subtitles are dropped from the fMP4 stream (-sn) because MSE cannot carry
 * them as playable tracks, so a movie's own subtitle languages used to be
 * unreachable. ffmpeg converts any subtitle codec (subrip/ASS/PGS/VobSub…) to
 * WebVTT on the fly; the output is bounded so a bitmap subtitle cannot flood
 * the renderer.
 */
export async function readEmbeddedSubtitle(src: string, streamIndex: number): Promise<string | null> {
  const ff = resolveFfmpeg();
  if (!ff || !src || !fs.existsSync(src) || streamIndex < 0) return null;
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(ff, [
        '-hide_banner', '-loglevel', 'error',
        '-i', src,
        '-map', `0:s:${streamIndex}`,
        '-f', 'webvtt', 'pipe:1',
      ], { windowsHide: true }) as ChildProcessWithoutNullStreams;
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let bytes = 0;
    child.stdout.on('data', (d: Buffer) => {
      bytes += d.length;
      if (bytes > 8 * 1024 * 1024) { try { child.kill('SIGKILL'); } catch { /* noop */ } return; }
      out += d.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const text = out.trim();
      // ffmpeg always writes a "WEBVTT" header even when the stream is empty;
      // treat a header-only result as "no subtitles here".
      resolve(text && /WEBVTT/.test(text) && text.length > 40 ? out : null);
    });
  });
}

export function stopAllStreams() {
  killAllSessions();
}

export function shutdownStreamServer() {
  killAllSessions();
  if (server) {
    server.close();
    server = null;
    serverPort = 0;
  }
}

/** Decide the best fallback mode from a probe + renderer codec capabilities.
 *  Output container is fragmented MP4, so only MP4-compatible codecs can be
 *  stream-copied, and only codecs the renderer can actually decode are worth
 *  copying; everything else is re-encoded (audio) or fully transcoded. */
export function decideMode(
  probe: MediaProbe,
  canDecodeAudio: (codec: string) => boolean,
  canDecodeVideo: (codec: string) => boolean
): StreamMode {
  // Codecs Chromium decodes AND fragmented MP4 can legally carry.
  const MP4_AUDIO = new Set(['aac', 'mp3', 'opus', 'flac']);
  const REMUXABLE_VIDEO = new Set(['h264', 'hevc', 'hvc1', 'mpeg4', 'vp8', 'vp9', 'av1']);
  if (!probe.videoCodec) {
    // Audio-only file the engine could not decode.
    return 'transcode-audio-only';
  }
  const videoOk = REMUXABLE_VIDEO.has(probe.videoCodec) && canDecodeVideo(probe.videoCodec);
  if (videoOk) {
    const audio = probe.audioCodec ?? null;
    if (!audio) return 'remux'; // video-only source: nothing to transcode
    if (MP4_AUDIO.has(audio) && canDecodeAudio(audio)) return 'remux';
    // Keep the (decodable) video stream untouched; transcode only the audio.
    return 'remux-tc-audio';
  }
  // Either an MP4-incompatible codec (wmv3/vc1/mpeg2video/rv40...) or a codec
  // the renderer cannot decode anyway: full video transcode, lightweight preset.
  return 'transcode-video';
}
