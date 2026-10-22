/**
 * RUNTIME LAG RECORDER
 * ====================
 *
 * Why this exists
 * ---------------
 * Every offline measurement of this player reports a clean main thread: a
 * 2.87 GB MKV shows 0 ms worst block, seeks landing in 1-16 ms, `load()`=0,
 * `src`=0, heap flat at 10 MB, zero renderer exceptions -- even under a
 * 121-move drag and a 25-click seek storm. Yet real users still see stutter.
 *
 * A harness can only report what it is able to provoke, and it cannot watch
 * the machine during the ten minutes where the problem actually happens. So
 * instead of guessing again, this records what the running player is doing and
 * freezes an evidence bundle at the exact moment the UI stalls.
 *
 * WHAT IS CAPTURED
 * -----------------
 *   frame gap      : rAF delta. The direct signal for "the window froze".
 *   long tasks     : PerformanceObserver, attributed to a cause where possible.
 *   dropped frames : the element's OWN decode/drop counters. This separates
 *                    "CPU could not keep up" from "main thread was blocked".
 *   playback ticks : requestVideoFrameCallback gives presented frames and the
 *                    media clock, so a stall is attributable to a real frame
 *                    that failed to appear rather than to a missed timer.
 *   pipeline state : readyState, networkState, error, buffered coverage, src,
 *                    element identity, seek/stall counters.
 *
 * An INCIDENT is frozen when the frame gap exceeds `STALL_MS`, keeping the
 * preceding `PRE_WINDOW_MS` of samples so the run-up to the freeze is visible.
 * Incidents are capped so a long bad session cannot grow without bound.
 *
 * This module is diagnostic only: it never writes `currentTime`, never calls
 * `load()`, never changes `src`, and adds no listener that mutates playback.
 */

/** A frame gap above this is treated as a user-visible stall. */
const STALL_MS = 400;
/**
 * Sampling cadence.
 *
 * Deliberately a timer, NOT requestAnimationFrame: a second rAF loop is a
 * competing playback loop, which the seek spec forbids outright (and it does
 * cost real frame time on every single frame). It is also strictly worse for
 * this job — rAF is throttled to a crawl when the window is occluded or
 * backgrounded, so exactly the moments a user would report as "it froze" would
 * be the ones with no data. A timer keeps sampling regardless, and how late it
 * runs is a direct measure of how long the main thread was blocked.
 */
const SAMPLE_MS = 100;
/** Samples retained before a stall so the run-up to it can be inspected. */
const PRE_WINDOW_MS = 5000;
/** Hard cap on retained samples and incidents. */
const MAX_SAMPLES = 6000;
const MAX_INCIDENTS = 40;

/** `performance.memory` is Chromium-only and absent from the DOM lib types. */
function heapMB(): number {
  const p = performance as Performance & { memory?: { usedJSHeapSize: number } };
  return p.memory ? Math.round(p.memory.usedJSHeapSize / 1048576) : -1;
}

/** One sampled frame. */
export interface LagSample {
  /** ms since the recorder started. */
  t: number;
  /** file/media clock in seconds. */
  media: number;
  /** rAF delta since the previous sample, in ms. */
  gap: number;
  readyState: number;
  networkState: number;
  paused: boolean;
  seeking: boolean;
  /** Seconds of contiguous buffer ahead of the playhead, or -1 when unknown. */
  ahead: number;
  droppedFrames: number;
  totalFrames: number;
  /** True while the engine reports a fallback (ffmpeg -> MSE) rebuild. */
  tier2: boolean;
}

export interface LagIncident {
  id: number;
  /** ms since recorder start at the moment of the stall. */
  t: number;
  /** Worst gap that triggered this incident, in ms. */
  gapMs: number;
  mediaTime: number;
  readyState: number;
  bufferedAhead: number;
  droppedFrames: number;
  totalFrames: number;
  heapMB: number;
  /** 'main' when the frame loop stalled, 'decode' when frames were dropped. */
  kind: 'main' | 'decode' | 'both';
  longTaskMs: number;
  /** The samples leading up to the stall. */
  pre: LagSample[];
  /** Anything the renderer logged as an error around this time. */
  errors: string[];
}

