import type { MediaItem } from './types';
import { detectMediaType, baseName, uniqueId } from './types';
import type { StorageAdapter } from './storage';
import { storageKeys } from './storage';

export interface LibraryFolder {
  id: string;
  path: string;
  label: string;
  type: 'video' | 'audio' | 'mixed';
}

export interface FileSystemAdapter {
  listMediaFiles(folder: string): Promise<{ path: string; size: number; mtime: number }[]>;
  exists(path: string): Promise<boolean>;
}

export interface MetadataAdapter {
  enrich(items: MediaItem[]): Promise<MediaItem[]>;
}

export class MediaLibraryService {
  private folders: LibraryFolder[] = [];
  private items: MediaItem[] = [];
  private listeners = new Set<(items: MediaItem[], folders: LibraryFolder[]) => void>();

  constructor(
    private storage: StorageAdapter,
    private fs: FileSystemAdapter,
    private metadata?: MetadataAdapter
  ) {}

  async init() {
    const [folders, items] = await Promise.all([
      this.storage.get(storageKeys.libraryFolders),
      this.storage.get(storageKeys.libraryItems),
    ]);
    if (Array.isArray(folders)) this.folders = folders as LibraryFolder[];
    if (Array.isArray(items)) this.items = items as MediaItem[];
    this.notify();
  }

  getAll(): MediaItem[] {
    return [...this.items];
  }

  getFolders(): LibraryFolder[] {
    return [...this.folders];
  }

  getByType(type: 'video' | 'audio'): MediaItem[] {
    return this.items.filter((i) => i.type === type);
  }

  search(query: string): MediaItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.getAll();
    return this.items.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        baseName(i.path).toLowerCase().includes(q) ||
        (i.artist ?? '').toLowerCase().includes(q) ||
        (i.album ?? '').toLowerCase().includes(q)
    );
  }

  async addFolder(path: string, type: LibraryFolder['type']) {
    if (this.folders.some((f) => f.path === path)) return;
    this.folders.push({ id: uniqueId(), path, label: baseName(path) || path, type });
    await this.saveFolders();
    await this.rescan();
  }

  async removeFolder(id: string) {
    const f = this.folders.find((x) => x.id === id);
    if (!f) return;
    this.folders = this.folders.filter((x) => x.id !== id);
    this.items = this.items.filter((i) => !i.path.startsWith(f.path));
    await Promise.all([this.saveFolders(), this.saveItems()]);
    this.notify();
  }

  async rescan() {
    const known = new Map(this.items.map((i) => [i.path, i]));
    const next: MediaItem[] = [];
    for (const folder of this.folders) {
      let files: { path: string; size: number; mtime: number }[] = [];
      try {
        files = await this.fs.listMediaFiles(folder.path);
      } catch {
        continue;
      }
      for (const f of files) {
        const type = detectMediaType(f.path);
        if (!type) continue;
        const prev = known.get(f.path);
        next.push({
          id: prev?.id ?? uniqueId(),
          type,
          title: prev?.title ?? baseName(f.path).replace(/\.[^.]+$/, ''),
          artist: prev?.artist,
          album: prev?.album,
          genre: prev?.genre,
          year: prev?.year,
          duration: prev?.duration,
          size: f.size,
          width: prev?.width,
          height: prev?.height,
          format: prev?.format ?? f.path.split('.').pop()?.toUpperCase(),
          artwork: prev?.artwork,
          path: f.path,
          addedAt: prev?.addedAt ?? f.mtime,
        });
      }
    }
    this.items = next;
    if (this.metadata && next.length) {
      try {
        this.items = await this.metadata.enrich(next);
      } catch {
        this.items = next;
      }
    }
    await this.saveItems();
    this.notify();
  }

  async validate(): Promise<MediaItem[]> {
    const missing: MediaItem[] = [];
    const valid: MediaItem[] = [];
    for (const item of this.items) {
      if (await this.fs.exists(item.path)) valid.push(item);
      else missing.push(item);
    }
    if (missing.length) {
      this.items = valid;
      await this.saveItems();
      this.notify();
    }
    return missing;
  }

  async updateItem(id: string, patch: Partial<MediaItem>) {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx === -1) return;
    this.items[idx] = { ...this.items[idx], ...patch };
    await this.saveItems();
    this.notify();
  }

  subscribe(fn: (items: MediaItem[], folders: LibraryFolder[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.getAll(), this.getFolders());
    return () => this.listeners.delete(fn);
  }

  private async saveFolders() {
    await this.storage.set(storageKeys.libraryFolders, this.folders);
  }

  private async saveItems() {
    await this.storage.set(storageKeys.libraryItems, this.items);
  }

  private notify() {
    for (const fn of this.listeners) fn(this.getAll(), this.getFolders());
  }
}
