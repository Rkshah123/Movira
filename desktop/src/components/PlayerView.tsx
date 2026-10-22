import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaItem, QueueState, SubtitleTrack } from '@shared';
import { formatTime, baseName } from '@shared';
import { moviraApi } from '../api';
import type { DesktopServices } from '../services';
import QueuePanel from './QueuePanel';
import SubtitlePanel from './SubtitlePanel';
import Timeline from './Timeline';
import VolumeSlider from './VolumeSlider';

/** Skip step for the transport skip buttons. A plain currentTime write on the
 *  element that is already playing - the engine clamps it to the real
 *  duration, so a skip past either end simply lands on the end. */
const SKIP_SEC = 10;

interface Props {
  services: DesktopServices;
  current: MediaItem | null;
  playing: boolean;
  progress: { time: number; duration: number; buffered?: number };
  queue: QueueState;
  subtitle: SubtitleTrack | null;
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  /** VLC-style video zoom (key C): 0 fit, 1 fill, 2 stretch. */
  zoomMode: number;
  videoHostRef: React.RefObject<HTMLDivElement | null>;
  onPlayItems: (items: MediaItem[], start?: number) => void;
  onNext: () => void;
  onPrev: () => void;
  /** VLC-style skip: move the playhead by +/- seconds on the EXISTING element
   *  (one currentTime write). Never a reload, never a new pipeline. */
  onSeekBy: (deltaSec: number) => void;
  onTogglePlay: () => void;
  onQueueChange: () => void;
  onSubtitle: (t: SubtitleTrack | null) => void;
  onToggleFullscreen: () => void;
  onVolumeChange: (delta: number) => void;
  onSetVolume: (v: number) => void;
  onToggleMute: () => void;
  /** Close Now Playing and return to the Movira home screen. */
  onClose: () => void;
  /**
   * Startup screen is up: the bare logo is the ENTIRE view, so nothing else
   * may print behind it. This covers BOTH cases — with no media the
   * "Nothing playing" placeholder would show, and with media loaded the whole
   * transport (title, artist, timeline, controls) would otherwise render
   * underneath the logo. Playback itself keeps running; only the UI is hidden.
   */
  startupMode?: boolean;
}