/**
 * How long the PICTURE stayed frozen after a seek.
 *
 * `el.currentTime` jumps the instant it is assigned, so the clock (and the
 * timeline) can be at the new position while the last decoded frame is still on
 * screen — which is exactly the "the video freezes for a second after I click"
 * report. Neither readyState nor a frame-callback COUNT can see it: an element
 * that is starved keeps re-presenting its last frame, so callbacks keep firing
 * while nothing changes.
 *
 * What actually measures it is a frame callback whose `mediaTime` MOVED. So:
 *
 *   thawMs   = seeking -> first presented frame at a new media time
 *              (what the user experiences as the stall)
 *   readyMs  = seeking -> 'seeked'  (Chromium's own readiness)
 *   presentMs= 'seeked' -> that first frame (decoder + compositor lag)
 *
 * Splitting the two separates "the element took 400 ms to become ready" from
 * "it was ready but the picture took another 200 ms to appear" — which are
 * different problems with different fixes.
 */
export interface SeekThaw {
  /** Position the playhead was asked to go to. */
  target: number;
  /** Where the picture actually resumed. */
  landedAt: number;
  thawMs: number | null;
  readyMs: number | null;
  presentMs: number | null;
  /**
   * True when the new picture was already on screen BEFORE Chromium reported
   * 'seeked'. That is a legitimate and better outcome — the element can present
   * the first frame of the new position and only then announce readiness — and
   * it means ready/present are meaningless for this seek, so they stay null.
   */
  beforeReady: boolean;
}

export interface LagReport {
  version: number;
  /** Wall-clock time the recording started, for correlating with a session. */
  startedAt: string;
  userAgent: string;
  /** Present when the app is running against a real file. */
  src: string;
  durationSec: number;
  sampleCount: number;
  stallCount: number;
  worstGapMs: number;
  worstLongTaskMs: number;
  droppedFrames: number;
  totalFrames: number;
  /** Every stall longer than STALL_MS, oldest first. */
  incidents: LagIncident[];
  /** Last measured seek-thaw, if a seek has happened since the last reset. */
  lastSeek: SeekThaw | null;
}

/** A frame whose mediaTime has not moved is the same picture again. */
const THAW_EPSILON_S = 0.05;

interface Probe {
  currentTime(): number;
  knownDuration(): number;
  isFallbackBusy(): boolean;
}

export class LagRecorder {
  private el: HTMLVideoElement | null = null;
  private probe: Probe | null = null;
  private raf = 0;
  private lastT = 0;
  private timer = 0;
  private startedAt = 0;
  private samples: LagSample[] = [];
  private incidentList: LagIncident[] = [];
  private nextId = 1;
  private worstGap = 0;
  private worstLongTask = 0;
  private errors: string[] = [];
  private observer: PerformanceObserver | null = null;
  private onError = (e: ErrorEvent) => {
    this.errors.push(`${new Date().toISOString()} ${e.message}`);
    if (this.errors.length > 50) this.errors.shift();
  };
  private active = false;
  // ---- seek-thaw tracking --------------------------------------------------
  private frameAt = 0;
  private frameAtAt = 0;
  private seekStartAt = 0;
  private seekTarget = 0;
  private seekedAt = 0;
  private thawPending = false;
  private lastThaw: SeekThaw | null = null;
  private hasRvfc = false;
  private rvfcTimer = 0;
  private lastFrameAt = 0;
  private onSeeking = () => {
    const el = this.el;
    if (!el) return;
    // The media time of the picture currently on screen is the "before". The
    // first callback whose mediaTime differs from it is the thaw.
    this.pendingFrom = this.frameAtAt > 0 ? this.frameAt : el.currentTime;
    this.seekStartAt = performance.now();
    this.seekTarget = el.currentTime;
    this.seekedAt = 0;
    this.thawPending = true;
  };
  private onSeeked = () => {
    if (!this.thawPending) return;
    this.seekedAt = performance.now();
  };
  private onFrame = (now: number, meta: VideoFrameCallbackMetadata) => {
    this.lastFrameAt = performance.now();
    this.frameAt = meta.mediaTime;
    this.frameAtAt = now;
    // A starved element keeps re-presenting the SAME frame, so callbacks firing
    // is not progress — only a moved mediaTime is.
    if (this.thawPending && Math.abs(meta.mediaTime - this.pendingFrom) >= THAW_EPSILON_S) {
      this.resolveThaw(now, meta.mediaTime);
    }
    const el = this.el;
    if (el && this.hasRvfc) {
      try {
        el.requestVideoFrameCallback(this.onFrame);
      } catch {
        /* re-armed by the watchdog below */
      }
    }
  };
  private pendingFrom = 0;
  private resolveThaw(now: number, landedAt: number): void {
    this.thawPending = false;
    const thawMs = now - this.seekStartAt;
    const readyMs = this.seekedAt ? this.seekedAt - this.seekStartAt : null;
    this.lastThaw = {
      target: +this.seekTarget.toFixed(2),
      landedAt: +landedAt.toFixed(2),
      thawMs: Math.round(thawMs),
      readyMs: readyMs === null ? null : Math.round(readyMs),
      presentMs: this.seekedAt ? Math.round(now - this.seekedAt) : null,
      beforeReady: readyMs === null,
    };
  }

