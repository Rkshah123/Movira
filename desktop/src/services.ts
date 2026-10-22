import {
  MediaPlayerService,
  PlaylistService,
  MediaLibraryService,
  SubtitleService,
  UserDataService,
  type PlayerEngine,
  type EngineEvents,
  type QueueState,
  type MediaItem,
  type StorageAdapter,
  type SubtitleTrack,
  describeMediaError,
  detectUnsupportedCodec,
  storageKeys,
} from '@shared';
import { moviraApi, createStorageAdapter, type ProbeStream } from './api';

export interface DesktopEngine extends PlayerEngine {
  attach(el: HTMLVideoElement): void;
  setHost(host: HTMLDivElement | null): void;
  el(): HTMLVideoElement | null;
  toggleMute(): boolean;
  setMuted(m: boolean): boolean;
  setPip(on: boolean): Promise<boolean>;
  stop(): Promise<void>;
  /** Live drag position from the timeline. Native tier: cheap in-buffer seek
   *  for real-time feedback. Fallback tier: preview-only — a drag NEVER restarts
   *  the decoder mid-gesture (the final exact position is committed via seek()
   *  on release); in-buffer targets still apply instantly. */
  scrubThrough(t: number): void;
  /** Playback position in FILE time. On the fallback tier the MSE element's
   *  internal clock restarts at 0 for every seek-restart (the muxer normalizes
   *  timestamps), so element time + stream epoch = file time. UI, resume saves
   *  and keyboard seeks MUST use this, never raw el.currentTime. */
  currentFileTime(): number;
  /** True when the current buffer already covers this FILE time, i.e. seeking
   *  there is a plain currentTime write with no decoder restart. Exposed for
   *  diagnostics and for the end-to-end suites. */
  isBufferedAt(fileT: number): boolean;
  /** True while the tier-2 (ffmpeg→MSE) pipeline is active for the current
   *  item — including the transient window when a seek-restart has detached
   *  the element but the replacement pipeline has not attached yet. */
  isFallbackBusy(): boolean;
  /** What the user last asked for (play vs pause). Authoritative for the
   *  transport buttons: `el.paused` lies during a seek-restart. */
  isPlayingIntent(): boolean;
  /** Best known media duration in seconds; NEVER Infinity (see implementation). */
  knownDuration(): number;
  /** True while a seek-restart is rebuilding the pipeline under the element. */
  isRestarting(): boolean;
  /** Adopt the element's play/pause state as the user's intent (DOM listeners). */
  syncPlayingIntent(v: boolean): void;
  /** The media's REAL audio/subtitle streams, for the B and V keys. Served
   *  from the probe cached with the fallback plan, so it costs nothing after
   *  the file has been opened once. */
  getTracks(): Promise<{ audio: ProbeStream[]; subs: ProbeStream[] }>;
  /** VLC's B: cycle the audio track. Resolves to the new track's label, or an
   *  empty string when the file has fewer than two audio tracks. */
  cycleAudioTrack(): Promise<string>;
  /** Index of the audio track currently selected (0 when unknown). */
  audioTrackIndex(): number;
  /** Extract one embedded subtitle stream as a WebVTT track (V key). MSE drops
   *  subtitles from the fMP4 stream, so they are pulled from the file on demand. */
  getEmbeddedSubtitle(index: number): Promise<SubtitleTrack | null>;
}

/** The ffmpeg fallback pipeline shapes. */
type FallbackMode = 'remux' | 'remux-tc-audio' | 'transcode-video' | 'transcode-audio-only';

/** What a caller hands the engine to describe the fallback stream it wants. */
type FallbackCtxInit = Omit<FallbackCtx, 'audioTrack'> & { audioTrack?: number };

/** Context of the ACTIVE fallback stream (tier 2). */
type FallbackCtx = {
  filePath: string;
  mode: FallbackMode;
  mime: string;
  duration: number | null;
  audioCodec?: string;
  /** Type-relative audio stream muxed into the fMP4 (B key). */
  audioTrack: number;
  /** Channel count of that stream, so ffmpeg is told it explicitly. */
  audioChannels?: number | null;
};

/** Channel count of the audio track a plan would mux, or null if unknown. */
function channelsForTrack(plan: FallbackPlan, track: number): number | null {
  return plan.audioStreams[track]?.channels ?? null;
}

/** Chromium's AudioTrackList is not in the TS DOM lib; this is its shape. */
interface AudioTrackLike {
  enabled: boolean;
  label: string;
  language: string;
}
interface AudioTracksLike {
  length: number;
  [index: number]: AudioTrackLike;
}

/** Map an ffmpeg codec name to the MP4 sample entry Chromium reports. */
function mp4VideoCodecEntry(codec: string): string | null {
  switch (codec) {
    case 'h264': return 'avc1.640029';
    case 'hevc': case 'hvc1': return 'hvc1.1.6.L93.B0';
    case 'vp8': return 'vp8';
    case 'vp9': return 'vp09.00.10.08';
    case 'av1': return 'av01.0.04M.08';
    default: return null;
  }
}

function mp4AudioCodecEntry(codec: string): string | null {
  switch (codec) {
    case 'aac': case 'aac_latm': return 'mp4a.40.2';
    case 'mp3': return 'mp3';
    case 'opus': return 'opus';
    case 'flac': return 'flac';
    default: return null;
  }
}

/**
 * MediaSource client for the ffmpeg fallback tier.
 *
 * Chromium cannot demux MPEG-TS/AVI/VOB at all, so the fallback server outputs
 * fragmented MP4 with source timestamps preserved; this class fetches that
 * stream (ONE long-lived connection) and appends it into a SourceBuffer.
 * After the first append the element seeks to the intended position (the
 * -copyts timeline keeps media time identical to the file time), which makes
 * seek = restart-ffmpeg-at-offset seamless.
 */
class MsePlayer {
  private mediaSource: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private controller: AbortController | null = null;
  private objectUrl: string | null = null;
  private destroyed = false;
  private gotInit = false;
  private startedAt = 0;
  // True once the USER (or teardown) paused the element — stops the autoplay
  // 'canplay' retry from resuming playback the user explicitly stopped.
  private userPaused = false;
  /** Listener records for full removal in destroy(). Per-instance listeners
   *  (autoplay 'canplay' etc.) used to leak onto the shared element on every
   *  load/seek/stop cycle and re-trigger play() later. */
  private elListeners: Array<[EventTarget, string, EventListener]> = [];
  private pollTimer: number | null = null;
  // Append-pipeline diagnostics (E2E probes window.__moviraMseDebug).
  appendCount = 0;
  byteCount = 0;
  appendErrors: string[] = [];
  /** Number of coded-frame removals (memory kept bounded behind the playhead). */
  trimmedCount = 0;
  /** Seconds of media currently buffered ahead of the playhead. */
  bufferedAheadSec(): number {
    try {
      // Reading `buffered` on a SourceBuffer that has been removed from its
      // MediaSource throws InvalidStateError — which happens for the whole
      // window between a pipeline teardown and the next one attaching.
      const b = this.sb?.buffered;
      if (!b || !b.length) return 0;
      let ahead = 0;
      for (let i = 0; i < b.length; i++) {
        if (this.el.currentTime >= b.start(i) - 0.5 && this.el.currentTime <= b.end(i) + 0.5) {
          ahead = Math.max(ahead, b.end(i) - this.el.currentTime);
        }
      }
      return +ahead.toFixed(1);
    } catch {
      return 0;
    }
  }
  fetchDone = false;
  fetchFailed: string | null = null;

  debugMsState(): string | null {
    try { return this.mediaSource ? this.mediaSource.readyState : null; } catch { return 'err'; }
  }

  debugSbUpdating(): boolean | null {
    try { return this.sb ? this.sb.updating : null; } catch { return null; }
  }

  // Debug: what the element saw when the init segment landed.
  debugBufStart: number | null = null;
  debugSeekApplied: number | null = null;
  debugTargetTime: number | null = null;

  debugBufferedRanges(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    try {
      const b = this.sb?.buffered;
      if (b) for (let i = 0; i < b.length; i++) out.push([+b.start(i).toFixed(2), +b.end(i).toFixed(2)]);
    } catch { /* SourceBuffer already removed */ }
    return out;
  }

  private on(target: EventTarget, type: string, fn: EventListener) {
    target.addEventListener(type, fn);
    this.elListeners.push([target, type, fn]);
  }

  private offAll() {
    for (const [target, type, fn] of this.elListeners.splice(0)) {
      try { target.removeEventListener(type, fn); } catch { /* gone */ }
    }
  }