export default function PlayerView({
  services, current, playing, progress, queue, subtitle,
  volume, muted, fullscreen, zoomMode, videoHostRef,
  onNext, onPrev, onSeekBy, onTogglePlay, onQueueChange, onSubtitle,
  onToggleFullscreen, onVolumeChange, onSetVolume, onToggleMute, onClose, startupMode,
}: Props) {
  const [rate, setRate] = useState(1);
  const [showQueue, setShowQueue] = useState(true);
  const [showSubs, setShowSubs] = useState(false);
  const [audioTracks, setAudioTracks] = useState<{ index: number; language: string | null }[]>([]);
  // VLC-style auto-hide: in fullscreen the transport (and title bar) fade away after
  // a short idle period, reappear on any mouse move, stay while the cursor hovers
  // them or while paused, and never interfere with keyboard shortcuts.
  const [controlsVisible, setControlsVisible] = useState(true);
  // While the user scrubs the timeline, the label/thumb show the TARGET position
  // until the engine's seek lands (progress.time comes within range) — otherwise
  // the thumb would visibly snap back to the stale position mid-seek. See the
  // settle effect below and Timeline's internal settle handling.
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while the cursor rests over the transport/panels — controls must stay
  // visible even when the mouse is perfectly still (no mousemove events fire).
  const hoveringControls = useRef(false);

  useEffect(() => {
    const prefs = services.userData.getSettings();
    setRate(prefs.defaultSpeed);
  }, [services]);

  // Mouse wheel over the PLAYER controls the volume, as in VLC.
  //
  // ONE listener, bound to the player root through a callback ref. It covers
  // the video area AND the transport (mute button and slider included) with a
  // single handler, so a gesture over the slider cannot be counted twice, and
  // it is attached exactly once when the node appears rather than on every
  // media load or prop change.
  //
  // A callback ref, not an effect keyed on props: the transport is only
  // rendered once media is loaded, so an effect that ran on mount found no
  // node and never re-ran — the wheel then silently did nothing for the rest
  // of the session.
  const volumeStepRef = useRef(onVolumeChange);
  volumeStepRef.current = onVolumeChange;

  // VLC-style volume OSD. A wheel gesture that lands on the 0% / 100% clamp
  // changes nothing, which is exactly how "the wheel does nothing" happens:
  // the app silently swallows a real gesture. The OSD is written straight to
  // the DOM (no React state, so no re-render per notch) and shows for every
  // gesture, clamped or not, so the wheel is always visibly acknowledged.
  const osdRef = useRef<HTMLDivElement | null>(null);
  const osdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashVolume = useCallback(() => {
    const node = osdRef.current;
    if (!node) return;
    const el = services.engine.el();
    const v = el ? el.volume : 0;
    const m = el ? el.muted : false;
    const shown = m ? 0 : v;
    const glyph = shown <= 0.001 ? '\u{1F507}' : shown < 0.34 ? '\u{1F508}' : shown < 0.67 ? '\u{1F509}' : '\u{1F50A}';
    node.textContent = `${glyph} ${Math.round(shown * 100)}%`;
    node.classList.add('show');
    if (osdTimer.current) clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => {
      osdTimer.current = null;
      node.classList.remove('show');
    }, 900);
  }, [services]);
  const flashRef = useRef(flashVolume);
  flashRef.current = flashVolume;
  useEffect(
    () => () => {
      if (osdTimer.current) clearTimeout(osdTimer.current);
    },
    []
  );
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const attachPlayerWheel = useCallback((node: HTMLDivElement | null) => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    if (!node) return;
    // Panels that scroll keep their own wheel behaviour; the gesture is only
    // taken over over the video and the transport.
    const SCROLLABLE = '.floating-panel, .queue-panel, .subtitle-panel, .settings-view';
    const onWheel = (e: WheelEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.(SCROLLABLE)) return;
      // A native non-passive listener is required — React's synthetic wheel
      // event is passive and cannot preventDefault. Owning the gesture stops
      // the page scrolling under the cursor and guarantees it can never reach
      // the seek timeline.
      e.preventDefault();
      e.stopPropagation();
      const raw = e.deltaY || e.deltaX;
      if (!raw) return;
      // Only the sign is used, so one wheel event is always exactly one 5%
      // step whatever the device's deltaMode (pixel / line / page) reports.
      volumeStepRef.current(raw < 0 ? 0.05 : -0.05);
      flashRef.current();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    wheelCleanupRef.current = () => node.removeEventListener('wheel', onWheel);
  }, []);
  useEffect(
    () => () => {
      wheelCleanupRef.current?.();
      wheelCleanupRef.current = null;
    },
    []
  );

  // Stable close callbacks: QueuePanel/SubtitlePanel are memoized, and fresh
  // inline closures here would defeat the memo on every progress tick.
  const closeQueue = useCallback(() => setShowQueue(false), []);
  const closeSubs = useCallback(() => setShowSubs(false), []);

  // Clear any pending hide timer on unmount (no stray timers).
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    []
  );

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  // Mirror the hover flag so the timer callback (scheduled earlier) always reads
  // the latest value — between scheduling and firing, the cursor may have moved
  // over the transport, and hiding then would strand it (stuck-controls bug).
  const hoveringRef = useRef(false);
  hoveringRef.current = hoveringControls.current;

  const scheduleHide = useCallback(() => {
    // Never hide while the cursor is over the control bar itself.
    if (hoveringRef.current) return;
    clearHideTimer();
    hideTimer.current = setTimeout(() => {
      if (!hoveringRef.current) setControlsVisible(false);
    }, 3000);
  }, [clearHideTimer]);

  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  // Clear the preview once the engine's position catches up to it (seek landed)
  // so live progress tracking resumes seamlessly after clicks and scrubs.
  useEffect(() => {
    if (seekPreview === null) return;
    if (Math.abs(progress.time - seekPreview) < 0.75) setSeekPreview(null);
  }, [progress.time, seekPreview]);
  // Safety net for a seek that never lands: without this a failed/ignored seek
  // would pin the cursor to a position the engine is not at, forever. The timer
  // is re-armed every time the preview changes, so a long drag keeps its preview
  // and only the FINAL target gets the 6 s grace.
  useEffect(() => {
    if (seekPreview === null) return;
    const t = setTimeout(() => setSeekPreview(null), 6000);
    return () => clearTimeout(t);
  }, [seekPreview]);
  // Stop resets playback to 0: drop any pending seek preview so the timeline
  // shows the REAL engine position immediately (no thumb/label desync while
  // the next playback starts).
  useEffect(() => {
    if (seekPreview !== null && progress.time === 0 && progress.duration === 0) {
      setSeekPreview(null);
    }
  }, [progress.time, progress.duration, seekPreview]);

  // ONE mousemove listener for the whole component.
  //
  // There used to be two — a window-level one that re-showed the controls in
  // fullscreen and a document-level one that held them while the cursor rested
  // over the transport — so every mouse move in fullscreen ran both handlers
  // and each effect re-bound its own listener whenever `playing` or
  // `fullscreen` changed. Hovering the transport, the queue panel or the
  // subtitle panel holds the controls indefinitely (mousemove, not
  // mouseover/mouseenter, so the flag re-evaluates after DOM changes too);
  // any other movement in fullscreen reveals the controls and restarts the
  // idle timer.
  useEffect(() => {
    if (!fullscreen) {
      clearHideTimer();
      setControlsVisible(true);
      hoveringControls.current = false;
      return;
    }
    const HOLD_SELECTOR = '.transport, .queue-panel, .subtitle-panel';
    const onMove = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const over = !!target?.closest?.(HOLD_SELECTOR);
      const changed = over !== hoveringControls.current;
      hoveringControls.current = over;
      if (over) {
        // Never hide while the cursor is over the control bar itself.
        setControlsVisible(true);
        clearHideTimer();
        return;
      }
      pokeControls();
      // Leaving the controls re-arms the idle fade (unless we are paused).
      if (changed && !playing) clearHideTimer();
    };
    document.addEventListener('mousemove', onMove);
    // Entering fullscreen always starts with the full control bar visible.
    pokeControls();
    return () => {
      document.removeEventListener('mousemove', onMove);
      clearHideTimer();
    };
  }, [fullscreen, playing, pokeControls, clearHideTimer]);

  // Key V with no sidecar subtitle: open the subtitle panel (dispatched by
  // App's toggleSubtitlesV when nothing can be loaded directly).
  useEffect(() => {
    const open = () => setShowSubs(true);
    window.addEventListener('movira:open-subtitles', open);
    return () => window.removeEventListener('movira:open-subtitles', open);
  }, []);

  // The file's REAL audio tracks (probe cache — free after the first probe).
  // Bounded to 2 tracks: the state only drives the on-screen list, and the B
  // key is the primary control.
  useEffect(() => {
    let cancelled = false;
    void services.engine.getTracks().then(({ audio }) => {
      if (!cancelled) setAudioTracks(audio.slice(0, 2));
    });
    return () => { cancelled = true; };
  }, [services, current?.id]);

  const [activeAudio, setActiveAudio] = useState(0);
  const pickAudioTrack = useCallback(
    async (index: number) => {
      await services.engine.setAudioTrack(index);
      setActiveAudio(index);
    },
    [services]
  );
  const cycleAudio = useCallback(async () => {
    const label = await services.engine.cycleAudioTrack();
    if (label) setActiveAudio(services.engine.audioTrackIndex());
  }, [services]);

  const onDblClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onToggleFullscreen();
    },
    [onToggleFullscreen]
  );

  const changeRate = useCallback(
    (r: number) => {
      setRate(r);
      void services.engine.setRate(r);
      void services.userData.updateSettings({ defaultSpeed: r });
    },
    [services]
  );

  const changeVolume = useCallback(
    (v: number) => {
      onSetVolume(v);
      flashVolume();
    },
    [onSetVolume, flashVolume]
  );

  const toggleMute = useCallback(() => {
    onToggleMute();
    flashVolume();
  }, [onToggleMute, flashVolume]);

  const pip = useCallback(async () => {
    const ok = await services.engine.setPip(true);
    if (!ok) {
      setShowQueue(false);
    }
  }, [services]);

  const loadLocalSub = useCallback(async () => {
    const p = await moviraApi.openSubtitleFile();
    if (!p) return;
    try {
      const content = await moviraApi.readSubtitle(p);
      const track = services.subtitles.loadLocal(baseName(p), content);
      onSubtitle(track);
    } catch {
      onSubtitle(null);
    }
  }, [services, onSubtitle]);

  const searchOnlineSubs = useCallback(async () => {
    if (!current) return;
    setShowSubs(true);
  }, [current]);

  // Startup screen: the logo is the whole view. Rendered BEFORE the
  // no-media check so it also hides the loaded-media transport — otherwise
  // clicking the brand while a track plays left titles, timeline and controls
  // showing around the logo.
  if (startupMode) return <div className="player-empty player-empty--blank" />;

  if (!current) {
    return (
      <div className="player-empty">
        <img src="./Mov.png" alt="" className="empty-icon" />
        <h2>Nothing playing</h2>
        <p>Open files or add media from your library to start.</p>
      </div>
    );
  }

  const stageCursor = fullscreen && !controlsVisible ? 'movira-hide-cursor' : '';

  return (
    <div className={`player-view ${fullscreen ? 'fullscreen' : ''}`} ref={attachPlayerWheel}>
      {/* Mouse tracking is handled by the window-level listener — the fullscreen
          stage covers the whole screen anyway, and a second handler here would
          double-trigger pokeControls making the fade stutter. */}
      <div
        className={`player-stage ${fullscreen ? 'fullscreen' : ''} ${stageCursor}`}
        onDoubleClick={onDblClick}
      >
        <div
          className={`video-host ${current.type === 'video' ? 'video-active' : 'audio-active'} ${current.type === 'video' ? ['zoom-fit', 'zoom-fill', 'zoom-stretch'][zoomMode] : ''}`}
          ref={(node) => {
            if (videoHostRef && 'current' in videoHostRef) videoHostRef.current = node;
            const el = services.engine.el();
            if (node && el && !node.contains(el)) {
              node.appendChild(el);
            }
          }}
        >
          {current.type === 'audio' ? (
            <div className="audio-artwork">
              {current.artwork ? <img src={current.artwork} alt="" /> : <div className="artwork-placeholder">♪</div>}
            </div>
          ) : null}
        </div>
        {!fullscreen && (
          <button className="section-close stage-close" onClick={onClose} title="Close Now Playing (back to home)">✕</button>
        )}
        {/* Written directly to the DOM by flashVolume(); never React state, so
            a fast wheel does not re-render the player once per notch. */}
        <div className="volume-osd" ref={osdRef} aria-hidden="true" />
        <div className={`now-playing-meta ${fullscreen ? `np-shifted ${fullscreen && !controlsVisible ? 'controls-hidden' : ''}` : ''}`}>
          <div className="np-title">{current.title}</div>
          <div className="np-sub">
            {current.artist ? `${current.artist} · ` : ''}
            {current.album ?? ''}
          </div>
        </div>
      </div>

      <div className={`transport ${fullscreen && !controlsVisible ? 'controls-hidden' : ''}`}>
      <div className="progress-row">
        <span className="time">{formatTime(seekPreview ?? progress.time)}</span>
        <Timeline
          // The CURSOR follows the seek preview, not the raw engine clock.
          // progress.time only moves on the next throttled progress push, and on
          // the ffmpeg/MSE tier (or any cold multi-GB seek) that is tens to
          // hundreds of milliseconds AFTER the pointer was released — during
          // which a cursor driven by progress.time snaps BACK to the old
          // position and then jumps forward again: exactly the
          // "2:00 -> 10:00 -> 2:00 -> 10:00" report. Holding the preview until
          // the engine confirms it makes the click a single visible move.
          time={seekPreview ?? progress.time}
          duration={progress.duration}
          buffered={progress.buffered ?? 0}
          onSeek={(t) => {
            // Single click: exact position under the cursor, committed NOW.
            setSeekPreview(t);
            void services.engine.seek(t);
            if (fullscreen) pokeControls();
          }}
          onScrub={(t) => {
            // Live drag feedback: engine coalesces these internally.
            setSeekPreview(t);
            services.engine.scrubThrough(t);
            if (fullscreen) pokeControls();
          }}
          onScrubEnd={(t) => {
            setSeekPreview(t);
            void services.engine.seek(t);
          }}
        />
        <span className="time">{formatTime(progress.duration)}</span>
      </div>
        <div className="controls-row">
          <div className="left">
            {/* These two SKIP IN TIME on the element that is already playing.
                They used to be playlist Previous/Next, which with the usual
                "one movie open" queue either did nothing at all (Next returns
                early on a single-item queue) or tore the whole pipeline down and
                loaded a different file - the multi-second freeze reported as
                "lag when moving forward/backward". Playlist skipping now lives
                on Ctrl+Left / Ctrl+Right and on P / N. */}
            <button onClick={() => onSeekBy(-SKIP_SEC)} title="Previous: skip back 10s (←)">⏮</button>
            <button className="play-btn" onClick={onTogglePlay} title="Play/Pause (Space)">{playing ? '⏸' : '⏵'}</button>
            <button onClick={() => onSeekBy(SKIP_SEC)} title="Next: skip forward 10s (→)">⏭</button>
            <button onClick={() => void services.engine.stop()} title="Stop">⏹</button>
            <button
              onClick={() => { void services.player.toggleShuffle().then(onQueueChange); }}
              className={queue.shuffle ? 'active' : ''}
              title="Shuffle (S)"
            >🔀</button>
            <button
              onClick={() => { services.player.cycleRepeat(); onQueueChange(); }}
              className={queue.repeat !== 'off' ? 'active' : ''}
              title={`Repeat: ${queue.repeat} (R)`}
            >{queue.repeat === 'one' ? '🔂' : '🔁'}</button>
          </div>
          <div className="right">
            <select value={rate} onChange={(e) => changeRate(Number(e.target.value))} title="Playback speed">
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                <option key={r} value={r}>{r}×</option>
              ))}
            </select>
            <div className="volume-zone">
              <button
                className="volume-btn"
                onClick={toggleMute}
                title={`${muted || volume <= 0.001 ? 'Muted' : `${Math.round(volume * 100)}%`} — M to mute, scroll over this control to change the volume`}
                aria-label={`Volume ${muted ? 'muted' : `${Math.round(volume * 100)} percent`}`}
                data-volume={Math.round((muted ? 0 : volume) * 100)}
              >
                <span className="volume-glyph" aria-hidden="true">
                  {muted || volume <= 0.001 ? '🔇' : volume < 0.34 ? '🔈' : volume < 0.67 ? '🔉' : '🔊'}
                </span>
                <span className="volume-pct" aria-hidden="true">{Math.round((muted ? 0 : volume) * 100)}</span>
              </button>
              <VolumeSlider
                volume={volume}
                muted={muted}
                onSetVolume={changeVolume}
                onVolumeStep={onVolumeChange}
              />
            </div>
            <button
              onClick={() => void cycleAudio()}
              title="Audio track (B)"
            >🎧</button>
            <button onClick={loadLocalSub} title="Load subtitle file">CC</button>
            <button onClick={searchOnlineSubs} title="Find subtitles online">🌐</button>
            <button onClick={() => void pip()} title="Picture-in-Picture">⧉</button>
            <button onClick={onToggleFullscreen} title="Fullscreen (F) or double-click the video">{fullscreen ? '🗗' : '⛶'}</button>
          </div>
        </div>
      </div>

      {showQueue && (
        <QueuePanel
          services={services}
          queue={queue}
          onQueueChange={onQueueChange}
          onClose={closeQueue}
        />
      )}
      {showSubs && (
        <SubtitlePanel
          services={services}
          current={current}
          subtitle={subtitle}
          onSubtitle={onSubtitle}
          onClose={closeSubs}
        />
      )}
      {audioTracks.length > 1 && (
        <div className="audio-tracks">
          {audioTracks.map((t) => (
            <button
              key={t.index}
              className={activeAudio === t.index ? 'active' : ''}
              onClick={() => void pickAudioTrack(t.index)}
            >
              {t.language ? t.language.toUpperCase() : `Track ${t.index + 1}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
