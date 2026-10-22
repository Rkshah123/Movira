import { memo, useEffect, useRef, useState } from 'react';
import type { MediaItem } from '@shared';
import type { View } from '../App';

interface Props {
  view: View;
  onNavigate: (v: View) => void;
  current: MediaItem | null;
  playing: boolean;
  onTogglePlay: () => void;
  onNext: () => void;
  onPrev: () => void;
  /** Brand (logo) click: reopen the startup screen. */
  onBrand: () => void;
  /** Media menu actions, in the order VLC lists them. */
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onOpenMultiple: () => void;
  onQuit: () => void;
}

const navItems: { id: View; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'library', label: 'Library' },
  { id: 'playlists', label: 'Playlist' },
  { id: 'player', label: 'Now Playing' },
  { id: 'settings', label: 'Settings' },
  // Always in the menu bar, not buried on a section screen: a stutter is
  // noticed WHILE PLAYING, so the recorded report has to be one click away
  // from the player.
  { id: 'diagnostics', label: 'Diagnostics' },
];

/**
 * VLC-style menu bar: every destination sits in one horizontal line.
 * Brand | Media | Library | Playlist | Now Playing | Settings | Diagnostics,
 * with a compact playback indicator on the right when something is loaded.
 *
 * "Media" is a real menu, not a destination: it opens a dropdown carrying the
 * media options (Open Folder / Open File / Open Multiple Files in Queue /
 * Quit). Those two Open buttons used to sit in the bar itself, which left them
 * duplicated against the Home screen — they now live only in the menu, which
 * is where VLC keeps them.
 */
function TopBar({
  view, onNavigate, current, playing, onTogglePlay, onNext, onPrev, onBrand,
  onOpenFolder, onOpenFile, onOpenMultiple, onQuit,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close on an outside click or Escape; the menu is transient chrome, so it
  // must never survive the interaction that dismissed it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Leaving Media by any other route (top bar, brand, playback start) must not
  // leave its dropdown stranded open.
  useEffect(() => {
    if (view !== 'media') setMenuOpen(false);
  }, [view]);

  // The brand logo reopens the startup screen, and the startup screen blanks the
  // player area — so honouring the click mid-playback would swap a running
  // video for a bare logo while the audio kept going. While anything is
  // actually playing the logo is inert: repeated clicks do nothing, and the
  // button keeps its normal look (no disabled styling, no layout change).
  //
  // `playing` is the engine's own playback intent, pushed through the
  // onPlayingChange event — not a timer, so it flips the instant playback starts
  // or stops and is correct even across a seek-restart, where video.paused lies.
  // A paused or unloaded player leaves the logo fully clickable.
  const brandLocked = playing;

  const mediaActions: { label: string; run: () => void }[] = [
    { label: 'Open Folder', run: onOpenFolder },
    { label: 'Open File', run: onOpenFile },
    { label: 'Open Multiple Files in Queue', run: onOpenMultiple },
    { label: 'Quit', run: onQuit },
  ];

  return (
    <header className="topbar">
      <button
        className="brand"
        onClick={brandLocked ? undefined : onBrand}
        aria-disabled={brandLocked || undefined}
        title="Movira"
      >
        <img src="./Mov.png" alt="Movira" className="brand-icon" />
        <span className="brand-name">Movira</span>
      </button>
      <div className="topbar-actions">
        {navItems.map((it) =>
          it.id === 'media' ? (
            <div className="media-menu" key={it.id} ref={menuRef}>
              <button
                className={`btn topbar-nav ${view === it.id ? 'active' : ''}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
              >
                {it.label}
              </button>
              {menuOpen && (
                <div className="media-menu-dropdown" role="menu">
                  {mediaActions.map((a) => (
                    <button
                      key={a.label}
                      role="menuitem"
                      className="media-menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        a.run();
                      }}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              key={it.id}
              className={`btn topbar-nav ${view === it.id ? 'active' : ''}`}
              onClick={() => onNavigate(it.id)}
            >
              {it.label}
            </button>
          ),
        )}
      </div>
      {current && (
        <div className="topbar-mini">
          <div className="topbar-mini-info">
            <div className="topbar-mini-title">{current.title}</div>
            <div className="topbar-mini-sub">{current.artist ?? (current.type === 'video' ? 'Video' : 'Music')}</div>
          </div>
          <button onClick={onPrev} title="Previous">⏮</button>
          <button onClick={onTogglePlay} title="Play/Pause">{playing ? '⏸' : '⏵'}</button>
          <button onClick={onNext} title="Next">⏭</button>
        </div>
      )}
    </header>
  );
}

// Memoized: App re-renders ~10×/s on progress ticks; the top bar only changes
// with view/current/playing, so skip the in-between renders.
export default memo(TopBar);