  private clearPoll() {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  constructor(
    private el: HTMLVideoElement,
    private url: string,
    private opts: { mime: string; autoplay: boolean; targetTime: number | null; durationHint: number | null; epoch: number }
  ) {}

  /** Streams the fallback output into the element. Resolves true when the
   *  element is delivering media (readyState >= 3), false on error/timeout. */
  async start(timeoutMs = 30000): Promise<boolean> {
    (window as unknown as { __moviraMseDebug?: MsePlayer }).__moviraMseDebug = this;
    const msCtor = window.MediaSource;
    if (!msCtor || !msCtor.isTypeSupported(this.opts.mime)) return false;
    const ms = new msCtor();
    this.mediaSource = ms;
    this.objectUrl = URL.createObjectURL(ms);
    this.el.src = this.objectUrl;
    this.el.preload = 'auto';

    const open = new Promise<boolean>((resolve) => {
      const ok = () => { clearTimeout(t); resolve(true); };
      const t = setTimeout(() => resolve(false), 5000);
      ms.addEventListener('sourceopen', ok, { once: true });
    });
    if (!(await open) || this.destroyed) return false;
    if (this.destroyed) return false;

    // Declare the real duration up front when the probe knew it. Without an
    // explicit MediaSource.duration, Chromium reports the END OF THE BUFFER
    // as the media duration — so a partially buffered stream made the seek
    // timeline shrink to however far ffmpeg had got.
    if (this.opts.durationHint !== null && isFinite(this.opts.durationHint) && this.opts.durationHint > 0) {
      try { ms.duration = this.opts.durationHint; } catch { /* set again after the init segment */ }
    }

    let sb: SourceBuffer;
    try {
      sb = ms.addSourceBuffer(this.opts.mime);
    } catch {
      return false;
    }
    this.sb = sb;
    // 'segments' mode HONORS the stream's own (-copyts) timestamps: after a
    // seek-restart the buffered range starts at the true media time, so the
    // target seek position is inside the buffer immediately and playback
    // resumes instantly. 'sequence' REBASES timestamps from 0 — a mid-file
    // restart then starves the element until appends crawl up to the target
    // (the intermittent freeze right after seeking on the fallback tier).
    sb.mode = 'segments';

    // Kick playback as soon as frames are renderable (autoplay policy may
    // reject initially; retried on every poll until success or user plays).
    // User intent is tracked: 'canplay' re-fires whenever the buffer recovers,
    // and the old unconditional retry AUTO-UNPAUSED a video the user had
    // paused (and fought a pause pressed mid seek-restart).
    if (this.opts.autoplay) {
      this.userPaused = false;
      this.on(this.el, 'pause', () => { this.userPaused = true; });
      const tryPlay = () => {
        if (this.destroyed || !this.opts.autoplay || this.userPaused || this.el.readyState < 2) return;
        void this.el.play().catch(() => undefined);
      };
      this.on(this.el, 'canplay', tryPlay); // tracked — removed in destroy()
    }

    // Fetch + append loop. Network chunks are COALESCED before they reach the
    // SourceBuffer: appending every small chunk made the SourceBuffer state
    // machine interrupt the main thread hundreds of times per second during
    // playback (visible as micro-stutter on the fallback tier).
    //
    // The bound is a TRADEOFF, not a tuning constant: appendBuffer is
    // synchronous main-thread work, so a bigger chunk means a longer single
    // stall but fewer interruptions. 768KB keeps the worst individual block
    // short (a 1.5MB burst after a seek-restart was measured blocking the
    // renderer for ~800ms) while still cutting the interrupt rate enough that
    // playback is smooth. Awaiting each append also serialises the buffer and
    // applies natural backpressure — a paused video stops the fetch and the
    // server-side ffmpeg blocks on its pipe write.
    const FLUSH_BYTES = 768_000;
    /**
     * BUFFERING POLICY — read AHEAD without limit, trim BEHIND rarely.
     *
     * The previous revision capped how far AHEAD of the playhead we were
     * allowed to buffer (MAX_AHEAD = 40s) to keep memory bounded. That
     * directly caused the seeking regression: with only 40s buffered, almost
     * every timeline jump fell outside the buffer and had to tear the whole
     * pipeline down and respawn ffmpeg (destroy MediaSource → el.load() → new
     * blob URL → wait for the init segment). That is 0.5–5s per seek. When
     * nothing capped the forward window the same seek was a single
     * `el.currentTime` assignment, i.e. free.
     *
     * So: buffer ahead as fast as the source allows — that is exactly what
     * makes seeking instant — and bound memory from the other side instead,
     * by releasing data the playhead has left far behind (trimBehind).
     */
    const KEEP_BEHIND = 60;
    /**
     * FORWARD BUFFER WINDOW.
     *
     * Both extremes were wrong, and the regression tests only ever saw the
     * small-file end of it:
     *
     *  - Cap of 40s: any timeline jump outside 40s missed the buffer and had to
     *    tear the pipeline down and respawn ffmpeg (0.5–5s per seek).
     *  - No cap at all (the previous revision): the loop drains the source as
     *    fast as it can, appending continuously. On a 240s test clip that is a
     *    few MB and looks perfect; on a real 2-hour movie it is a continuous
     *    flood of synchronous appendBuffer() work on the renderer main thread.
     *    Input handling — the wheel, a seek click, the skip buttons — queues
     *    behind it, which is the "it works in the tests but the real player
     *    is unresponsive" failure.
     *
     * Three minutes of runway keeps every nearby seek a one-line currentTime
     * write, while capping the append work in flight so the UI always gets a
     * turn. A seek further out than this still needs one decoder restart,
     * which is inherent to a non-seekable source and is no longer stacked.
     */
    const MAX_AHEAD = 180;
    /** Resume reading once the window has drained back below this. */
    const RESUME_AT = 120;
    /** Only trim once the playhead has moved this far past the last trim. */
    const TRIM_STEP = 30;
    /** And never more often than this (SourceBuffer.remove is not free). */
    const TRIM_INTERVAL_MS = 4000;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let trimmedRanges = 0;
    let lastTrimAt = 0;
    let lastTrimPos = -Infinity;
    /** appendBuffer and remove() must never overlap on one SourceBuffer. */
    let opChain: Promise<unknown> = Promise.resolve();
    const serialized = <T,>(fn: () => Promise<T>): Promise<T> => {
      const next = opChain.then(fn, fn);
      opChain = next.then(() => undefined, () => undefined);
      return next;
    };
    const concatPending = (): Uint8Array => {
      if (pending.length === 1) return pending[0];
      const out = new Uint8Array(pendingBytes);
      let off = 0;
      for (const c of pending) { out.set(c, off); off += c.length; }
      return out;
    };
    /**
     * Release buffered data the playhead has left behind.
     *
     * Deliberately conservative. SourceBuffer.remove() is main-thread work and
     * touching the range the decoder is actively reading makes Chromium
     * re-initialise the pipeline. The previous version ran after EVERY 1.5MB
     * append AND again every 120ms inside the demand gate, so the buffer was
     * being churned continuously. Now it runs only when the playhead has
     * genuinely moved on (TRIM_STEP), at most once per TRIM_INTERVAL_MS, and it
     * always keeps a KEEP_BEHIND tail so a backwards seek stays instant.
     */
    const trimBehind = async (): Promise<boolean> => {
      let b: TimeRanges;
      try {
        b = sb.buffered;
      } catch {
        return false; // SourceBuffer already removed by a teardown
      }
      if (!b.length || sb.updating) return false;
      const pos = this.el.currentTime;
      if (pos - lastTrimPos < TRIM_STEP) return false;
      const now = performance.now();
      if (now - lastTrimAt < TRIM_INTERVAL_MS) return false;
      // Oldest range only, and never inside TRIM_STEP of its end — the decoder
      // may still be reading right up to the buffered edge.
      const cutEnd = Math.min(pos - KEEP_BEHIND, b.end(0) - TRIM_STEP);
      if (cutEnd <= b.start(0) + 1) return false;
      lastTrimAt = now;
      lastTrimPos = pos;
      try {
        sb.remove(b.start(0), cutEnd);
        trimmedRanges++;
        await new Promise<void>((res) => {
          let done2 = false;
          const done = () => {
            if (done2) return;
            done2 = true;
            clearTimeout(timer);
            sb.removeEventListener('updateend', done);
            sb.removeEventListener('error', done);
            res();
          };
          // The timer is ALWAYS cleared — the old version left a live 2s
          // timeout behind on every trim (one per flush).
          const timer = setTimeout(done, 2000);
          sb.addEventListener('updateend', done);
          sb.addEventListener('error', done);
        });
        return true;
      } catch {
        return false;
      }
    };
    const readOk = (async () => {
      try {
        this.controller = new AbortController();
        const res = await fetch(this.url, { signal: this.controller.signal });
        if (!res.ok || !res.body) {
          this.fetchFailed = `http ${res.status}`;
          return false;
        }
        const reader = res.body.getReader();
        const flush = async (): Promise<boolean> => {
          if (pendingBytes === 0) return true;
          const buf = concatPending();
          pending = [];
          pendingBytes = 0;
          try {
            await serialized(() => this.append(buf));
          } catch (e) {
            // Append failed (decode/quota): stop reading and RELEASE the
            // connection so the server tears the ffmpeg session down and the
            // supervisor can restart cleanly — a silently dead append loop
            // used to starve the element mid-file while ffmpeg idled forever.
            this.appendErrors.push(e instanceof Error ? e.message : String(e));
            try { this.controller?.abort(); } catch { /* gone */ }
            return false;
          }
          this.appendCount++;
          this.byteCount += buf.length;
          const initBuffered = this.gotInit ? null : sb.buffered;
          if (!this.gotInit && initBuffered && initBuffered.length > 0) {
            this.gotInit = true;
            this.debugBufStart = +initBuffered.start(0).toFixed(3);
            this.debugTargetTime = this.opts.targetTime;
            // Declare real duration when the probe provided one (fMP4 moov is
            // empty; the element would otherwise report Infinity).
            if (this.opts.durationHint && isFinite(this.opts.durationHint)) {
              try { ms.duration = this.opts.durationHint; } catch { /* ignore */ }
            }
            // Normalise position onto the buffered timeline. The fMP4 muxer
            // NORMALIZES timestamps: a stream started at file time `epoch`
            // plays from element time 0, so element time + epoch = file time
            // (the engine tracks this mapping). A seek-restart lands at
            // `target - epoch` — inside the buffer — instead of jumping ahead
            // of it and starving until appends crawl up (the old freeze).
            const t = this.opts.targetTime;
            const start = initBuffered.start(0) + this.opts.epoch;
            if (t !== null && isFinite(t) && t >= start - 0.5) {
              try { this.el.currentTime = t - this.opts.epoch; this.debugSeekApplied = t - this.opts.epoch; } catch { /* ignore */ }
            } else if (this.el.currentTime < start - 0.05) {
              try { this.el.currentTime = start + 0.05; } catch { /* ignore */ }
            }
          }
          return true;
        };
        let firstPendingAt = 0;
        for (;;) {
          if (this.destroyed) return true;
          // Forward demand gate. Buffering ahead is what makes a seek a cheap
          // currentTime write instead of a full pipeline restart, so the window
          // is generous (MAX_AHEAD) — but it is a WINDOW, not unbounded: on a
          // long movie an unbounded drain starves the main thread and the whole
          // UI (wheel, seek clicks, skip buttons) stops responding. Pausing the
          // read also stops the fetch, which lets the server-side ffmpeg block
          // on its pipe write instead of queueing work we cannot use yet.
          for (let guard = 0; guard < 4000 && this.bufferedAheadSec() > MAX_AHEAD; guard++) {
            await sleep(120);
            if (this.destroyed) return true;
            if (this.bufferedAheadSec() <= RESUME_AT) break;
            // Release what the playhead has left behind while we are parked
            // here, instead of churning the SourceBuffer on every pass.
            if (await serialized(trimBehind)) this.trimmedCount = trimmedRanges;
          }
          const { done, value } = await reader.read();
          if (this.destroyed) return true;
          if (done) {
            if (!(await flush())) return false;
            this.fetchDone = true;
            try { if (ms.readyState === 'open') ms.endOfStream(); } catch { /* gone */ }
            return true;
          }
          if (pendingBytes === 0) firstPendingAt = performance.now();
          pending.push(value);
          pendingBytes += value.length;
          // Flush on size OR age: the size bound cuts the append interrupt rate
          // ~50×, the age bound (120ms) guarantees the init segment and every
          // buffer step still land immediately — startup latency is unchanged
          // no matter how slow the source bitrate is.
          if (pendingBytes >= FLUSH_BYTES || (pendingBytes > 0 && performance.now() - firstPendingAt >= 120)) {
            if (!(await flush())) return false;
            if (await serialized(trimBehind)) this.trimmedCount = trimmedRanges;
          }
        }
      } catch (e) {
        // AbortError from destroy() — expected; anything else means a broken
        // stream. Either way success is judged by the readiness poll.
        if (!this.destroyed && !(e instanceof DOMException && e.name === 'AbortError')) {
          this.fetchFailed = e instanceof Error ? e.message : String(e);
        }
        return !this.destroyed && this.el.readyState >= 3;
      }
    })();

    // Readiness: HAVE_FUTURE_DATA means real frames are flowing. Resolved from
    // ELEMENT EVENTS, not a 200ms poll — that poll was pure added latency on
    // every stream start, and a stream start is what happens on every seek
    // that lands outside the buffer. A coarse safety poll still covers the
    // error/timeout cases the events do not report.
    const started = Date.now();
    this.startedAt = started;
    let settled = false;
    let resolveReadyFlag: (ok: boolean) => void = () => {};
    const resolveReady = (ok: boolean) => {
      if (settled) return;
      settled = true;
      this.clearPoll();
      resolveReadyFlag(ok);
    };
    // Tracked through this.on() so destroy() removes it — an untracked
    // listener on the shared element re-fired into every later pipeline.
    this.on(this.el, 'canplay', () => resolveReady(true));
    this.pollTimer = window.setInterval(() => {
      if (this.destroyed) { resolveReady(false); return; }
      if (this.el.error) { resolveReady(false); return; }
      if (this.el.readyState >= 3) { resolveReady(true); return; }
      if (Date.now() - started > timeoutMs) { resolveReady(false); return; }
    }, 250);
    const readyPromise = new Promise<boolean>((resolve) => {
      resolveReadyFlag = resolve;
      void readOk.then((ok) => {
        // Stream finished (short file EOF): success if we ever had frames or
        // reach them shortly; otherwise the readiness poll decides.
        if (this.destroyed) return resolveReady(false);
        if (this.el.error) return resolveReady(false);
        if (this.el.readyState >= 3 || (ok && this.gotInit)) return resolveReady(true);
        // fall through to poll deadline
      });
    });

    const result = await readyPromise;
    this.clearPoll();
    return result;
  }

  private append(data: Uint8Array): Promise<void> {
    const sb = this.sb;
    if (!sb || this.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onEnd = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error('sourcebuffer append failed')); };
      const cleanup = () => {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error', onErr);
      };
      sb.addEventListener('updateend', onEnd);
      sb.addEventListener('error', onErr);
      try {
        sb.appendBuffer(data as unknown as BufferSource);
      } catch (e) {
        cleanup();
        reject(e instanceof Error ? e : new Error('appendBuffer threw'));
      }
    });
  }

  /** Track explicit user transport intent. A seek-restart destroys and rebuilds
   *  the pipeline (and with it this flag), so the engine pushes the current
   *  intent onto the new instance: without this a Pause pressed while the
   *  pipeline was rebooting was forgotten and the new stream auto-played. */
  setUserPaused(v: boolean) {
    this.userPaused = v;
  }

  /** Tear down: remove this instance's listeners, abort the fetch (the server
   *  kills its ffmpeg on connection close), detach the MediaSource from the
   *  element, then release the object URL. Safe to call twice.
   *
   *  Order matters: revoking the blob URL while el.src still pointed at it (and
   *  a live SourceBuffer) could raise el.error on the shared element, poisoning
   *  the NEXT player's readiness poll — that was the freeze right after Stop. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearPoll();
    this.offAll();
    try { this.controller?.abort(); } catch { /* gone */ }
    const ms = this.mediaSource;
    if (ms && ms.readyState === 'open') {
      try { if (this.sb) ms.removeSourceBuffer(this.sb); } catch { /* optional API */ }
      try { ms.endOfStream(); } catch { /* already ended/closed */ }
    }
    this.mediaSource = null;
    this.sb = null;
    try {
      this.el.removeAttribute('src');
      this.el.load();
    } catch { /* ignore */ }
    try { URL.revokeObjectURL(this.objectUrl ?? ''); } catch { /* gone */ }
    this.objectUrl = null;
  }
}