  /**
   * Attach to the live media element. Safe to call repeatedly: the previous
   * element is detached first, so a file change never leaves two recorders
   * running or double-count frames.
   */
  attach(el: HTMLVideoElement | null, probe: Probe | null): void {
    if (this.el === el && this.active) return;
    this.detach();
    this.el = el;
    this.probe = probe;
    if (!el) return;
    this.active = true;
    this.startedAt = performance.now();
    this.lastT = this.startedAt;
    this.samples = [];
    this.incidentList = [];
    this.nextId = 1;
    this.worstGap = 0;
    this.worstLongTask = 0;
    this.errors = [];

    window.addEventListener('error', this.onError);

    // ---- seek-thaw instrumentation ----------------------------------------
    el.addEventListener('seeking', this.onSeeking);
    el.addEventListener('seeked', this.onSeeked);
    this.hasRvfc = typeof el.requestVideoFrameCallback === 'function';
    this.frameAt = el.currentTime;
    this.frameAtAt = performance.now();
    this.lastFrameAt = performance.now();
    this.pendingFrom = el.currentTime;
    if (this.hasRvfc) {
      try {
        el.requestVideoFrameCallback(this.onFrame);
      } catch {
        this.hasRvfc = false;
      }
      // A frame callback STOPS FIRING while the element presents nothing, which
      // is exactly the state being measured, so a chain armed only once goes
      // permanently silent after the first freeze. Re-arm a chain that has gone
      // STALE — never unconditionally, or every tick would spawn another chain
      // and the callback rate would multiply without bound.
      this.rvfcTimer = window.setInterval(() => {
        const v = this.el;
        if (!v || !this.hasRvfc) return;
        if (performance.now() - this.lastFrameAt > 400) {
          try {
            v.requestVideoFrameCallback(this.onFrame);
            this.lastFrameAt = performance.now();
          } catch {
            /* one is already pending */
          }
        }
      }, 200);
    }

    try {
      this.observer = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (e.duration > this.worstLongTask) this.worstLongTask = e.duration;
        }
      });
      this.observer.observe({ entryTypes: ['longtask'] });
    } catch {
      this.observer = null;
    }

    const tick = () => {
      if (!this.active || !this.el) return;
      this.sample();
    };
    this.timer = window.setInterval(tick, SAMPLE_MS);
  }

  private bufferedAhead(): number {
    const el = this.el;
    if (!el || !el.buffered || el.buffered.length === 0) return -1;
    const now = el.currentTime;
    for (let i = 0; i < el.buffered.length; i++) {
      if (el.buffered.start(i) <= now + 0.25 && el.buffered.end(i) >= now) {
        return +(el.buffered.end(i) - now).toFixed(2);
      }
    }
    return -1;
  }

  private sample(): void {
    const el = this.el;
    if (!el) return;
    const now = performance.now();
    const gap = now - this.lastT;
    this.lastT = now;
    if (gap > this.worstGap) this.worstGap = gap;

    let dropped = 0;
    let total = 0;
    const q = el.getVideoPlaybackQuality?.();
    if (q) {
      dropped = q.droppedVideoFrames;
      total = q.totalVideoFrames;
    }

    const s: LagSample = {
      t: Math.round(now - this.startedAt),
      media: +el.currentTime.toFixed(3),
      gap: Math.round(gap),
      readyState: el.readyState,
      networkState: el.networkState,
      paused: el.paused,
      seeking: el.seeking,
      ahead: this.bufferedAhead(),
      droppedFrames: dropped,
      totalFrames: total,
      tier2: this.probe ? this.probe.isFallbackBusy() : false,
    };

    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    if (gap >= STALL_MS) this.recordIncident(s, Math.round(gap));
  }

  private recordIncident(s: LagSample, gapMs: number): void {
    if (this.incidentList.length >= MAX_INCIDENTS) return;
    const keep = this.samples.filter((x) => s.t - x.t <= PRE_WINDOW_MS).slice(-120);
    // A drop-dominated stall is a decode/throughput problem; a stall with the
    // decoder keeping up is a main-thread problem. Reporting both matters
    // because the two have completely different fixes.
    const droppedDelta = keep.length >= 2 ? s.droppedFrames - keep[0].droppedFrames : 0;
    const kind: LagIncident['kind'] =
      droppedDelta > 3 && gapMs > STALL_MS * 2 ? 'both' : droppedDelta > 3 ? 'decode' : 'main';
    this.incidentList.push({
      id: this.nextId++,
      t: s.t,
      gapMs,
      mediaTime: s.media,
      readyState: s.readyState,
      bufferedAhead: s.ahead,
      droppedFrames: s.droppedFrames,
      totalFrames: s.totalFrames,
      heapMB: heapMB(),
      kind,
      longTaskMs: Math.round(this.worstLongTask),
      pre: keep,
      errors: this.errors.slice(-5),
    });
  }

  detach(): void {
    this.active = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.rvfcTimer) window.clearInterval(this.rvfcTimer);
    this.rvfcTimer = 0;
    if (this.el) {
      this.el.removeEventListener('seeking', this.onSeeking);
      this.el.removeEventListener('seeked', this.onSeeked);
    }
    this.hasRvfc = false;
    this.thawPending = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    if (this.observer) {
      try {
        this.observer.disconnect();
      } catch {
        /* already gone */
      }
      this.observer = null;
    }
    window.removeEventListener('error', this.onError);
    this.el = null;
  }

  /** Live snapshot for the on-screen panel. */
  live(): {
    samples: number;
    stalls: number;
    worstGapMs: number;
    worstLongTaskMs: number;
    droppedFrames: number;
    totalFrames: number;
    gapMs: number;
    readyState: number;
    paused: boolean;
    seeking: boolean;
    ahead: number;
    heapMB: number;
    tier2: boolean;
    recording: boolean;
    lastSeek: SeekThaw | null;
  } {
    const el = this.el;
    const last = this.samples[this.samples.length - 1];
    const q = el?.getVideoPlaybackQuality?.();
    return {
      samples: this.samples.length,
      stalls: this.incidentList.length,
      worstGapMs: Math.round(this.worstGap),
      worstLongTaskMs: Math.round(this.worstLongTask),
      droppedFrames: q ? q.droppedVideoFrames : 0,
      totalFrames: q ? q.totalVideoFrames : 0,
      gapMs: last ? last.gap : 0,
      readyState: el ? el.readyState : -1,
      paused: el ? el.paused : false,
      seeking: el ? el.seeking : false,
      ahead: this.bufferedAhead(),
      heapMB: heapMB(),
      tier2: this.probe ? this.probe.isFallbackBusy() : false,
      recording: this.active,
      lastSeek: this.lastThaw,
    };
  }

  /** The most recent measured seek-thaw, or null before the first seek. */
  lastSeek(): SeekThaw | null {
    return this.lastThaw;
  }

  incidents(): LagIncident[] {
    return this.incidentList;
  }

  /** Full evidence bundle, suitable for saving or pasting into a bug report. */
  report(): LagReport {
    const el = this.el;
    let durationSec = 0;
    if (el && isFinite(el.duration)) durationSec = el.duration;
    else if (this.probe) durationSec = this.probe.knownDuration();
    return {
      version: 1,
      startedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      src: el ? (el.currentSrc || el.src || '') : '',
      durationSec: +durationSec.toFixed(1),
      sampleCount: this.samples.length,
      stallCount: this.incidentList.length,
      worstGapMs: Math.round(this.worstGap),
      worstLongTaskMs: Math.round(this.worstLongTask),
      droppedFrames: el?.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      totalFrames: el?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
      incidents: this.incidentList,
      lastSeek: this.lastThaw,
    };
  }

  reset(): void {
    this.samples = [];
    this.incidentList = [];
    this.nextId = 1;
    this.worstGap = 0;
    this.worstLongTask = 0;
    this.errors = [];
    this.lastThaw = null;
    this.thawPending = false;
    this.startedAt = performance.now();
    this.lastT = this.startedAt;
  }
}

/** Process-wide recorder, attached once and never torn down per file. */
export const lagRecorder = new LagRecorder();

/** Probe reading the live engine, kept here so views need no engine import. */
export function readProbe(services: unknown): Probe | null {
  const e = (services as { engine?: Probe } | null)?.engine;
  if (!e) return null;
  return e;
}