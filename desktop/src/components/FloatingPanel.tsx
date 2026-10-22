import React, { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface Props {
  /** Identifies the panel (kept on the node for diagnostics/tests). */
  id: string;
  /** Called on the panel's ✕ or on a click outside the window. */
  onClose: () => void;
  /** Width of the floating window, e.g. '480px' or 'min(560px, 92vw)'. */
  width: string;
  /** Height; 'auto' sizes the window to its content. */
  height: string;
  /** Whether a click outside the window closes it. Default true. The startup
   *  logo window passes false: it is the app's front door, and a stray click on
   *  empty space must not dismiss it. */
  dismissible?: boolean;
  children: ReactNode;
}

/**
 * Open floating windows, innermost last. Escape is dispatched through
 * closeTopPanel() rather than by each panel binding its own key listener —
 * two listeners on the same key meant one Escape press both closed a panel and
 * exited fullscreen.
 */
const stack: Array<() => void> = [];

/** Close the topmost floating panel. Returns false when none are open, so the
 *  caller can fall through to its own Escape behaviour (leaving fullscreen). */
export function closeTopPanel(): boolean {
  const fn = stack[stack.length - 1];
  if (!fn) return false;
  fn();
  return true;
}

/**
 * Chrome that is NOT "outside" a panel: clicking it must never close a panel
 * and must never reach the player underneath.
 *
 * The top bar carries the section navigation and the mini transport. Treating
 * it as an outside click is what made "open Settings, then click Playlist"
 * close Settings on mouse-down and only then navigate — and, worse, made a
 * click on the transport toggle playback as a side effect of touching a
 * section. The toast is purely informational.
 */
function isAppChrome(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('.topbar, .error-toast');
}

/**
 * VLC-style floating secondary window: a small dialog hovering over the main
 * screen inside <main>.
 *
 * It is deliberately NOT modal with respect to the top bar: no focus trap and
 * no auto-focus, so navigation and keyboard shortcuts keep working while a
 * panel is open, and switching sections is always a single click. Clicks are
 * still fenced from the player underneath by the section backdrop rendered by
 * App, so an accidental click while a panel is open can never hit Play, Skip
 * or Stop.
 *
 * "Click outside" fires on `click`, NOT on a capture-phase `mousedown`:
 *
 *   - A capture listener on mousedown runs BEFORE React's handlers, so it
 *     closed the panel out from under the control that was being pressed. The
 *     press still completed on a different (now unmounted) tree, which is how
 *     "click Settings, it flashed and closed" happened. React's onClick runs
 *     first on `click`, so the target button has already handled itself by the
 *     time we decide whether anything else should close.
 *   - `mousedown` also fired for press-and-drag and for right-click, neither of
 *     which is a "click away".
 *
 * The check is `closest('[data-floating]')` rather than `contains()` on this
 * node only: a click inside ANY open panel is not outside. This matters when a
 * panel is rendered twice — see the note in App.tsx — where the click landed
 * inside the visible copy but outside a second, hidden copy that would
 * otherwise close it immediately.
 */
export default function FloatingPanel({ id, onClose, width, height, dismissible = true, children }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    stack.push(onClose);
    return () => {
      const i = stack.indexOf(onClose);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [onClose]);

  useEffect(() => {
    // A non-dismissible window must not react to clicks at all — not even by
    // registering the listener. Leaving it attached would still fire, and the
    // startup screen would vanish on the first stray click.
    if (!dismissible) return;
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const node = panelRef.current;
      if (!node) return;
      const target = e.target as Node | null;
      if (target && node.contains(target)) return;
      // Inside some other panel, or on app chrome that manages itself.
      if (isAppChrome(e.target)) return;
      if (target instanceof Element && target.closest('[data-floating]')) return;
      onClose();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [onClose, dismissible]);

  return (
    <div
      className="floating-panel"
      data-floating={id}
      ref={panelRef}
      style={{ width, height }}
    >
      {children}
    </div>
  );
}