export function createDesktopEngine(
  videoRef: { current: HTMLVideoElement | null },
  events: EngineEvents,
  hostRef: { current: HTMLDivElement | null }
): DesktopEngine {
  let pendingRate = 1;
  let loadToken = 0;
  // URL currently feeding the element; http:// means the ffmpeg fallback tier
  // is active, file:// (or blob for subtitles) is tier 1 native.
  let streamUrl: string | null = null;
  // Active MSE pipeline for the fallback tier (destroyed on every new load/seek/stop).
  let activeMse: MsePlayer | null = null;
  // Codec MIME + duration decided for the current fallback stream (reused by seeks).
  let streamMime: string | null = null;
  let streamDuration: number | null = null;
  // Item behind the current source — enables the one-shot fallback retry when
  // a transient decode error appears at play time.
  let lastItem: MediaItem | null = null;
  // Active subtitle blob URL (revoked on every change to avoid leaks).
  let subBlobUrl: string | null = null;
  // Fallback seek-restart gate: at most ONE decoder restart in flight; while it
  // runs, newer seek targets are queued (latest wins) and exactly one more
  // restart is chained once it settles. Rapid timeline clicks used to spawn
  // overlapping ffmpeg pipelines (each a full teardown+spawn) — heavy CPU lag,
  // torn-down mid-flight streams and race churn.
  let restartInFlight = false;
  let queuedRestartTarget: number | null = null;
  // File time of the seek the engine has committed but whose pipeline has not
  // attached yet (fallback restarts transiently empty the element). Reported
  // by fileTimeNow() for that window so keyboard seeks / progress reads
  // never see the element's bogus reset position.
  let pendingFileTime: number | null = null;
  // Id of the stream session WE started (tier 2). Teardown kills exactly this
  // session — a global kill-all raced a fast Stop → Play and murdered the NEW
  // stream, freezing playback right after restart.
  let stopStreamId: string | null = null;
  /**
   * What the user LAST asked for, independent of the element's transient
   * state. A tier-2 seek-restart detaches the element for a moment, so during
   * that window `el.paused` is true and `el.src` is empty even though media is
   * coming back: trusting either made Pause a no-op and turned Play into a
   * full reload from the start. The intent is re-applied to the element (and to
   * the new pipeline) as soon as the restart settles.
   */
  let userWantsPlayback = false;
  /** A Play pressed while a restart was in flight: applied by the restart gate
   *  once the pipeline that wins has attached. */
  let playWhenSettled = false;

  /**
   * Latest native-tier seek target that arrived while the element was already
   * seeking. Exactly ONE is kept (latest wins) and it is written when the
   * in-flight seek reports 'seeked'. See seek() for why an unconditional
   * currentTime write on every gesture strands the element.
   */
  let pendingNativeSeek: number | null = null;
  // Drag-rate control for scrubThrough(). See its comment: these bound how
  // often the element is actually moved during a pointer drag.
  const SCRUB_SEEK_MIN_MS = 150;
  const SCRUB_DEADBAND_S = 0.75;
  let lastScrubSeekAt = 0;
  let lastScrubTarget = -1;
  let seekSettleTimer: number | null = null;
  let seekSettleBound = false;
  /** Apply the coalesced target once, from the element's own 'seeked' event
   *  (with a short safety timer, because a seek that never reports must not
   *  swallow the user's next seek forever). */
  const applyPendingNativeSeek = (el: HTMLVideoElement) => {
    if (pendingNativeSeek === null) return;
    // Only ONE coalesced write per settle: re-arming here would let a storm
    // keep rewriting currentTime inside the 'seeked' handler.
    const t = pendingNativeSeek;
    pendingNativeSeek = null;
    try { el.currentTime = t; } catch { /* ignore */ }
    armSeekSettle();
  };
  const armSeekSettle = () => {
    const el = videoRef.current;
    if (el && !seekSettleBound) {
      seekSettleBound = true;
      el.addEventListener('seeked', () => {
        if (pendingNativeSeek !== null) applyPendingNativeSeek(el);
      });
    }
    if (seekSettleTimer !== null) return;
    seekSettleTimer = window.setTimeout(() => {
      seekSettleTimer = null;
      const cur = videoRef.current;
      // A seek that never fired 'seeked' (aborted by a load, say) must not
      // strand the user's next gesture.
      if (cur && !cur.seeking && pendingNativeSeek !== null) applyPendingNativeSeek(cur);
    }, 400);
  };

  /** Kill the active stream session, if any. Suppresses one stale stop so an
   *  in-flight kill can never cross a session just started by a newer load. */
  const killSessionScoped = () => {
    if (stopStreamId) {
      void moviraApi.stopStream(stopStreamId).catch(() => undefined);
      stopStreamId = null;
    }
  };

  /** Detach the element from the current source without stopping the ffmpeg
   *  session. Kept detached until a new source attaches: a blob URL left on
   *  el.src whose MediaSource was just destroyed raises el.error — the next
   *  load's MsePlayer polls that error and would refuse to start. */
  const detachElementSource = () => {
    const cur = videoRef.current;
    if (!cur) return;
    cur.removeAttribute('src');
    try { cur.load(); } catch { /* ignore */ }
  };

  /** Full cleanup of the current fallback pipeline + element state. Used by
   *  stop() and by superseded loads — everything resets in one place. */
  const teardownCurrentStream = () => {
    activeMse?.destroy();
    activeMse = null;
    detachElementSource();
    killSessionScoped();
    streamMime = null;
    streamDuration = null;
    fallbackCtx = null;
    streamUrl = null;
    streamEpoch = 0;
    queuedRestartTarget = null;
    pendingFileTime = null;
  };

  /** Context of the ACTIVE fallback stream (tier 2). `streamUrl` is transiently
   *  null while a restart is in flight, so this — not the URL — is the tier-2
   *  authority for seek/scrub. Cleared on teardown/stop/native loads. */
  let fallbackCtx: FallbackCtx | null = null;

  /** File-time position of the playhead, in one place. On tier 2 the element
   *  clock restarts at 0 for every pipeline restart, so the epoch mapping (and
   *  the in-flight seek target) must be applied here — never read
   *  `el.currentTime` directly for a position. */
  const fileTimeNow = (): number => {
    const el = videoRef.current;
    if (!el) return 0;
    if (!fallbackCtx) return el.currentTime;
    if (pendingFileTime !== null) return pendingFileTime;
    return el.currentTime + streamEpoch;
  };

  // ---- Stream-epoch mapping (tier 2) ------------------------------------
  // The fragmented-MP4 muxer NORMALIZES timestamps: a stream started at file
  // time E plays from element time 0. Element time + E therefore equals file
  // time. Without this mapping a seek-restart jumps the playhead to `target`
  // while the buffer still starts at 0 — the element starves until appends
  // crawl up to it (the intermittent freeze right after seeking/Stop→Play on
  // the fallback tier).
  let streamEpoch = 0;

  /** True when the element's buffer actually covers `elT` (element time) with
   *  enough ahead-data for HAVE_FUTURE_DATA. Only such seeks can be applied
   *  instantly; anything else needs an ffmpeg restart at the target. */
  const bufferCovers = (el: HTMLVideoElement, elT: number, fileT: number): boolean => {
    // The target must map INSIDE the current stream's epoch window: a target
    // before the window (t - epoch < 0) belongs to an earlier part of the file
    // this stream never decoded — it needs a restart, not a currentTime set.
    if (fileT - streamEpoch < -0.25) return false;
    const b = el.buffered;
    const dur = fallbackCtx?.duration ?? null;
    const nearFileEnd = dur !== null && isFinite(dur) && dur > 0 && dur - fileT < 1.5;
    for (let i = 0; i < b.length; i++) {
      if (elT >= b.start(i) - 0.25 && (b.end(i) - elT >= 1.5 || (nearFileEnd && elT < b.end(i)))) return true;
    }
    return false;
  };

  /** Apply a file-time target as a plain `currentTime` write when the existing
   *  buffer already covers it. This is the difference between an instant seek
   *  and a full pipeline teardown+ffmpeg respawn, so every seek path funnels
   *  through it. Returns false when a decoder restart is genuinely required. */
  const applyBufferedSeek = (t: number): boolean => {
    const el = videoRef.current;
    if (!el || !fallbackCtx) return false;
    const elT = Math.max(0, t - streamEpoch);
    if (!bufferCovers(el, elT, t)) return false;
    try { el.currentTime = elT; return true; } catch { return false; }
  };

  /** Settle the element on the user's intent once a restart chain ends. A
   *  Play/Pause pressed mid-restart is otherwise simply lost — the element is
   *  whatever the pipeline's autoplay left it as. */
  const settleAfterRestart = () => {
    const el = videoRef.current;
    if (!el) return;
    if (userWantsPlayback || playWhenSettled) {
      playWhenSettled = false;
      void el.play().then(() => events.onPlayingChange(true)).catch(() => events.onPlayingChange(false));
    } else {
      el.pause();
      events.onPlayingChange(false);
    }
  };

  const startFallbackStream = async (token: number, t: number, wasPlaying: boolean, recovery = 0) => {
    const el = videoRef.current;
    const ctx = fallbackCtx;
    if (!el || !ctx) return;
    // Tear the old pipeline down. MsePlayer.destroy() already detaches the
    // element (removeAttribute('src') + load()) and releases the blob URL, so
    // calling detachElementSource() as well meant EVERY seek that needed a new
    // ffmpeg performed TWO full element resets before the new source was even
    // attached. Only detach explicitly when there was no pipeline to destroy
    // (native source being replaced).
    const hadPipeline = activeMse !== null;
    activeMse?.destroy();
    activeMse = null;
    streamUrl = null;
    if (!hadPipeline) detachElementSource();
    const r = await moviraApi.startStream({
      src: ctx.filePath,
      mode: ctx.mode,
      seek: t,
      audioCodec: ctx.audioCodec,
      audioTrack: ctx.audioTrack,
      audioChannels: ctx.audioChannels,
    });
    if (loadToken !== token) {
      // Superseded mid-flight: a newer load/seek/stop owns the element now.
      // Kill the session THIS attempt spawned — unconditionally. (The old
      // owner-diff check could skip the kill when a newer seek had merely
      // queued behind the restart gate, leaving an orphan ffmpeg running.)
      if (r.id) void moviraApi.stopStream(r.id).catch(() => undefined);
      return;
    }
    if (!r.ok || !r.url) {
      teardownCurrentStream();
      events.onPlayingChange(false);
      return;
    }
    stopStreamId = r.id ?? null;
    streamUrl = r.url;
    streamEpoch = t; // element time 0 == file time t (muxer normalization)
    const player = new MsePlayer(el, r.url, { mime: ctx.mime, autoplay: wasPlaying, targetTime: t, durationHint: ctx.duration, epoch: t });
    activeMse = player;
    const ok = await player.start();
    if (loadToken !== token) return;
    pendingFileTime = null; // pipeline attached — element time is authoritative again
    if (ok) {
      // The autoplay decision was captured when this restart was LAUNCHED; a
      // Pause may have landed in between (el.pause() on the detached element
      // was a no-op, and the autoplay retry would have resumed anyway). Re-assert
      // the user's intent now that the element is attached again.
      if (!userWantsPlayback) {
        player.setUserPaused(true);
        try { el.pause(); } catch { /* ignore */ }
        // Explicit state push: the DOM 'pause' event this fires is ignored by
        // the UI while the restart is in flight (it describes the pipeline
        // swap), so the engine has to say so itself.
        events.onPlayingChange(false);
      }
      if (recovery === 0) superviseFallbackStream(token, wasPlaying || userWantsPlayback);
      return;
    }
    // Failed attempt: fully clean so a Play retry starts fresh instead of
    // fighting ghost state (dead stream + stale buffer + el.error).
    teardownCurrentStream();
    events.onPlayingChange(false);
  };

  /** Supervision for the ACTIVE fallback stream: if it dies before the real
   *  end of the media (ffmpeg stream truncation → frozen frame with rs=1, or
   *  endOfStream auto-pause mid-file), restart the pipeline once at the current
   *  position — the element self-heals instead of freezing mid-file. Silent:
   *  the restart is faster than a user would notice. No-ops as soon as the
   *  stream is superseded (new seek/scrub/stop/load). */
  const superviseFallbackStream = (token: number, wasPlaying: boolean) => {
    let timer: number | null = null;
    const cleanup = () => {
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
    };
    const tick = () => {
      // Superseded (new seek/scrub/stop/load) or pipeline torn down.
      if (loadToken !== token || !fallbackCtx) return;
      const el = videoRef.current;
      if (!el) return;
      const now = Date.now();
      // Element time → file time via the stream epoch (muxer normalization).
      const fileT = el.currentTime + streamEpoch;
      if (fileT > lastT + 0.01) { lastT = fileT; lastMove = now; }
      const dur = fallbackCtx.duration;
      const nearEnd = dur !== null && isFinite(dur) && dur > 0 && fileT >= dur - 0.5;
      // ffmpeg died mid-file: response ended → MSE endOfStream → auto-pause
      // while real media remains.
      const endedEarly = el.paused && el.ended && !nearEnd;
      // Stream stalled without ever delivering frames again (truncated before
      // endOfStream, e.g. pipe break): dead air with no error event. During a
      // fresh stream's initial buffer ramp-up readyState can legitimately lag
      // while data flows — require an EMPTY buffer before calling it dead.
      const stalled = !el.paused && el.readyState < 3 && el.buffered.length === 0 && now - lastMove > 7000;
      if (endedEarly || stalled) {
        cleanup();
        if (nearEnd) return; // real EOF — nothing to recover
        const resumeAt = Math.max(0, fileT - 0.35);
        const myToken = ++loadToken;
        launchFallbackRestart(myToken, resumeAt, 1, wasPlaying || userWantsPlayback);
        return;
      }
      timer = window.setTimeout(tick, 1000);
    };
    let lastT = (videoRef.current?.currentTime ?? 0) + streamEpoch;
    let lastMove = Date.now();
    timer = window.setTimeout(tick, 1000);
  };

  /** Launch ONE fallback seek-restart through the in-flight gate. While a
   *  restart is running, newer seek targets are queued (latest wins) and
   *  exactly one more restart is chained when this one settles — overlapping
   *  decoder pipelines never stack, and the final clicked position always wins. */
  const launchFallbackRestart = (token: number, t: number, recovery = 0, wasPlaying?: boolean) => {
    restartInFlight = true;
    void startFallbackStream(token, t, wasPlaying ?? userWantsPlayback, recovery)
      .catch(() => undefined)
      .finally(() => {
        restartInFlight = false;
        const queued = queuedRestartTarget;
        queuedRestartTarget = null;
        // A newer target arrived while this restart was running. The pipeline
        // that just attached very often ALREADY covers it (a back→forward
        // jump inside the freshly decoded window), so try a plain currentTime
        // write before chaining another teardown+respawn. This turns
        // rapid fwd/back seeking from N restarts into one.
        if (queued !== null && fallbackCtx && !applyBufferedSeek(queued)) {
          launchFallbackRestart(++loadToken, queued, 0);
          return; // the chained restart owns the element (and settles it)
        }
        pendingFileTime = null;
        settleAfterRestart();
      });
  };

  const mkState = () => ({
    token: () => loadToken,
    bump: () => {
      loadToken++;
    },
    streamUrl: () => streamUrl,
    setStreamUrl: (u: string | null) => {
      streamUrl = u;
    },
    setItem: (it: MediaItem | null) => {
      lastItem = it;
    },
    mse: () => activeMse,
    setMse: (m: MsePlayer | null) => {
      activeMse = m;
    },
    setStreamFormat: (mime: string | null, duration: number | null) => {
      streamMime = mime;
      streamDuration = duration;
    },
    streamMime: () => streamMime,
    streamDuration: () => streamDuration,
    setFallbackCtx: (c: FallbackCtxInit | null) => {
      fallbackCtx = c ? { ...c, audioTrack: c.audioTrack ?? 0 } : null;
    },
    stopId: () => stopStreamId,
    setStopId: (id: string | null) => {
      stopStreamId = id;
    },
    supervise: (token: number, wasPlaying: boolean) => {
      superviseFallbackStream(token, wasPlaying);
    },
    resetEpoch: () => {
      streamEpoch = 0; // a fresh tier-2 stream starts at file time 0
    },
    clearPendingSeek: () => {
      // A newer load owns the element — a queued restart for the OLD item must
      // never chain into it (it would yank the new load to a stale offset).
      queuedRestartTarget = null;
      pendingFileTime = null;
      // Same for a coalesced native seek: its target belongs to the file being
      // replaced, so it must never be written onto the new source.
      pendingNativeSeek = null;
      if (seekSettleTimer !== null) { clearTimeout(seekSettleTimer); seekSettleTimer = null; }
    },
  });

  return {
    attach(el) {
      const previous = videoRef.current;
      if (previous && previous !== el && previous.parentNode) {
        previous.parentNode.removeChild(previous);
      }
      videoRef.current = el;
      const host = hostRef.current;
      if (host && host.dataset.empty === 'true') {
        host.appendChild(el);
        host.dataset.empty = 'false';
      }
      const volumePref = Number(localStorage.getItem('movira:volumePref'));
      if (isFinite(volumePref) && volumePref >= 0) {
        el.volume = volumePref;
      }
      if (pendingRate !== 1) el.playbackRate = pendingRate;
    },
    setHost(host) {
      const el = videoRef.current;
      if (host && el && !host.contains(el)) {
        host.appendChild(el);
      } else if (!host && el && el.parentNode) {
        el.parentNode.removeChild(el);
      }
    },
    el() {
      return videoRef.current;
    },
    currentFileTime() {
      return fileTimeNow();
    },
    isBufferedAt(fileT) {
      const el = videoRef.current;
      if (!el || !fallbackCtx) return false;
      return bufferCovers(el, Math.max(0, fileT - streamEpoch), fileT);
    },
    /** True while the tier-2 pipeline is active. Combined with an emptied
     *  element in the UI, this distinguishes a seek-restart mid-flight (hold
     *  the last progress state) from a real Stop (report 0). */
    isFallbackBusy(): boolean {
      return fallbackCtx !== null;
    },
    /** Best known media duration in seconds, never Infinity. An MSE source
     *  reports Infinity until the muxer declares a duration (the duration hint
     *  lands with the first append), and an infinite duration makes the seek
     *  timeline reject every gesture as "no duration" — the whole drag/click
     *  silently did nothing right after opening a file. Falls back to the
     *  probed container duration until the element knows better. */
    knownDuration(): number {
      const el = videoRef.current;
      const live = el?.duration ?? NaN;
      const probed = streamDuration;
      const probedOk = probed !== null && isFinite(probed) && probed > 0;
      // On tier 2 the PROBE is authoritative. Chromium reports the end of the
      // buffered range as the duration when no MediaSource.duration was
      // applied, so trusting the element made the seek timeline shrink to
      // whatever ffmpeg had produced so far (a 48s timeline for a 4 hour
      // movie). The element is still trusted on the native tier, where it
      // knows the real duration.
      if (fallbackCtx && probedOk) return probed;
      if (isFinite(live) && live > 0) return live;
      return probedOk ? probed : 0;
    },
    /**
     * Whether the user currently wants playback. The transport UI must ask THIS,
     * never the element's `paused`: mid-seek-restart the element reports paused
     * while the media is still on its way, so a pause button reading the mirror
     * did the opposite of what the user asked for.
     */
    isPlayingIntent(): boolean {
      return userWantsPlayback;
    },
    /** True while a seek-restart owns the element (old pipeline detached, new
     *  one not attached yet). The UI ignores play/pause DOM events in that
     *  window — they describe the pipeline swap, not the user. */
    isRestarting(): boolean {
      return restartInFlight;
    },
    /** Adopt the element's real play/pause state as the user's intent. Called
     *  from the DOM listeners so a pause issued anywhere else (OS media key, a
     *  component touching the element directly) can't leave the transport
     *  button answering the next click from a stale intent. */
    syncPlayingIntent(v: boolean) {
      if (!restartInFlight) userWantsPlayback = v;
    },
    /** Real tracks of the loaded media, straight from the cached probe. */
    async getTracks() {
      const plan = peekPlan(lastItem);
      if (plan) return { audio: plan.audioStreams, subs: plan.subtitleStreams };
      // Not probed yet (native tier, which never needs ffmpeg). Probe once and
      // cache it, so B and V work on plain mp4/mkv too.
      const item = lastItem;
      const el = videoRef.current;
      if (!item || !el) return { audio: [], subs: [] };
      const p = await decideFallbackMode(item, el);
      return { audio: p?.audioStreams ?? [], subs: p?.subtitleStreams ?? [] };
    },
    audioTrackIndex() {
      const el = videoRef.current;
      const at = el ? (el as HTMLVideoElement & { audioTracks?: AudioTracksLike }).audioTracks : undefined;
      if (at && at.length) {
        for (let i = 0; i < at.length; i++) if (at[i].enabled) return i;
      }
      return fallbackCtx?.audioTrack ?? 0;
    },
    /**
     * VLC's B: cycle the audio track.
     *
     * Native tier: the element owns the file's real tracks, so this is just an
     * `enabled` toggle — instant and lossless.
     * Fallback tier: MSE carries exactly ONE audio stream, chosen at mux time,
     * so the switch needs a decoder restart at the current position. The restart
     * reuses the normal seek machinery (one in flight, targets coalesced), so
     * hammering B cannot stack pipelines.
     */
    async cycleAudioTrack() {
      const el = videoRef.current;
      if (!el) return '';
      const { audio } = await this.getTracks();
      const at = (el as HTMLVideoElement & { audioTracks?: AudioTracksLike }).audioTracks;
      // Graceful no-op for a single-track file — VLC does the same.
      if ((at && at.length < 2) || (!at && audio.length < 2)) return '';
      const current = this.audioTrackIndex();
      const n = Math.max(at?.length ?? 0, audio.length);
      const nextIdx = (current + 1) % n;
      if (at && at.length) {
        for (let i = 0; i < at.length; i++) at[i].enabled = i === nextIdx;
      }
      if (fallbackCtx) {
        fallbackCtx.audioTrack = nextIdx;
        // The new track can have a different channel count (a commentary track
        // is usually mono, the main one 5.1), and ffmpeg must be told it or the
        // transcoded init segment comes out non-conformant and is rejected.
        fallbackCtx.audioChannels = audio[nextIdx]?.channels ?? null;
        const t = fileTimeNow();
        pendingFileTime = t;
        launchFallbackRestart(++loadToken, t, 0, userWantsPlayback);
      }
      const info = audio[nextIdx];
      return info
        ? `${info.language ? info.language.toUpperCase() : 'Track'} ${nextIdx + 1}`
        : `Track ${nextIdx + 1}`;
    },
    /** Pull one embedded subtitle stream out of the file as WebVTT (V key). */
    async getEmbeddedSubtitle(index) {
      const item = lastItem;
      if (!item) return null;
      const vtt = await moviraApi.readEmbeddedSubtitle(item.path, index);
      if (!vtt) return null;
      return { id: `embedded-${item.id}-${index}`, label: `Subtitle ${index + 1}`, content: vtt };
    },
    /**
     * Three-tier playback engine (see loadInternal below the factory).
     *
     * Tier 1 — native file:// streaming, GPU/hardware decode, verified by a
     *          watchdog that requires real frame delivery ('playing').
     * Tier 2 — ffmpeg remux/transcode → fragmented-MP4 over localhost → MSE,
     *          for containers/codecs Chromium cannot demux/decode (TS/AVI/VOB/
     *          WMV/VC-1/MPEG-2/Real…). Timestamps preserved so seeking works.
     * Tier 3 — a clear error; the app always stays interactive.
     *
     * `loadToken` cancels every obsolete load/verification/fallback operation
     * and is the single authority on which load owns the element.
     */
    async load(item, autoplay = true) {
      const el = videoRef.current;
      userWantsPlayback = autoplay;
      playWhenSettled = false;
      await loadInternal(el, item, autoplay, events, mkState());
    },
    async play() {
      const el = videoRef.current;
      if (!el) return;
      userWantsPlayback = true;
      // A tier-2 seek-restart detaches the element, so `el.src` is empty and
      // `el.paused` is true for that window even though media is seconds away.
      // Taking the "no source -> reload" path here threw the restart away and
      // restarted the whole decode from the beginning (the timeline jumped to
      // 0 when the user pressed Play during a seek). Wait for the pipeline
      // instead: the restart gate settles the element on this intent.
      if (fallbackCtx && restartInFlight) {
        playWhenSettled = true;
        return;
      }
      // After stop() the element source is detached — but the user pressing
      // Play expects the stopped media to resume from the start. Reload the
      // last item instead of silently doing nothing.
      if (!el.src) {
        const item = lastItem;
        if (item) await loadInternal(el, item, true, events, mkState());
        return;
      }
      try {
        await el.play();
        return;
      } catch {
        events.onPlayingChange(false);
      }
      // One-shot recovery: a native source that errored between load and play
      // (transient decoder/buffering failure) gets exactly one fallback-tier
      // attempt. MSE fallback sources are not retried here — their failure is
      // already terminal in loadInternal.
      const item = lastItem;
      if (item && !streamUrl?.startsWith('http') && !el.error?.code) {
        await loadInternal(el, item, true, events, mkState());
      }
    },
    async pause() {
      userWantsPlayback = false;
      playWhenSettled = false;
      // Tell the active pipeline too: its autoplay 'canplay' retry must not
      // resume a video the user just paused.
      activeMse?.setUserPaused(true);
      videoRef.current?.pause();
    },
    async stop() {
      const el = videoRef.current;
      loadToken++; // invalidate any in-flight load/verification/fallback work
      userWantsPlayback = false;
      playWhenSettled = false;
      activeMse?.destroy();
      activeMse = null;
      if (el) {
        el.pause();
        // Detach BEFORE killing the session, and keep detached (no load() until
        // a new source attaches) so no stale decoder/blob state can fire events
        // or wedge the element during the Stop → Play gap.
        detachElementSource();
      }
      // Stop semantics: "watch this from the beginning next time". Clear the
      // saved position NOW — clearing on the next load would be too late (the
      // DOM loadedmetadata resume-seek fires first and jumps into the middle,
      // which was the post-Stop restart freeze). Pause keeps the position.
      if (lastItem) clearResumePosition(lastItem.id);
      // Session-scoped kill ONLY. The old stopStreams() killed every ffmpeg
      // session: a Play pressed right after Stop started a new session and the
      // late kill-all murdered it — instant freeze / dead timeline.
      killSessionScoped();
      streamMime = null;
      streamDuration = null;
      fallbackCtx = null;
      streamUrl = null;
      streamEpoch = 0;
      queuedRestartTarget = null;
      pendingFileTime = null;
      // State events AFTER the source is detached: the DOM pause/load fires
      // pause/emptied synchronously and must not re-enter UI state afterwards.
      events.onProgress(0, 0);
      events.onPlayingChange(false);
    },
    async seek(t) {
      const el = videoRef.current;
      if (!el) return;
      // Guard against non-finite targets (streams can expose Infinity durations).
      if (!isFinite(t) || t < 0) return;
      if (fallbackCtx) {
        // ONE GESTURE = ONE SEEK. Repeating the position we are already heading
        // to (double-click, a drag that ends where it began) must not queue a
        // second, identical operation.
        const atTarget = pendingFileTime !== null && Math.abs(pendingFileTime - t) < 0.05;
        if (atTarget) return;
        // While a restart is in flight the element is being rebuilt, so a
        // buffered seek is not available — record the LATEST target only
        // (latest-wins) and let the gate settle it. Old targets are discarded,
        // never queued.
        if (restartInFlight) {
          queuedRestartTarget = t;
          pendingFileTime = t;
          return;
        }
        // Definitive seek: bump the token BEFORE the async work so any
        // load/seek/scrub started in parallel invalidates this one (race-free).
        const myToken = ++loadToken;
        if (applyBufferedSeek(t)) {
          pendingFileTime = null; // element time is authoritative again
          return;
        }
        // Genuinely outside the decoded window: restart ffmpeg at the target.
        pendingFileTime = t;
        launchFallbackRestart(myToken, t, 0, userWantsPlayback);
        return;
      }
      const dur = el.duration;
      if (isFinite(dur) && dur > 0 && t > dur) t = Math.max(0, dur - 0.25);
      // A seek is ONLY ever a currentTime assignment. It must not reload the
      // media, reassign src or reinitialise the decoder — that is what makes a
      // player feel like it freezes for half a second every time you click the
      // timeline. The previous fallback here called el.load() when the
      // assignment threw, which turned one bad seek into a full pipeline
      // rebuild; clamping into range is enough.
      //
      // It must ALSO not be written while a previous seek is still in flight.
      // Chromium cancels an uncommitted seek when currentTime moves again, so
      // a storm of writes (click, click, click across a 80-minute timeline)
      // repeatedly restarts the fetch and the element can be left sitting at
      // HAVE_METADATA with no data — the "sometimes the player stops
      // responding after seeking" report, reproduced in the acceptance suite.
      // Coalescing to ONE pending target and applying it when the in-flight
      // seek reports 'seeked' keeps the element's own seek state machine
      // authoritative, which is what every native player does.
      if (el.seeking) {
        pendingNativeSeek = t;
        armSeekSettle();
        return;
      }
      try {
        el.currentTime = t;
      } catch {
        try { el.currentTime = Math.max(0, t); } catch { /* nothing more to try */ }
      }
      armSeekSettle();
    },
    scrubThrough(t) {
      const el = videoRef.current;
      if (!el || !isFinite(t) || t < 0) return;
      // Native tier: an in-buffer seek is the cheapest real seek there is, but
      // it is NOT free: every write cancels/queues a decoder seek and, for a
      // multi-GB file served over range requests, a fetch. Writing it on every
      // pointer frame is "continuously assigning currentTime" and "an expensive
      // operation during pointer movement" — both explicitly forbidden.
      //
      // So the drag PREDICTS (UI follows the pointer for free) and the element
      // is moved at a controlled rate: at most one write every SCRUB_SEEK_MIN_MS,
      // and never for a target that is within SCRUB_DEADBAND_S of the last one
      // written. The exact final position is committed once by seek() on release,
      // so throttling costs nothing in accuracy.
      if (!fallbackCtx) {
        const now = performance.now();
        // Skip when EITHER limit applies. The rate limit alone is what bounds
        // the write count; the deadband additionally avoids pointless writes
        // for sub-second pointer jitter. (These must be OR'd: a fast drag moves
        // the target far more than the deadband every frame, so AND-ing them
        // let every single write through — which the dense-drag test caught.)
        if (
          now - lastScrubSeekAt < SCRUB_SEEK_MIN_MS ||
          Math.abs(t - lastScrubTarget) < SCRUB_DEADBAND_S
        ) return;
        lastScrubTarget = t;
        lastScrubSeekAt = now;
        try { el.currentTime = t; } catch { /* ignore */ }
        return;
      }
      // Fallback tier, VLC-style drag: a mid-drag decoder restart is NEVER
      // worth it (each one tears down the whole pipeline — the old 2-runs/sec
      // throttle still froze/jumped visibly while dragging). The drag is
      // preview-only: targets inside the already-decoded window apply
      // instantly (free, no restart); anything else just moves the UI preview
      // and is committed once, exactly, by seek() on release.
      applyBufferedSeek(t);
    },
    async setVolume(v) {
      const el = videoRef.current;
      if (el) {
        el.volume = v;
        el.muted = v === 0;
      }
    },
    setMuted(m) {
      const el = videoRef.current;
      if (!el) return m;
      el.muted = m;
      return m;
    },
    toggleMute() {
      const el = videoRef.current;
      if (!el) return false;
      el.muted = !el.muted;
      return el.muted;
    },
    async setRate(r) {
      pendingRate = r;
      const el = videoRef.current;
      if (el) el.playbackRate = r;
    },
    setRepeat() {},
    setShuffle() {},
    async setSubtitles(track) {
      const el = videoRef.current;
      if (!el) return;
      // Revoke the previous subtitle blob URL — creating a new one per subtitle
      // change without revoking leaked memory for the lifetime of the page.
      if (subBlobUrl) {
        URL.revokeObjectURL(subBlobUrl);
        subBlobUrl = null;
      }
      Array.from(el.querySelectorAll('track')).forEach((t) => t.remove());
      if (track?.content) {
        const blob = new Blob([track.content], { type: 'text/vtt' });
        const url = URL.createObjectURL(blob);
        subBlobUrl = url;
        const tr = document.createElement('track');
        tr.kind = 'subtitles';
        // The REAL track label, so V cycling is observable on the element and
        // the on-screen indicator can name the language being shown.
        tr.label = track.label || 'Subtitles';
        tr.src = url;
        el.appendChild(tr);
        await new Promise<void>((resolve) => {
          tr.addEventListener('load', () => resolve(), { once: true });
          tr.addEventListener('error', () => resolve(), { once: true });
          setTimeout(resolve, 1000);
        });
        if (el.textTracks.length) el.textTracks[el.textTracks.length - 1].mode = 'showing';
      }
    },
    async setAudioTrack(index = 0) {
      const el = videoRef.current;
      if (!el) return;
      // Native tier: the element carries the file's real audio tracks.
      const at = (el as HTMLVideoElement & { audioTracks?: AudioTracksLike }).audioTracks;
      if (at && at.length) {
        for (let i = 0; i < at.length; i++) at[i].enabled = i === index;
        return;
      }
      // Fallback tier: the audio is chosen at mux time, so switching means a
      // restart at the current position.
      if (fallbackCtx && fallbackCtx.audioTrack !== index) {
        fallbackCtx.audioTrack = index;
        const t = fileTimeNow();
        pendingFileTime = t;
        launchFallbackRestart(++loadToken, t, 0, userWantsPlayback);
      }
    },
    async getAudioTracks() {
      const { audio } = await this.getTracks();
      if (audio.length) {
        return audio.map((a) => ({
          index: a.index,
          label: `${a.language ? a.language.toUpperCase() : 'Track'} ${a.index + 1}`,
        }));
      }
      const el = videoRef.current;
      const at = el ? (el as HTMLVideoElement & { audioTracks?: AudioTracksLike }).audioTracks : undefined;
      if (at && at.length) {
        return Array.from({ length: at.length }, (_, i) => ({ index: i, label: at[i].label || `Track ${i + 1}` }));
      }
      return [];
    },
    async setPip(on) {
      const el = videoRef.current;
      if (!el) return false;
      try {
        if (on && document.pictureInPictureElement !== el) await el.requestPictureInPicture();
        else if (!on && document.pictureInPictureElement) await document.exitPictureInPicture();
        return true;
      } catch {
        return false;
      }
    },
  } as DesktopEngine;
}

