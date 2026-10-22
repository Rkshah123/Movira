import React, { useState } from 'react';
import type { MediaItem, SubtitleTrack } from '@shared';
import { baseName } from '@shared';
import { moviraApi } from '../api';
import type { DesktopServices } from '../services';

interface Props {
  services: DesktopServices;
  current: MediaItem;
  subtitle: SubtitleTrack | null;
  onSubtitle: (t: SubtitleTrack | null) => void;
  onClose: () => void;
}

/** Memoized: the parent re-renders ~10×/s on progress ticks; the subtitle
 *  panel only changes on user actions, so skip those re-renders. */
function SubtitlePanel({ services, current, subtitle, onSubtitle, onClose }: Props) {
  const [results, setResults] = useState<Array<{ id: string; label: string; language: string; format: 'srt' | 'vtt' }>>([]);
  const [loading, setLoading] = useState(false);
  const [lang, setLang] = useState(services.userData.getSettings().subtitleLanguage);
  const [status, setStatus] = useState('');

  const search = async () => {
    setLoading(true);
    setStatus('');
    try {
      const name = baseName(current.path).replace(/\.[^.]+$/, '');
      const langs = lang === 'any' ? undefined : [lang];
      const r = await services.subtitles.searchOnline(name, langs);
      setResults(r);
      if (!r.length) setStatus('No subtitles found.');
    } catch {
      setStatus('Search failed.');
    } finally {
      setLoading(false);
    }
  };

  const download = async (id: string) => {
    setLoading(true);
    try {
      const result = results.find((r) => r.id === id)!;
      const content = await moviraApi.downloadSubtitleOnline(id);
      const track = services.subtitles.loadLocal(result.label, content);
      onSubtitle(track);
      setStatus(`Loaded: ${result.label}`);
    } catch {
      setStatus('Download failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="subtitle-panel">
      <div className="panel-header">
        <h3>Subtitles</h3>
        <button onClick={onClose}>✕</button>
      </div>
      <div className="subtitle-current">
        <span>Active: {subtitle ? subtitle.label : 'None'}</span>
        {subtitle && <button onClick={() => onSubtitle(null)}>Disable</button>}
      </div>
      <div className="subtitle-search-row">
        <select value={lang} onChange={(e) => setLang(e.target.value)}>
          <option value="any">Any language</option>
          <option value="eng">English</option>
          <option value="spa">Spanish</option>
          <option value="fre">French</option>
          <option value="ger">German</option>
          <option value="ara">Arabic</option>
          <option value="hin">Hindi</option>
          <option value="urd">Urdu</option>
        </select>
        <button className="btn btn-primary" onClick={() => void search()} disabled={loading}>
          {loading ? 'Searching…' : 'Search online'}
        </button>
      </div>
      {status && <div className="subtitle-status">{status}</div>}
      <div className="subtitle-results">
        {results.map((r) => (
          <div key={r.id} className="subtitle-result">
            <span className="sr-lang">{r.language.toUpperCase()}</span>
            <span className="sr-label">{r.label}</span>
            <button onClick={() => void download(r.id)} disabled={loading}>Download</button>
          </div>
        ))}
      </div>
      <div className="subtitle-note">
        Tip: place an .srt or .vtt file with the same name next to the video, or load it with the CC button.
      </div>
    </div>
  );
}

export default React.memo(SubtitlePanel);
