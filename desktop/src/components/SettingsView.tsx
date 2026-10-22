import React, { useState } from 'react';
import type { PlaybackSettings, ThemeMode, RepeatMode } from '@shared';
import type { DesktopServices } from '../services';
import { moviraApi } from '../api';
import FloatingPanel from './FloatingPanel';

interface Props {
  services: DesktopServices;
  onQuit: () => void;
  /** Close the section and return to the Movira home screen. */
  onClose: () => void;
}

export default function SettingsView({ services, onQuit, onClose }: Props) {
  const [s, setS] = useState<PlaybackSettings>(services.userData.getSettings());
  const [saved, setSaved] = useState(false);

  const update = (patch: Partial<PlaybackSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    void services.userData.updateSettings(patch);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  return (
    <FloatingPanel id="settings" width="min(520px, 92vw)" height="min(640px, 86vh)" onClose={onClose}>
    <div className="settings-view">
      <div className="settings-header">
        <h2>Settings</h2>
        {saved && <span className="saved-note">Saved ✓</span>}
        <button className="section-close header-close" onClick={onClose} title="Close Settings (back to home)">✕</button>
      </div>

      <section>
        <h3>General</h3>
        <label>
          Theme
          <select value={s.theme} onChange={(e) => update({ theme: e.target.value as ThemeMode })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.resumePlayback} onChange={(e) => update({ resumePlayback: e.target.checked })} />
          Resume playback where you left off
        </label>
        <label className="check">
          <input type="checkbox" checked={s.confirmExit} onChange={(e) => update({ confirmExit: e.target.checked })} />
          Confirm before exit
        </label>
      </section>

      <section>
        <h3>Playback</h3>
        <label>
          Default speed
          <select value={s.defaultSpeed} onChange={(e) => update({ defaultSpeed: Number(e.target.value) })}>
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
          </select>
        </label>
        <label>
          Seek interval (seconds)
          <input
            type="number" min={5} max={60}
            value={s.seekInterval}
            onChange={(e) => update({ seekInterval: Math.max(5, Math.min(60, Number(e.target.value) || 10)) })}
          />
        </label>
        <label>
          Repeat mode
          <select value={s.repeat} onChange={(e) => update({ repeat: e.target.value as RepeatMode })}>
            <option value="off">Off</option>
            <option value="all">Repeat all</option>
            <option value="one">Repeat one</option>
          </select>
        </label>
      </section>

      <section>
        <h3>Audio</h3>
        <label>
          Default volume: {Math.round(s.defaultVolume * 100)}%
          <input
            type="range" min={0} max={1} step={0.05}
            value={s.defaultVolume}
            onChange={(e) => update({ defaultVolume: Number(e.target.value) })}
          />
        </label>
      </section>

      <section>
        <h3>Video & Subtitles</h3>
        <label className="check">
          <input type="checkbox" checked={s.openFullscreen} onChange={(e) => update({ openFullscreen: e.target.checked })} />
          Open videos in fullscreen
        </label>
        <label className="check">
          <input type="checkbox" checked={s.autoLoadSubtitles} onChange={(e) => update({ autoLoadSubtitles: e.target.checked })} />
          Automatically load matching subtitles
        </label>
        <label>
          Preferred subtitle language
          <select value={s.subtitleLanguage} onChange={(e) => update({ subtitleLanguage: e.target.value })}>
            <option value="any">Any</option>
            <option value="eng">English</option>
            <option value="spa">Spanish</option>
            <option value="fre">French</option>
            <option value="ger">German</option>
            <option value="ara">Arabic</option>
            <option value="hin">Hindi</option>
            <option value="urd">Urdu</option>
          </select>
        </label>
      </section>

      <section>
        <h3>Library</h3>
        <label className="check">
          <input type="checkbox" checked={s.autoScan} onChange={(e) => update({ autoScan: e.target.checked })} />
          Scan library folders automatically on startup
        </label>
      </section>

      <section>
        <h3>Privacy</h3>
        <p className="about-line">
          Movira never records watch history, never phones home, and works fully offline.
        </p>
        <div className="privacy-row">
          <button className="btn" onClick={() => { void services.userData.clearFavorites(); setSaved(true); setTimeout(() => setSaved(false), 1200); }}>
            Clear favorites
          </button>
        </div>
      </section>

      <section>
        <h3>Default apps</h3>
        <p className="about-line">
          To make Movira your default video/audio player, open Windows Settings
          below, pick “Default apps”, select <strong>Movira</strong> and set it
          for the formats you want. Movira never changes your defaults on its own.
        </p>
        <div className="privacy-row">
          <button className="btn" onClick={() => { void moviraApi.openDefaultApps(); }}>
            Open Windows “Default apps” settings
          </button>
        </div>
      </section>

      <section>
        <h3>About</h3>
        <p className="about-line">Movira · version 1.0.0 · Electron media player</p>
        <button className="btn" onClick={onQuit}>Quit Movira</button>
      </section>
    </div>
    </FloatingPanel>
  );
}