// ---------------------------------------------------------------------------------
// Tiered loading pipeline
// ---------------------------------------------------------------------------------

/**
 * Wait until the element is genuinely delivering frames ('playing'), probing
 * readyState so a stream stuck in HAVE_METADATA never passes. Resolves false
 * on error or timeout — never throws.
 */
/**
 * The MIME string Chromium ACTUALLY accepts for each audio codec, measured on * the packaged engine rather than assumed.
 *
 * This matters because `canPlayType` is exacting: `audio/mp4; codecs="aac"` * answers "" (unplayable) while `audio/mp4; codecs="mp4a.40.2"` answers
 * "probably". Probing with the bare token made AAC — the most common audio * codec in existence — look unsupported, so `decideMode` re-encoded it on every * fallback load. AC-3 / E-AC-3 / DTS answer "" in every form, which is the * measured truth: this Chromium has no decoder for them.
 */
const AUDIO_CODEC_MIME: Record<string, string> = {
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: 'audio/mpeg',
  opus: 'audio/webm; codecs="opus"',
  flac: 'audio/flac',
  'ac-3': 'audio/ac3',
  'ec-3': 'audio/eac3',
  dts: 'audio/vnd.dts',
  alac: 'audio/alac',
  wma: 'audio/x-ms-wma',
};

