import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { MediaItem } from '@shared';
import { formatTime, formatSize } from '@shared';
import { moviraApi } from '../api';
import type { DesktopServices } from '../services';
import FloatingPanel from './FloatingPanel';

interface Props {
  services: DesktopServices;
  onPlayItems: (items: MediaItem[], start?: number) => void;
  onError: (m: string) => void;
  /** Close the section and return to the Movira home screen. */
  onClose: () => void;
}

type Tab = 'videos' | 'music';

export default function LibraryView({ services, onPlayItems, onError, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('videos');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [folders, setFolders] = useState<ReturnType<DesktopServices['library']['getFolders']>>([]);
  const [query, setQuery] = useState('');
  const [scanning, setScanning] = useState(false);
  const [userDataVersion, setUserDataVersion] = useState(0);

  useEffect(() => {
    const unsub = services.library.subscribe((i, f) => {
      setItems(i);
      setFolders(f);
    });
    const unsubUd = services.userData.subscribe(() => setUserDataVersion((v) => v + 1));
    return () => {
      unsub();
      unsubUd();
    };
  }, [services]);

  const doScan = useCallback(async () => {
    setScanning(true);
    try {
      await services.library.rescan();
      await services.library.validate();
    } catch {
      onError('Scan failed');
    } finally {
      setScanning(false);
    }
  }, [services, onError]);

  const addFolder = useCallback(async () => {
    const folder = await moviraApi.openFolder();
    if (!folder) return;
    await services.library.addFolder(folder, 'mixed');
    void doScan();
  }, [services, doScan]);

  const removeFolder = useCallback(
    async (id: string) => {
      await services.library.removeFolder(id);
    },
    [services]
  );

  const filtered = useMemo(() => {
    const base = query ? services.library.search(query) : items;
    if (tab === 'videos') return base.filter((i) => i.type === 'video');
    if (tab === 'music') return base.filter((i) => i.type === 'audio');
    return base;
    // userDataVersion refreshes favorites/history lists
  }, [query, tab, items, services, userDataVersion]);

  // Privacy mode: watch history was removed entirely, so the old
  // favorites/recent tabs no longer render. Favorites remain available via the
  // ♥ button when adding media to playlists.
  const favorites = useMemo(() => services.userData.getFavorites(), [services, userDataVersion]);
  void favorites;

  const list = filtered;

  const play = (item: MediaItem, idx: number) => {
    onPlayItems(list, idx);
  };

  return (
    <FloatingPanel id="library" width="min(880px, 94vw)" height="min(620px, 88vh)" onClose={onClose}>
    <div className="library-view">
      <div className="library-header">
        <div className="tabs">
          {(['videos', 'music'] as Tab[]).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'videos' ? 'Videos' : 'Music'}
            </button>
          ))}
        </div>
        <div className="library-actions">
          <input
            className="search"
            placeholder="Search title, artist, album, filename…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn" onClick={() => void addFolder()}>Add Folder</button>
          <button className="btn" onClick={() => void doScan()} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Rescan'}
          </button>
          <button className="section-close header-close" onClick={onClose} title="Close Library (back to home)">✕</button>
        </div>
      </div>

      <div className="folders-row">
        {folders.length === 0 && <span className="empty-note">No library folders yet — add one to build your library.</span>}
        {folders.map((f) => (
          <span key={f.id} className="folder-chip">
            {f.label}
            <button onClick={() => void removeFolder(f.id)} title="Remove folder">✕</button>
          </span>
        ))}
      </div>

      <div className="media-grid">
        {list.map((item, idx) => (
          <div key={item.id} className="media-card" onDoubleClick={() => play(item, idx)}>
            <div
              className={`media-thumb ${item.type}`}
              onClick={() => play(item, idx)}
              style={item.artwork ? { backgroundImage: `url(${item.artwork})` } : undefined}
            >
              {!item.artwork && <span className="thumb-icon">{item.type === 'video' ? '🎬' : '♪'}</span>}
              {item.duration !== undefined && <span className="thumb-duration">{formatTime(item.duration)}</span>}
            </div>
            <div className="media-info">
              <div className="media-title" title={item.title}>{item.title}</div>
              <div className="media-sub">
                {[item.artist, item.album].filter(Boolean).join(' · ') ||
                  [item.width && `${item.width}×${item.height}`, item.format, formatSize(item.size)].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="media-card-actions">
              <button
                title={services.userData.isFavorite(item.id) ? 'Remove from favorites' : 'Add to favorites'}
                onClick={() => { void services.userData.toggleFavorite(item); setUserDataVersion((v) => v + 1); }}
              >{services.userData.isFavorite(item.id) ? '♥' : '♡'}</button>
              <button
                title="Add to playlist"
                onClick={() => {
                  const names = services.playlists.getAll();
                  if (!names.length) {
                    void services.playlists.create('My Playlist', [item]);
                  } else {
                    void services.playlists.addMedia(names[0].id, [item]);
                  }
                  onError(`Added to ${names.length ? names[0].name : 'My Playlist'}`);
                }}
              >＋</button>
            </div>
          </div>
        ))}
        {!list.length && <div className="empty-note">{scanning ? 'Scanning…' : 'Nothing here yet.'}</div>}
      </div>
    </div>
    </FloatingPanel>
  );
}
