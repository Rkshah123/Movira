import React, { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  /** Current playback position in seconds (media time). */
  time: number;
  /** Media duration in seconds (0/NaN while unknown). */
  duration: number;
  /** Buffered-ahead position in seconds. */
  buffered: number;
  /** Commit a seek immediately (single click, keyboard step). */
  onSeek: (t: number) => void;
  /** Live position update while the user drags (coalesced to one per frame). */
  onScrub: (t: number) => void;
  /** Final exact position when the drag ends. */
  onScrubEnd: (t: number) => void;
}

/**
 * A CLICK IS NOT A DRAG.
 *
 * A human click is never perfectly still: while the button is down the hand
 * drifts a pixel or two, and one pixel of a 2h18m timeline is 7.4 SECONDS.
 * Treating that drift as a drag made a SINGLE click run THREE seeks — the
 * pointerdown commit, a live scrub preview, and the release commit — so one
 * click landed well past the position that was clicked. A gesture only becomes
 * a drag once the pointer has genuinely travelled, in both space and time:
 * far enough to be deliberate, and long enough to not be click shake.
 */
const DRAG_MIN_PX = 3;
/** A jump this large is a drag whatever the elapsed time — applying the settle
 *  delay to it would only put a dead zone in front of every fast flick. */
const DRAG_FAR_PX = 25;
const DRAG_MIN_MS = 100;

/**
 * Pointer-driven seek timeline.
 *
 * A native <input type="range"> cannot seek to an arbitrary clicked position:
 * clicking steps relative to the CURRENT value (one step per click), which is
 * why single clicks landed offset and double-clicks sometimes looked correct.
 * This component converts the exact pointer X-coordinate into the corresponding
 * timestamp and commits it immediately — no stepping, no double-click needed.
 *
 * Dragging coalesces live updates to one seek per animation frame (the last
 * target always wins) so scrubbing stays smooth even on large files where each
 * seek is expensive.
 */
export default function Timeline({ time, duration, buffered, onSeek, onScrub, onScrubEnd }: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragValue, setDragValue] = useState(0);
  // Latest scrub target + its scheduled frame — intermediate pointer positions
  // between two frames are dropped instead of queued (last-wins coalescing).
  const pendingTime = useRef<number | null>(null);
  const pendingRaf = useRef<number | null>(null);
  // Whether the pointer actually moved after pointerdown. A drag must ALWAYS
  // commit its final position on release: on the ffmpeg tier the drag itself is
  // preview-only (scrubThrough never restarts the decoder mid-gesture), so
  // skipping the commit because "the last previewed value was the same" left the
  // playhead wherever the pointerdown seek had put it — dragging to an
  // unbuffered position looked completely dead.
  const movedRef = useRef(false);
  // Where/when the button went down. The gesture only counts as a drag once the
  // pointer has left this spot by DRAG_MIN_PX for longer than DRAG_MIN_MS.
  const downAtRef = useRef(0);
  const downXRef = useRef(0);
  const downYRef = useRef(0);

  useEffect(
    () => () => {
      if (pendingRaf.current !== null) cancelAnimationFrame(pendingRaf.current);
    },
    []
  );

  /** Exact timestamp under a pointer X position, clamped to [0, duration].
   *  A non-finite duration means "duration not known yet" and the gesture is
   *  IGNORED — which used to make the whole timeline look dead for the first
   *  moments after opening a file, because an MSE source reports Infinity until
   *  the muxer declares one. App now feeds a duration that is never Infinity
   *  (engine.knownDuration(), probe fallback). */
  const timeAt = useCallback(
    (clientX: number): number | null => {
      const rect = trackRef.current?.getBoundingClientRect();
      const total = isFinite(duration) && duration > 0 ? duration : 0;
      if (!rect || rect.width <= 0 || total <= 0) return null;
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return frac * total;
    },
    [duration]
  );

  const flushScrub = useCallback(() => {
    pendingRaf.current = null;
    if (pendingTime.current === null) return;
    const t = pendingTime.current;
    pendingTime.current = null;
    // One render per frame at most: the visual follows the pointer, and the
    // engine is told once per frame (and then rate-limited again in the engine).
    setDragValue(t);
    onScrub(t);
  }, [onScrub]);

  const scheduleScrub = useCallback(
    (t: number) => {
      pendingTime.current = t;
      if (pendingRaf.current === null) {
        pendingRaf.current = requestAnimationFrame(flushScrub);
      }
    },
    [flushScrub]
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = timeAt(e.clientX);
    if (t === null) return;
    e.preventDefault();
    // Capture the pointer: drags continue outside the bar and still commit.
    // (Guarded — capture can fail for unusual/synthetic pointers; seeking still
    // works, only out-of-bounds dragging is affected.)
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* non-critical */ }
    setDragging(true);
    setDragValue(t);
    movedRef.current = false;
    downAtRef.current = performance.now();
    downXRef.current = e.clientX;
    downYRef.current = e.clientY;
    onSeek(t); // single click = immediate, exact seek at the clicked position
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const t = timeAt(e.clientX);
    if (t === null) return;
    if (!movedRef.current) {
      // Still a click until the pointer has really travelled. Ignoring the
      // sub-threshold wander here is what keeps ONE click to ONE seek.
      const far = Math.max(
        Math.abs(e.clientX - downXRef.current),
        Math.abs(e.clientY - downYRef.current),
      );
      if (far < DRAG_MIN_PX) return;
      // A small move only becomes a drag once the press has settled; a large
      // one is unambiguous immediately.
      if (far < DRAG_FAR_PX && performance.now() - downAtRef.current < DRAG_MIN_MS) return;
      movedRef.current = true;
    }
    // Do NOT setDragValue here. A high-poll-rate mouse emits hundreds of moves
    // per second, and every direct setState is a full React render of the
    // player — that is the expensive work during pointer movement. The rAF
    // below collapses a burst into one render + one engine call per frame.
    scheduleScrub(t);
  };

  const finishDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const t = timeAt(e.clientX) ?? dragValue;
    const moved = movedRef.current;
    movedRef.current = false;
    setDragging(false);
    if (pendingRaf.current !== null) {
      cancelAnimationFrame(pendingRaf.current);
      pendingRaf.current = null;
    }
    pendingTime.current = null;
    // A plain click (no deliberate movement) already seeked on pointerdown, so
    // the duplicate commit is pointless — and running it is what turned one
    // click into two seeks. A real drag always commits its final exact
    // position — that commit is the ONLY thing that moves the playhead on the
    // preview-only ffmpeg tier.
    if (moved) onScrubEnd(t);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isFinite(duration) || duration <= 0) return;
    let t: number | null = null;
    const step = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowRight') t = Math.min(duration - 0.25, value + step);
    else if (e.key === 'ArrowLeft') t = Math.max(0, value - step);
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = Math.max(0, duration - 0.25);
    if (t === null) return;
    e.preventDefault();
    onSeek(t);
  };

  const value = dragging ? dragValue : Math.min(time, duration || 0);
  const pct = isFinite(duration) && duration > 0 ? Math.min(100, Math.max(0, (value / duration) * 100)) : 0;
  const bufPct = isFinite(duration) && duration > 0 ? Math.min(100, Math.max(0, (buffered / duration) * 100)) : 0;

  return (
    <div
      ref={trackRef}
      className={`timeline ${dragging ? 'dragging' : ''}`}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.max(duration, 0.1)}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={onKeyDown}
    >
      <div className="timeline-track">
        <div className="timeline-buffered" style={{ width: `${bufPct}%` }} />
        <div className="timeline-played" style={{ width: `${pct}%` }} />
        <div className="timeline-thumb" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}