/**
 * Chromium counts decoded audio bytes on the media element. It is not in the
 * TS DOM lib, so it is declared structurally here.
 */
type AudioCountingElement = HTMLVideoElement & { webkitAudioDecodedByteCount?: number };

function audioDecodedBytes(el: HTMLVideoElement): number {
  const v = (el as AudioCountingElement).webkitAudioDecodedByteCount;
  return typeof v === 'number' ? v : -1;
}

/**
 * How long tier-1 native playback is given to start producing sound before the
 * engine concludes it is silent. Audio frames decode well inside this window
 * for every format that actually works (decoded silent content still counts), * so it only ever delays a file whose audio is genuinely not decoding.
 */
const AUDIO_DECODE_GRACE_MS = 2000;

/**
 * Resolves the number of decoded audio bytes once sound is flowing, or 0 after
 * `graceMs` if none arrived. Returns -1 when the runtime does not expose the
 * counter at all, so callers keep native playback rather than guess.
 */
function waitForAudioDecode(el: HTMLVideoElement, graceMs: number): Promise<number> {
  if (audioDecodedBytes(el) < 0) return Promise.resolve(-1);
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const b = audioDecodedBytes(el);
      if (b > 0 || Date.now() - started >= graceMs) {
        clearInterval(poll);
        resolve(b > 0 ? b : 0);
      }
    }, 150);
  });
}

