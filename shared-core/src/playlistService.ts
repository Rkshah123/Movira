import type { MediaItem, Playlist } from './types';
import { uniqueId } from './types';
import type { StorageAdapter } from './storage';
import { storageKeys } from './storage';

export class PlaylistService {
  private playlists: Playlist[] = [];
  private listeners = new Set<(p: Playlist[]) => void>();

  constructor(private storage: StorageAdapter) {}

  async init() {
    const raw = await this.storage.get(storageKeys.playlists);
    if (Array.isArray(raw)) this.playlists = raw as Playlist[];
    this.notify();
  }

  getAll(): Playlist[] {
    return [...this.playlists];
  }

  get(id: string): Playlist | undefined {
    return this.playlists.find((p) => p.id === id);
  }

  async create(name: string, items: MediaItem[] = []): Promise<Playlist> {
    const pl: Playlist = { id: uniqueId(), name: name.trim() || 'New Playlist', items: [...items], createdAt: Date.now(), updatedAt: Date.now() };
    this.playlists.push(pl);
    await this.save();
    return pl;
  }

  async rename(id: string, name: string) {
    const pl = this.playlists.find((p) => p.id === id);
    if (!pl) return;
    pl.name = name.trim() || pl.name;
    pl.updatedAt = Date.now();
    await this.save();
  }

  async remove(id: string) {
    this.playlists = this.playlists.filter((p) => p.id !== id);
    await this.save();
  }

  async addMedia(id: string, items: MediaItem[]) {
    const pl = this.playlists.find((p) => p.id === id);
    if (!pl) return;
    for (const it of items) if (!pl.items.some((m) => m.id === it.id)) pl.items.push(it);
    pl.updatedAt = Date.now();
    await this.save();
  }

  async removeMedia(id: string, itemId: string) {
    const pl = this.playlists.find((p) => p.id === id);
    if (!pl) return;
    pl.items = pl.items.filter((m) => m.id !== itemId);
    pl.updatedAt = Date.now();
    await this.save();
  }

  async reorderMedia(id: string, from: number, to: number) {
    const pl = this.playlists.find((p) => p.id === id);
    if (!pl || from === to || from < 0 || to < 0 || from >= pl.items.length || to >= pl.items.length) return;
    const [it] = pl.items.splice(from, 1);
    pl.items.splice(to, 0, it);
    pl.updatedAt = Date.now();
    await this.save();
  }

  async shuffle(id: string): Promise<MediaItem[]> {
    const pl = this.playlists.find((p) => p.id === id);
    if (!pl) return [];
    const items = [...pl.items];
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  subscribe(fn: (p: Playlist[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.getAll());
    return () => this.listeners.delete(fn);
  }

  private async save() {
    await this.storage.set(storageKeys.playlists, this.playlists);
    this.notify();
  }

  private notify() {
    for (const fn of this.listeners) fn(this.getAll());
  }
}
