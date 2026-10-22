import React, { useCallback, useRef, useState } from 'react';

interface Props {
  /** Current volume, 0..1 (mirrors the video element via App state). */
  volume: number;
  muted: boolean;
  /** Set an exact volume (drag / keyboard / programmatic). */
  onSetVolume: (v: number) => void;
  /** Step the volume by a delta, clamped by the caller (mouse wheel). */
  onVolumeStep: (delta: number) => void;
}

/**
 * Pointer-driven volume control.
 *
 * A native <input type="range"> cannot be dragged smoothly with the mouse
 * everywhere and has no wheel support, so — like the seek Timeline — this
 * maps the exact pointer X-coordinate to a volume fraction and applies it
 * immediately, with pointer capture so the drag continues outside the bar.
 * The wheel gesture is handled by the surrounding .volume-zone (native
 * non-passive listener) so it also works over the mute button and never
 * reaches any other control.
 */
export default function VolumeSlider({ volume, muted, onSetVolume, onVolumeStep }: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  // Local mirror while dragging: applies instantly on every pointer move
  // without waiting for the volumechange → App state round-trip.
  const [dragVol, setDragVol] = useState<number | null>(null);

  const volumeAt = useCallback((clientX: number): number | null => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const v = volumeAt(e.clientX);
    if (v === null) return;
    e.preventDefault();
    // Capture the pointer: the drag continues outside the bar. (Guarded —
    // capture can fail for synthetic pointers; the click still applies.)
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* non-critical */ }
    draggingRef.current = true;
    setDragging(true);
    setDragVol(v);
    onSetVolume(v);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const v = volumeAt(e.clientX);
    if (v === null) return;
    setDragVol(v);
    onSetVolume(v);
  };

  const finishDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    setDragVol(null);
    const v = volumeAt(e.clientX);
    if (v !== null) onSetVolume(v);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let v: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = Math.min(1, volume + 0.05);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = Math.max(0, volume - 0.05);
    else if (e.key === 'Home') v = 0;
    else if (e.key === 'End') v = 1;
    if (v === null) return;
    e.preventDefault();
    // Keep the app-level arrow-key handler from ALSO stepping the volume.
    e.stopPropagation();
    onSetVolume(v);
  };

  const shown = dragging && dragVol !== null ? dragVol : volume;
  const clamped = Math.min(1, Math.max(0, shown));
  const pct = clamped * 100;
  const silent = muted || clamped <= 0.001;

  return (
    <div
      ref={trackRef}
      className={`volume-slider ${dragging ? 'dragging' : ''}`}
      role="slider"
      aria-label="Volume"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-valuetext={silent ? 'Muted' : `${Math.round(pct)}%`}
      tabIndex={0}
      title="Volume — drag the knob or scroll the mouse wheel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={onKeyDown}
    >
      <div className="volume-slider-track">
        <div className="volume-slider-fill" style={{ width: `${pct}%` }} />
        <div className="volume-slider-thumb" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}