function waitForPlayback(el: HTMLVideoElement, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('error', onError);
      resolve(ok);
    };
    const onPlaying = () => finish(true);
    const onError = () => finish(false);
    const poll = setInterval(() => {
      if (el.error) return finish(false);
      // readyState >= 3 (HAVE_FUTURE_DATA) with an advancing clock means frames flow.
      if (el.readyState >= 3 && !el.paused) finish(true);
    }, 250);
    const timer = setTimeout(() => finish(false), timeoutMs);
    el.addEventListener('playing', onPlaying);
    el.addEventListener('error', onError);
  });
}

/** Probe + decide the ffmpeg fallback plan for a file: mode, MSE mime, duration,
 *  source audio codec (needed for the ADTS→ASC bitstream filter on TS-class
 *  input) and the file's real audio/subtitle stream lists (B / V keys).
 *
 *  CACHED per file path: the probe spawns an ffmpeg process and the plan needs
 *  the element's codec capabilities. Re-doing both on every load made skipping to
 *  another queue entry (and every re-open of the same movie) pay a full process
 *  spawn before a single frame could appear. The cache lives for the session and
 *  is keyed by path + size, so a replaced file re-probes. */
const planCache = new Map<string, { size: number; plan: FallbackPlan }>();

/** Everything one probe tells us about a file. */
export interface FallbackPlan {
  mode: 'remux' | 'remux-tc-audio' | 'transcode-video' | 'transcode-audio-only';
  mime: string;
  durationSec: number | null;
  audioCodec: string | null;
  audioStreams: ProbeStream[];
  subtitleStreams: ProbeStream[];
}

