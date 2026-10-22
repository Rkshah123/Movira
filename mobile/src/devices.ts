import { readDir, exists as fsExists, getFSInfo } from '@dr.pogodin/react-native-fs';

export { fsExists as exists };
import type { ReadDirResItemT } from '@dr.pogodin/react-native-fs';
import { audioExtensions, videoExtensions } from '@shared';
import { EXTRA_VIDEO_EXTENSIONS } from './mediaExtensions';

/**
 * Device storage discovery + recursive media scanning for Android.
 *
 * `MediaLibraryService` only walks the folders it is given, so this module
 * supplies the real Android roots (internal shared storage plus any removable
 * volume) and a bounded recursive walker. Nothing here can throw at startup: a
 * permission denial or a missing volume degrades to "that storage is absent".
 */

export interface DeviceStorage {
  /** Stable key used for the library folder id. */
  id: string;
  label: string;
  path: string;
  /** 'internal' | 'sd' — drives the Browse tile icon. */
  kind: 'internal' | 'sd';
  freeSpace?: number;
  totalSpace?: number;
}

/** Candidate Android storage roots, in the order the references show them. */
const INTERNAL_CANDIDATES = [
  '/storage/emulated/0',
  '/sdcard',
];

const REMOVABLE_CANDIDATES = [
  '/storage/0000-1111',
  '/storage/1234-5678',
  '/storage/ABCD-1234',
  '/storage/1234-ABCD',
];

async function isDirectory(path: string): Promise<boolean> {
  try {
    const entries = await readDir(path);
    return Array.isArray(entries);
  } catch {
    return false;
  }
}

async function probe(path: string): Promise<boolean> {
  try {
    await fsExists(path);
    return await isDirectory(path);
  } catch {
    return false;
  }
}

/** Removable volumes appear as `/storage/XXXX-XXXX`; enumerate the parent. */
async function enumerateRemovable(): Promise<string[]> {
  const found: string[] = [];
  try {
    const entries = await readDir('/storage');
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'emulated' || e.name === 'self' || e.name === 'container') continue;
      if (/^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/.test(e.name)) found.push(e.path);
    }
  } catch {
    // /storage not readable — fall back to the well-known names below.
  }
  for (const c of REMOVABLE_CANDIDATES) {
    if (!found.includes(c) && (await probe(c))) found.push(c);
  }
  return found;
}

/** All readable storages on the device, internal first. */
export async function listDeviceStorages(): Promise<DeviceStorage[]> {
  const out: DeviceStorage[] = [];

  let internal: string | null = null;
  for (const c of INTERNAL_CANDIDATES) {
    if (await probe(c)) {
      internal = c;
      break;
    }
  }
  if (internal) {
    out.push({ id: 'internal', label: 'Internal Memory', path: internal, kind: 'internal' });
  }

  for (const path of await enumerateRemovable()) {
    const name = path.split('/').filter(Boolean).pop() ?? 'SD Card';
    out.push({ id: `sd-${name}`, label: name, path, kind: 'sd' });
  }
  return out;
}

export async function storageFreeSpace(path: string): Promise<{ free: number; total: number } | null> {
  try {
    const info = await getFSInfo();
    return { free: info.freeSpace, total: info.totalSpace };
  } catch {
    void path;
    return null;
  }
}

export interface ScannedEntry {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

const MEDIA_EXTS = new Set<string>([...audioExtensions, ...videoExtensions, ...EXTRA_VIDEO_EXTENSIONS]);

export function isMediaFile(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return MEDIA_EXTS.has(ext);
}

export interface FolderNode {
  path: string;
  name: string;
  /** Media files directly inside this folder. */
  files: ScannedEntry[];
  /** Immediate sub-folders (media files are not counted in here). */
  subfolders: { path: string; name: string }[];
  /** Why listing failed, when it did. Empty folders are otherwise indistinguishable. */
  error?: string;
}

/** List one directory: its media files and its sub-folders. Never throws. */
export async function readFolder(path: string): Promise<FolderNode> {
  const name = path.split('/').filter(Boolean).pop() ?? path;
  try {
    const entries: ReadDirResItemT[] = await readDir(path);
    const files: ScannedEntry[] = [];
    const subfolders: { path: string; name: string }[] = [];
    for (const e of entries) {
      // Hidden entries (.thumbnails, .trash) never belong in a media library.
      if (e.name.startsWith('.')) continue;
      let dir = false;
      try {
        dir = e.isDirectory();
      } catch {
        dir = false;
      }
      if (dir) {
        subfolders.push({ path: e.path, name: e.name });
      } else if (isMediaFile(e.name)) {
        files.push({
          path: e.path,
          name: e.name,
          size: e.size,
          mtime: e.mtime ? new Date(e.mtime).getTime() : 0,
        });
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    subfolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { path, name, files, subfolders };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`Movira: could not list ${path}: ${message}`);
    return { path, name, files: [], subfolders: [], error: message };
  }
}

/**
 * Recursively collect media files under a folder.
 *
 * Bounded on purpose: Android media libraries routinely contain hundreds of
 * thousands of entries once `/Android/data` is included, and an unbounded walk
 * on the main JS thread would freeze the UI. `maxDepth` keeps a scan quick, and
 * the cap stops a pathological tree from running forever.
 */
export async function scanFolderRecursive(
  root: string,
  maxDepth = 6,
  maxEntries = 20000
): Promise<{ path: string; size: number; mtime: number }[]> {
  const out: { path: string; size: number; mtime: number }[] = [];
  const skipDirs = new Set(['Android/data', 'Android/obb', '.thumbnails', 'lost+found']);
  let seen = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || out.length >= maxEntries) return;
    let entries: ReadDirResItemT[];
    try {
      entries = await readDir(dir);
    } catch (e) {
      console.warn(
        `Movira: scan skipped ${dir}: ${e instanceof Error ? e.message : String(e)}`
      );
      return;
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      seen += 1;
      if (seen > maxEntries * 4) return;
      if (e.name.startsWith('.')) continue;
      let dir = false;
      try {
        dir = e.isDirectory();
      } catch {
        dir = false;
      }
      if (dir) {
        // Android app sandboxes hold no user media and are unreadable without
        // per-app consent — walking them only wastes time and always fails.
        // Matched on the full path: the folder is called "data"/"obb", the
        // "Android/" prefix lives on the parent.
        if (e.path.endsWith('/Android/data') || e.path.endsWith('/Android/obb')) continue;
        subdirs.push(e.path);
      } else if (isMediaFile(e.name)) {
        out.push({
          path: e.path,
          size: e.size,
          mtime: e.mtime ? new Date(e.mtime).getTime() : 0,
        });
        if (out.length >= maxEntries) return;
      }
    }
    for (const d of subdirs) {
      await walk(d, depth + 1);
      if (out.length >= maxEntries) return;
    }
  };

  await walk(root, 0);
  return out;
}