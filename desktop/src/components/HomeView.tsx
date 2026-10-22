import FloatingPanel from './FloatingPanel';

interface Props {
  /** Hide the startup window (Now Playing stays in the background). */
  onClose: () => void;
}

/**
 * Movira startup screen, VLC-style: the bare symbol centered on the empty
 * player area and nothing else.
 *
 * This screen used to carry quick-action buttons (Open Folder / Open File /
 * Library / Playlist / Settings / Diagnostics), an "Open a file or folder to
 * start playing" hint, and a "Resume Now Playing" block. All of it is gone —
 * the startup view is deliberately inert, and those actions are reached through
 * the top bar (Media / Library / Playlist / Now Playing / Settings) instead.
 * A bare symbol is what makes it read like VLC's cone rather than a launcher.
 *
 * The FloatingPanel wrapper is kept only for its behaviour (Escape returns to
 * Now Playing). It is explicitly NOT dismissible by click: any click outside
 * the logo used to close this window, which switched the view to Now Playing
 * and made the player draw its "Nothing playing" empty-state text. A stray
 * click on empty space must leave the startup screen exactly as it was — bare
 * logo, no text. Escape and the top-bar "Now Playing" button still leave it,
 * and opening any media leaves it too.
 *
 * Its window chrome is switched off in styles.css via [data-floating='home'],
 * so no box is drawn around the logo.
 *
 * The image is `Mov.png` — the bare symbol on a transparent background, with
 * no app-icon container and no sparkle — so it sits directly on the background.
 */
export default function HomeView({ onClose }: Props) {
  return (
    <FloatingPanel id="home" width="auto" height="auto" onClose={onClose} dismissible={false}>
      <div className="startup-screen">
        <img className="startup-logo" src="./Mov.png" alt="Movira" draggable={false} />
      </div>
    </FloatingPanel>
  );
}