async function decideFallbackMode(item: MediaItem, el: HTMLVideoElement): Promise<FallbackPlan | null> {
  // Cache hit only when the file itself is unchanged; the element's codec
  // support cannot change while the app runs.
  const cached = planCache.get(item.path);
  if (cached && cached.size === item.size) return cached.plan;
  const probe = await moviraApi.probeMedia(item.path);
  if (!probe) return null; // ffmpeg unavailable or file unreadable

  // Capability sets from the actual element.
  //
  // Audio codecs are probed with the MIME string Chromium ACTUALLY accepts
  // (measured on the packaged engine, see AUDIO_CODEC_MIME). Probing with the
  // bare codec token inside `audio/mp4` — `codecs="aac"` — returns "" for AAC, * so AAC used to be reported as unsupported and `decideMode` needlessly
  // re-encoded it (AAC→AAC) on every fallback load.
  const audioCaps = new Set<string>();
  for (const [codec, mime] of Object.entries(AUDIO_CODEC_MIME)) {
    try {
      if (el.canPlayType(mime) !== '') audioCaps.add(codec);
    } catch { /* ignore */ }
  }
  const videoCaps = new Set<string>();
  const videoProbe: Array<[string, string]> = [
    ['h264', 'avc1.640029'],
    ['hevc', 'hvc1.1.6.L93.B0'],
    ['vp8', 'vp8'],
    ['vp9', 'vp09.00.10.08'],
    ['av1', 'av01.0.04M.08'],
  ];
  for (const [name, entry] of videoProbe) {
    try {
      if (el.canPlayType(`video/mp4; codecs="${entry}"`) !== '') videoCaps.add(name);
    } catch { /* ignore */ }
  }

  let mode = await moviraApi.decideMode(
    { videoCodec: probe.videoCodec, audioCodec: probe.audioCodec },
    Array.from(audioCaps),
    Array.from(videoCaps)
  ) as FallbackMode | null;
  if (!mode) return null;

  // The MSE mime must describe what the pipeline EMITS, not what the file
  // holds. Deciding that from the SOURCE codec was a latent bug: every codec
  // that needs a transcode (mpeg2video, vc1, wmv3, rv40, msmpeg4…) has no
  // MP4 sample entry, so the plan declared an AUDIO-ONLY SourceBuffer while
  // ffmpeg was about to push H.264 video into it. Chromium rejected the very
  // first append and the file never played at all.
  const aEntrySrc = probe.audioCodec ? mp4AudioCodecEntry(probe.audioCodec) : null;
  const vEntrySrc = probe.videoCodec ? mp4VideoCodecEntry(probe.videoCodec) : null;
  // remux / remux-tc-audio COPY the source video stream. If that codec has no
  // MP4 sample entry the muxer cannot express it, so transcode instead.
  if ((mode === 'remux' || mode === 'remux-tc-audio') && !vEntrySrc) mode = 'transcode-video';

  const tracks = {
    audioStreams: probe.audioStreams ?? [],
    subtitleStreams: probe.subtitleStreams ?? [],
  };
  // A SourceBuffer codec string is a FILTER, not a label: it states which
  // tracks the buffer will ACCEPT. Declaring mp4a.40.2 for a source with no
  // audio track at all makes Chromium reject every fragment of the stream, so
  // the file never plays — the pipeline looked perfectly healthy (ffmpeg was
  // writing megabytes, no error anywhere) while the element sat at readyState
  // 0 forever. Measured on mpeg2video .ts rips that carry no audio stream.
  // A video-only source therefore gets a video-only codec string.
  const hasAudio = !!probe.audioCodec && tracks.audioStreams.length > 0;
  let mime: string;
  if (mode === 'transcode-audio-only') {
    mime = 'audio/mp4; codecs="mp4a.40.2"';
  } else if (mode === 'transcode-video') {
    // Always H.264 + AAC out, whatever came in.
    mime = hasAudio
      ? 'video/mp4; codecs="avc1.640029, mp4a.40.2"'
      : 'video/mp4; codecs="avc1.640029"';
  } else {
    // remux keeps the source audio (decideMode guarantees it is MP4-safe and
    // decodable); remux-tc-audio re-encodes it to AAC.
    const audioEntry = mode === 'remux' && aEntrySrc ? aEntrySrc : 'mp4a.40.2';
    mime = hasAudio
      ? `video/mp4; codecs="${vEntrySrc}, ${audioEntry}"`
      : `video/mp4; codecs="${vEntrySrc}"`;
  }
  return rememberPlan(item, { mode, mime, durationSec: probe.durationSec, audioCodec: probe.audioCodec, ...tracks });
}

function rememberPlan(item: MediaItem, plan: FallbackPlan): FallbackPlan {
  planCache.set(item.path, { size: item.size ?? 0, plan });
  return plan;
}

/** Cached plan for a file, without re-probing (null when never probed). */
function peekPlan(item: MediaItem | null): FallbackPlan | null {
  if (!item) return null;
  const c = planCache.get(item.path);
  return c && c.size === (item.size ?? 0) ? c.plan : null;
}

/**
 * Tiered load: native attempt with a playback watchdog, escalating to the
 * ffmpeg+MSE streaming tier on failure. Any newer load invalidates in-flight
 * work through loadToken (race-free: cancelled tiers never touch the element).
 */
