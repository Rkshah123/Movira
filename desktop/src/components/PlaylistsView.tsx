import React, { useEffect, useState } from 'react';
import type { MediaItem, Playlist } from '@shared';
import { formatTime } from '@shared';
import type { DesktopServices } from '../services';
import FloatingPanel from './FloatingPanel';

interface Props {
  services: DesktopServices;
  onPlayItems: (items: MediaItem[], start?: number) => void;
  /** Close the section and return to the Movira home screen. */
  onClose: () => void;
}

export default function PlaylistsView({ services, onPlayItems, onClose }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    const unsub = services.playlists.subscribe((p) => {
      setPlaylists(p);
      if (!p.length) setSelectedId(null);
      else if (!selectedId || !p.some((x) => x.id === selectedId)) setSelectedId(p[0].id);
    });
    return unsub;
  }, [services, selectedId]);

  const selected = playlists.find((p) => p.id === selectedId) ?? null;

  return (
    <FloatingPanel id="playlists" width="min(880px, 94vw)" height="min(620px, 88vh)" onClose={onClose}>
    <div className="playlists-view">
      <button className="section-close playlists-close" onClick={onClose} title="Close Playlists (back to home)">✕</button>
      <div className="playlists-sidebar">
        <div className="playlist-create">
          <input
            placeholder="New playlist name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              // Enter must not be a dead key either: an empty field still
              // creates a playlist, matching the Create button.
              if (e.key !== 'Enter') return;
              e.preventDefault();
              void services.playlists.create(newName).then((pl) => {
                setNewName('');
                setSelectedId(pl.id);
              });
            }}
          />
          <button
            className="btn btn-primary"
            title="Create a playlist (uses the typed name, or a default if left blank)"
            onClick={() => {
              // This used to bail out on a blank/whitespace name, so pressing
              // Create with nothing typed did nothing at all — no playlist, no
              // message, no focus change. It read as a dead button. playlists.create()
              // already falls back to "New Playlist", so just create.
              void services.playlists.create(newName).then((pl) => {
                setNewName('');
                setSelectedId(pl.id);
              });
            }}
          >Create</button>
        </div>
        <div className="playlist-list">
          {playlists.map((p) => (
            <div key={p.id} className={`playlist-item ${selectedId === p.id ? 'active' : ''}`} onClick={() => setSelectedId(p.id)}>
              {renaming === p.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void services.playlists.rename(p.id, renameValue);
                      setRenaming(null);
                    }
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <>
                  <span className="pl-name">{p.name}</span>
                  <span className="pl-count">{p.items.length}</span>
                </>
              )}
              <div className="pl-actions">
                <button title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(p.id); setRenameValue(p.name); }}>✎</button>
                <button
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    void services.playlists.remove(p.id);
                  }}
                >🗑</button>
              </div>
            </div>
          ))}
          {!playlists.length && <div className="empty-note">No playlists yet.</div>}
        </div>
      </div>

      <div className="playlist-detail">
        {selected ? (
          <>
            <div className="playlist-header">
              <h2>{selected.name}</h2>
              <span className="pl-meta">{selected.items.length} items</span>
              <div className="panel-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => selected.items.length && onPlayItems(selected.items, 0)}
                >Play</button>
                <button
                  className="btn"
                  onClick={() => {
                    void services.playlists.shuffle(selected.id).then((items) => {
                      if (items.length) onPlayItems(items, 0);
                    });
                  }}
                >Shuffle Play</button>
              </div>
            </div>
            <div className="playlist-items">
              {selected.items.map((item, idx) => (
                <div key={item.id} className="playlist-row">
                  <span className="q-index">{idx + 1}</span>
                  <button className="q-main" onClick={() => onPlayItems(selected.items, idx)}>
                    <span className="q-title">{item.title}</span>
                    <span className="q-sub">{item.artist ?? item.type}</span>
                  </button>
                  <span className="q-duration">{item.duration ? formatTime(item.duration) : ''}</span>
                  <button className="q-btn" onClick={() => void services.playlists.reorderMedia(selected.id, idx, Math.max(0, idx - 1))}>↑</button>
                  <button className="q-btn" onClick={() => void services.playlists.reorderMedia(selected.id, idx, Math.min(selected.items.length - 1, idx + 1))}>↓</button>
                  <button className="q-btn" onClick={() => void services.playlists.removeMedia(selected.id, item.id)}>✕</button>
                </div>
              ))}
              {!selected.items.length && <div className="empty-note">Empty playlist — add media from the Library (+ button).</div>}
            </div>
          </>
        ) : (
          <div className="empty-note">Select or create a playlist.</div>
        )}
      </div>
    </div>
    </FloatingPanel>
  );
}
