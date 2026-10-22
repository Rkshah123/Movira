import type { MediaItem, RecentEntry, PlaybackSettings } from './types';
import { defaultSettings } from './types';
import type { StorageAdapter } from './storage';
import { storageKeys } from './storage';

/**
 * Privacy mode (hard requirement): Movira must never persist watch history.
 * Any history payload left on disk by an older version is deleted at startup,
 * and recordPlay() is a no-op kept for API compatibility.
 */
export class UserDataService {
  /** Kept for API compatibility; watch history is never persisted. */
  private favorites: MediaItem[] = [];
  private settings: PlaybackSettings = { ...defaultSettings };
  private resumePositions: Record<string, { position: number; duration: number }> = {};
  private listeners = new Set<() => void>();

  constructor(private storage: StorageAdapter) {}

  async init() {
    const [f, s, r] = await Promise.all([
      this.storage.get(storageKeys.favorites),
      this.storage.get(storageKeys.settings),
      this.storage.get(storageKeys.resume),
    ]);
    // Privacy: wipe any watch history written by an older version.
    await this.storage.delete(storageKeys.history);
    if (Array.isArray(f)) this.favorites = f as MediaItem[];
    if (s && typeof s === 'object') this.settings = { ...defaultSettings, ...(s as object) } as PlaybackSettings;
    if (r && typeof r === 'object') this.resumePositions = r as typeof this.resumePositions;
    this.notify();
  }

  getHistory(): RecentEntry[] {
    return [];
  }

  /** No-op: recording play history is permanently disabled. */
  async recordPlay(_item: MediaItem, _position: number) {
    // Privacy mode — nothing is written anywhere.
  }

  /** No-op: history is never persisted. */
  async removeHistoryItem(_itemId: string) {
    // Privacy mode — nothing is written anywhere.
  }

  /** No-op: history is never persisted. */
  async clearHistory() {
    // Privacy mode — nothing is written anywhere.
  }

  getFavorites(): MediaItem[] {
    return [...this.favorites];
  }

  isFavorite(itemId: string): boolean {
    return this.favorites.some((f) => f.id === itemId);
  }

  async toggleFavorite(item: MediaItem): Promise<boolean> {
    if (this.isFavorite(item.id)) {
      this.favorites = this.favorites.filter((f) => f.id !== item.id);
      await this.storage.set(storageKeys.favorites, this.favorites);
      this.notify();
      return false;
    }
    this.favorites = [item, ...this.favorites];
    await this.storage.set(storageKeys.favorites, this.favorites);
    this.notify();
    return true;
  }

  async clearFavorites() {
    this.favorites = [];
    await this.storage.set(storageKeys.favorites, this.favorites);
    this.notify();
  }

  getSettings(): PlaybackSettings {
    return { ...this.settings };
  }

  async updateSettings(patch: Partial<PlaybackSettings>) {
    this.settings = { ...this.settings, ...patch };
    await this.storage.set(storageKeys.settings, this.settings);
    this.notify();
  }

  getResumePosition(itemId: string): number {
    return this.resumePositions[itemId]?.position ?? 0;
  }

  /** Drop the saved position for one item (fire-and-forget friendly).
   *  Used by the desktop Stop button: Stop means "watch from the beginning
   *  next time", unlike Pause which keeps the position. */
  async clearResumePosition(itemId: string) {
    if (!(itemId in this.resumePositions)) return;
    delete this.resumePositions[itemId];
    await this.storage.set(storageKeys.resume, this.resumePositions);
  }

  async saveResumePosition(itemId: string, position: number, duration: number) {
    if (!isFinite(position) || position <= 0) return;
    if (duration && position / duration > 0.95) {
      delete this.resumePositions[itemId];
    } else {
      this.resumePositions[itemId] = { position, duration };
    }
    await this.storage.set(storageKeys.resume, this.resumePositions);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }
}
