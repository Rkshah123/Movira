import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MediaItem } from '@shared';
import { itemFromDocumentPicker } from './services';
import { sameFile } from './sameFile';
import { resolveContentUri } from './system';

/**
 * Files the user picks explicitly with the document picker.
 *
 * `MediaLibraryService` rebuilds its list purely from the folders it scans, so
 * anything chosen through the picker would vanish on the next refresh. These
 * live in a separate key and are merged into the library view, which keeps the
 * shared core (compiled into the desktop app) untouched.
 */
const KEY = 'movira:pickedItems';

type Listener = (items: MediaItem[]) => void;

class PickedStore {
  private items: MediaItem[] = [];
  private listeners = new Set<Listener>();

  async load(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.items = parsed as MediaItem[];
      }
    } catch {
      this.items = [];
    }
    this.notify();
  }

  getAll(): MediaItem[] {
    return [...this.items];
  }

  /**
   * Adds picker URIs, skipping anything already known.
   *
   * `kind` is the MIME filter the picker was opened with (audio panel →
   * 'audio'); Android's content:// URIs are frequently extension-less, so it
   * is the classification of last resort.
   *
   * `known` describes everything already in the library — both the scanned
   * files and the previously picked ones. It is matched on the real filesystem
   * path first and on title plus byte size second, because a picked item's own
   * `path` is a content:// URI and can never equal the `/storage/...` path the
   * scanner recorded for the very same file. Comparing those two strings alone
   * let one file appear in the library several times over.
   */
  async add(
    uris: string[],
    known: { paths: Set<string>; items: MediaItem[] },
    kind?: 'audio' | 'video'
  ): Promise<MediaItem[]> {
    const added: MediaItem[] = [];
    // Also the picks made during this same call, so selecting the same file
    // twice in one go cannot add it twice.
    const considered: MediaItem[] = [...known.items];
    for (const uri of uris) {
      // The picker hands back bare content:// URIs — ask Android what they are
      // before classifying, or an id like ".../audio/media/42" gets dropped.
      const info = await resolveContentUri(uri);
      const item = itemFromDocumentPicker({
        uri,
        name: info?.name ?? undefined,
        mime: info?.mimeType ?? undefined,
        // Carrying the real byte count through is what lets an identical file
        // be recognised, and it is also why a picked row can show its size
        // instead of a bare "Video" where a scanned row shows "31 MB".
        size: info?.size ?? undefined,
        fallbackType: kind,
      });
      if (!item) continue;
      if (known.paths.has(item.path)) continue;
      if (considered.some((i) => sameFile(i, item, info?.path))) continue;
      considered.push(item);
      added.push(item);
    }
    if (!added.length) return [];
    this.items = [...added, ...this.items];
    await this.persist();
    // Without this the list is persisted but the screens never learn about it:
    // the picks only appeared after an app restart.
    this.notify();
    return added;
  }

  /**
   * Forgets picked entries that the library scan has since found on its own.
   *
   * The merge already hides such a pair, but that only tidies the view — the
   * stale entry stays in storage forever and can resurface the moment it stops
   * matching (its sibling is renamed, say). Removing it also repairs libraries
   * that were built before picks carried a byte size, which is exactly how the
   * duplicate entries got there: they predate any way to compare them, so their
   * stored content:// URIs are re-resolved here to recover the real path.
   */
  async pruneDuplicates(scanned: MediaItem[]): Promise<void> {
    if (!this.items.length || !scanned.length) return;
    const scannedPaths = new Set(scanned.map((s) => s.path));
    const keep: MediaItem[] = [];
    for (const item of this.items) {
      // Only a pick can duplicate a scanned entry, so this only ever resolves
      // the handful of URIs the user explicitly chose.
      const info = await resolveContentUri(item.path);
      const realPath = info?.path ?? null;
      const duplicate =
        (realPath != null && scannedPaths.has(realPath)) ||
        (info?.size != null &&
          scanned.some(
            (s) => s.type === item.type && s.title === item.title && s.size === info.size
          ));
      if (!duplicate) keep.push(item);
    }
    if (keep.length === this.items.length) return;
    this.items = keep;
    await this.persist();
    this.notify();
  }

  async remove(path: string): Promise<void> {
    const next = this.items.filter((i) => i.path !== path);
    if (next.length === this.items.length) return;
    this.items = next;
    await this.persist();
    this.notify();
  }

  /** Retitles a picked item in place (scanned files go through the library). */
  async rename(id: string, title: string): Promise<void> {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx === -1 || !title.trim()) return;
    const next = [...this.items];
    next[idx] = { ...next[idx], title: title.trim() };
    this.items = next;
    await this.persist();
    this.notify();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.getAll());
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify() {
    for (const fn of this.listeners) fn(this.getAll());
  }

  private async persist() {
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify(this.items));
    } catch {
      // Best-effort: the picked file is still playable this session.
    }
  }
}

export const pickedStore = new PickedStore();