async function loadInternal(
  el: HTMLVideoElement | null,
  item: MediaItem,
  autoplay: boolean,
  events: EngineEvents,
  state: {
    token: () => number;
    bump: () => void;
    streamUrl: () => string | null;
    setStreamUrl: (u: string | null) => void;
    setItem: (it: MediaItem | null) => void;
    mse: () => MsePlayer | null;
    setMse: (m: MsePlayer | null) => void;
    setStreamFormat: (mime: string | null, duration: number | null) => void;
    streamMime: () => string | null;
    streamDuration: () => number | null;
    setFallbackCtx: (c: FallbackCtxInit | null) => void;
    stopId(): string | null;
    setStopId(id: string | null): void;
    supervise(token: number, wasPlaying: boolean): void;
    resetEpoch(): void;
    clearPendingSeek(): void;
  }
): Promise<void> {
  if (!el) return;
  state.bump();
  state.setItem(item);
  const token = state.token();

  const teardown = () => {
    try { el.pause(); } catch { /* ignore */ }
    state.mse()?.destroy();
    state.setMse(null);
    // Kill ONLY the stream session this engine owns (session-scoped). The old
    // kill-all raced a fast Stop → Play and killed the freshly started session.
    const sid = state.stopId();
    if (sid) {
      void moviraApi.stopStream(sid).catch(() => undefined);
      state.setStopId(null);
    }
    el.removeAttribute('src');
    try { el.load(); } catch { /* ignore */ }
    state.setStreamFormat(null, null);
    state.setFallbackCtx(null);
    state.setStreamUrl(null);
    state.clearPendingSeek();
  };

  // ---- 1) Always start from a clean element.
  teardown();

  const setSource = (url: string) => {
    state.setStreamUrl(url);
    el.src = url;
    el.preload = 'auto';
    try { el.load(); } catch { /* ignore */ }
  };

  const finishError = (msg: string) => {
    if (state.token() !== token) return;
    events.onError(msg);
    events.onPlayingChange(false);
  };

  // ---- 2) Tier 1: native with pre-flight capability check.
  const unsupported = detectUnsupportedCodec(el, item.path, item.type !== 'video');
  if (unsupported) {
    // The engine definitively cannot decode this (WMV/RM/APE/DivX…).
    // Skip straight to the fallback tier instead of a doomed native attempt.
    const plan = await decideFallbackMode(item, el);
    if (state.token() !== token) return;
    if (plan) {
      const r = await moviraApi.startStream({ src: item.path, mode: plan.mode, seek: 0, audioCodec: plan.audioCodec ?? undefined, audioChannels: channelsForTrack(plan, 0) });
      if (state.token() !== token) {
        if (r.id) void moviraApi.stopStream(r.id).catch(() => undefined);
        return;
      }
      if (r.ok && r.url) {
        state.setStopId(r.id ?? null);
        state.setStreamUrl(r.url);
        state.setStreamFormat(plan.mime, plan.durationSec);
        state.setFallbackCtx({ filePath: item.path, mode: plan.mode, mime: plan.mime, duration: plan.durationSec, audioCodec: plan.audioCodec ?? undefined, audioChannels: channelsForTrack(plan, 0) });
        const player = new MsePlayer(el, r.url, { mime: plan.mime, autoplay, targetTime: null, durationHint: plan.durationSec, epoch: 0 });
        state.setMse(player);
        const ok = await player.start();
        if (state.token() !== token) return;
        if (ok) {
          // Escalation replaced a failed tier-1 attempt; the user asked for
          // playback — supervise with wasPlaying=true.
          state.resetEpoch();
          state.supervise(token, true);
          events.onPlayingChange(true);
          return;
        }
      }
    }
    finishError(`${fileBase(item.path)} uses a format this system cannot decode${probeHint(item.path)}`);
    return;
  }

  setSource(fileToUrl(item.path));
  if (!autoplay) return; // native set; verification happens on play

  // ---- 3) Verification watchdog: does native playback actually deliver frames?
  try {
    await Promise.race([el.play().catch(() => undefined), sleep(150)]);
  } catch { /* handled below */ }
  if (state.token() !== token) return;
  let playing = await waitForPlayback(el, 8000);
  if (state.token() !== token) return;
  if (playing) {
    // Video frames flowing is NOT proof of audio. Chromium demuxes MKV and * decodes H.264/HEVC video while silently dropping an audio codec it has no * decoder for (AC-3 / E-AC-3 / DTS): the element reports "playing", the * picture is perfect, and there is simply no sound. The watchdog above only * watches frames, so it used to call that a success and the ffmpeg tier — * which would have re-encoded exactly this audio to AAC — was never asked.
    //
    // The check costs nothing for formats that already work: Chromium counts * decoded audio bytes, and anything genuinely producing sound increments it * inside the grace window. Only a file that is playing video with ZERO * decoded audio bytes consults the (cached) fallback plan.
    const audioBytes = await waitForAudioDecode(el, AUDIO_DECODE_GRACE_MS);
    if (state.token() !== token) return;
    if (audioBytes !== 0) return; // sound is flowing (or runtime cannot count it)
    const audioPlan = await decideFallbackMode(item, el);
    if (state.token() !== token) return;
    // 'remux' means the plan found no audio track at all, or audio Chromium can * decode (it had merely not started yet) — the native tier is correct either * way, and every working MP4 / AAC / Opus / FLAC file lands here untouched.
    if (!audioPlan || audioPlan.mode === 'remux') return;
    // Anything else means the audio must be transcoded before it can be heard: * fall through to tier 2, which streams the video copied-untouched alongside * AAC audio over MSE.
  }

  // ---- 4) Tier 2: escalate to the ffmpeg + MSE streaming tier.
  const plan = await decideFallbackMode(item, el);
  if (state.token() !== token) return;
  if (!plan) {
    finishError(el.error ? describeMediaError(el.error.code, item.path, el.error.message) : `Cannot play ${fileBase(item.path)}`);
    return;
  }

  const r = await moviraApi.startStream({ src: item.path, mode: plan.mode, seek: 0, audioCodec: plan.audioCodec ?? undefined, audioChannels: channelsForTrack(plan, 0) });
  if (state.token() !== token) {
    if (r.id) void moviraApi.stopStream(r.id).catch(() => undefined);
    return;
  }
  if (!r.ok || !r.url) {
    finishError(el.error ? describeMediaError(el.error.code, item.path, el.error.message) : `Cannot play ${fileBase(item.path)} — no decoder available`);
    return;
  }
  state.setStopId(r.id ?? null);
  state.setStreamUrl(r.url);
  state.setStreamFormat(plan.mime, plan.durationSec);
  state.setFallbackCtx({ filePath: item.path, mode: plan.mode, mime: plan.mime, duration: plan.durationSec, audioCodec: plan.audioCodec ?? undefined, audioChannels: channelsForTrack(plan, 0) });
  const player = new MsePlayer(el, r.url, { mime: plan.mime, autoplay, targetTime: null, durationHint: plan.durationSec, epoch: 0 });
  state.setMse(player);
  playing = await player.start(30000); // transcode start-up takes a moment
  if (state.token() !== token) return;
  if (playing) {
    state.resetEpoch();
    state.supervise(token, true);
    return;
  }

  // ---- 5) Both tiers failed: clean error, interactive app.
  teardown();
  finishError(
    el.error
      ? describeMediaError(el.error.code, item.path, el.error.message)
      : `${fileBase(item.path)} could not be played with the built-in or fallback decoder`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fileToUrl(p: string): string {
  return p.startsWith('file://') ? p : `file://${p.replace(/\\/g, '/').split('#').join('%23').split('?').join('%3F')}`;
}

function fileBase(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function probeHint(p: string): string {
  const ext = p.toLowerCase().split('.').pop() ?? '';
  const hints: Record<string, string> = {
    wmv: ' (WMV/VC-1)', asf: ' (WMV/VC-1)', rm: ' (RealVideo)', rmvb: ' (RealVideo)',
    divx: ' (DivX)', xvid: ' (Xvid)', mpeg2: ' (MPEG-2)', mpg: ' (MPEG-2)',
    ape: ' (Monkey\'s Audio)', ra: ' (RealAudio)',
  };
  return hints[ext] ?? '';
}

/** Wired by createServices(): lets the engine clear an item's saved resume
 *  position. Renderer-local (localStorage) — deliberately not IPC. */
let clearResumeHook: ((itemId: string) => void) | null = null;

function clearResumePosition(itemId: string) {
  try { clearResumeHook?.(itemId); } catch { /* ignore */ }
}

export interface DesktopServices {
  storage: StorageAdapter;
  player: MediaPlayerService;
  playlists: PlaylistService;
  library: MediaLibraryService;
  subtitles: SubtitleService;
  userData: UserDataService;
  engine: DesktopEngine;
}

/** Persisted state that describes MEDIA the user put in the app: the watched
 *  library, the queue, saved playlists, history, favourites and per-file resume
 *  positions. All of it is deliberately discarded on every launch. */
const PERSISTED_MEDIA_KEYS = [
  storageKeys.libraryFolders,
  storageKeys.libraryItems,
  storageKeys.playlists,
  storageKeys.queue,
  storageKeys.history,
  storageKeys.favorites,
  storageKeys.resume,
] as const;

/**
 * Wipe persisted media state before anything reads it.
 *
 * Movira must open completely empty: no library folders, no library items, no
 * restored queue, no playlists, nothing left over from the previous session —
 * until the user picks files themselves. Every service below reads its state
 * during init(), so the wipe has to happen BEFORE they are constructed;
 * otherwise the first render would show the previous session's media and then
 * blink out of it.
 *
 * App preferences (`settings`, `playbackPrefs` — theme, volume, playback
 * options) are deliberately NOT cleared: they are not media, and resetting
 * someone's theme on every launch would be its own kind of bug.
 */
async function clearPersistedMedia(storage: StorageAdapter): Promise<void> {
  await Promise.all(
    PERSISTED_MEDIA_KEYS.map((key) => storage.delete(key).catch(() => undefined))
  );
}

export async function createServices(
  videoRef: { current: HTMLVideoElement | null },
  events: EngineEvents,
  hostRef: { current: HTMLDivElement | null }
): Promise<DesktopServices> {
  const storage = createStorageAdapter();
  // Must precede every service's init(): see clearPersistedMedia.
  await clearPersistedMedia(storage);
  const engine = createDesktopEngine(videoRef, events, hostRef);
  clearResumeHook = (itemId: string) => void userData.clearResumePosition(itemId);

  const player = new MediaPlayerService(engine, events, (state: QueueState) => {
    void storage.set('queue', state);
  });

  const playlists = new PlaylistService(storage);
  const library = new MediaLibraryService(
    storage,
    {
      async listMediaFiles(folder) {
        return moviraApi.listMedia(folder);
      },
      async exists(p) {
        return moviraApi.exists(p);
      },
    },
    {
      async enrich(items) {
        const out: MediaItem[] = [];
        for (const it of items) {
          if (it.duration !== undefined) {
            out.push(it);
            continue;
          }
          const md = await moviraApi.readMetadata(it.path).catch(() => null);
          if (!md) {
            out.push(it);
            continue;
          }
          out.push({
            ...it,
            title: (md.title as string) || it.title,
            artist: md.artist as string | undefined,
            album: md.album as string | undefined,
            genre: md.genre as string | undefined,
            year: md.year as number | undefined,
            duration: (md.duration as number) ?? it.duration,
            artwork: (md.artwork as string) ?? it.artwork,
          });
        }
        return out;
      },
    }
  );
  const subtitles = new SubtitleService({
    search: async ({ name, languages }) => moviraApi.searchSubtitlesOnline(name, languages),
    download: async (result) => moviraApi.downloadSubtitleOnline(result.url),
  });
  const userData = new UserDataService(storage);

  await Promise.all([playlists.init(), library.init(), userData.init()]);

  const savedQueue = (await storage.get('queue')) as QueueState | null;
  if (savedQueue?.items?.length) {
    // Prune entries whose files no longer exist (moved/deleted media, or
    // leftovers from a buggy session): restoring them made the home screen
    // offer a Play button that started a nonexistent file.
    const exists = await Promise.all(savedQueue.items.map((it) => moviraApi.exists(it.path).catch(() => false)));
    const kept: MediaItem[] = [];
    const keptIndex = new Map<number, number>();
    savedQueue.items.forEach((it, i) => {
      if (exists[i]) {
        keptIndex.set(i, kept.length);
        kept.push(it);
      }
    });
    if (!kept.length) {
      // Nothing left of the old queue — clear the stale persisted state.
      await storage.set('queue', null);
    } else {
      player.setQueue(kept, keptIndex.get(savedQueue.index) ?? 0, false);
      if (kept.length !== savedQueue.items.length) await storage.set('queue', player.getQueue());
      player.cycleRepeat();
      player.cycleRepeat();
      player.cycleRepeat();
      if (savedQueue.repeat === 'all') {
        while (player.getRepeat() !== 'all') await player.cycleRepeat();
      } else if (savedQueue.repeat === 'one') {
        while (player.getRepeat() !== 'one') await player.cycleRepeat();
      }
      if (savedQueue.shuffle) await player.toggleShuffle();
    }
  }

  return { storage, player, playlists, library, subtitles, userData, engine };
}
