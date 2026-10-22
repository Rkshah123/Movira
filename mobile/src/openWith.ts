import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { MediaItem } from '@shared';
import { itemFromDocumentPicker } from './services';
import { pickedStore } from './picked';
import { sameFile } from './sameFile';
import {
  consumeLaunchMedia,
  logToAndroid,
  onExternalMediaOpen,
  resolveContentUri,
  takePersistableMediaAccess,
  type ExternalMedia,
} from './system';

/**
 * "Open with" hand-off.
 *
 * When another app — a file manager, Downloads, a browser, a messaging app —
 * hands Movira a file, Android starts `MainActivity` with an ACTION_VIEW intent
 * whose data is a `content://` URI. There is no filesystem path anywhere in that
 * intent, so the file can only be reached through the ContentResolver.
 *
 * Two delivery paths have to be covered, and they behave differently:
 *
 *  - COLD START. The activity was created for this file. The intent is read once
 *    through `consumeLaunchMedia`, which also clears it — otherwise every later
 *    re-read (a JS reload, a React remount, an activity recreation after a
 *    configuration change) would drag the player back to the same file.
 *
 *  - WARM START. Movira is already running and the new intent arrives at
 *    `onNewIntent`, because the activity is declared `singleTask`. That arrives
 *    as a device event from the native module rather than through React Native's
 *    Linking, which stopped listening for new intents in 0.85 — see
 *    `onExternalMediaOpen`.
 *
 * Both funnel through the same routine, so the resulting item behaves identically
 * whichever way the file arrived.
 */

/** Everything known about an opened file, from either delivery path. */
interface OpenedFile extends ExternalMedia {
  item: MediaItem;
}

/** Only real documents are opened; anything else is ignored. */
function isOpenableMediaUri(uri: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri)?.[1]?.toLowerCase();
  return scheme === 'content' || scheme === 'file';
}

/**
 * How long a URI counts as "already handled".
 *
 * The same intent really can be reported twice — a cold start is read by the
 * native side AND echoed as a device event, and both must not open the file
 * twice. That overlap is well under a second, so a short window covers it.
 *
 * It has to expire. This used to be a plain Set that lived as long as the screen
 * did, so opening the SAME file again from the file manager while Movira was
 * already running did nothing at all: the second request matched an entry that was
 * only ever there to guard against a duplicate delivery.
 */
const HANDLED_WINDOW_MS = 3000;

/**
 * Finds the library entry for a file, if the library already has it.
 *
 * Identity is decided by `sameFile`, which is shared with the library merge and
 * with the picker's own dedupe so all three agree on what counts as a duplicate.
 *
 * Returns null — never a guess — when nothing matches.
 */
function findLibraryEntry(
  library: MediaItem[] | undefined,
  item: MediaItem,
  path: string | null | undefined
): MediaItem | null {
  if (!library?.length) return null;
  return library.find((m) => sameFile(m, item, path)) ?? null;
}

export function useExternalMediaOpen(opts: {
  /**
   * The intent may only be acted on once the services exist — playing goes
   * through the engine, which is built during startup.
   */
  ready: boolean;
  /**
   * True once the library has finished its first scan. Until then the library is
   * incomplete, so "is this file already in it?" cannot be answered.
   */
  scanned: boolean;
  /**
   * Current library. Held as a ref rather than as a dependency: a rescan hands
   * out a new array constantly, and re-running the effect on every scan would
   * re-read the launch intent each time.
   */
  libraryRef: RefObject<MediaItem[]>;
  onOpen: (item: MediaItem) => void | Promise<void>;
}): void {
  const { ready, scanned, libraryRef } = opts;
  const onOpenRef = useRef(opts.onOpen);
  onOpenRef.current = opts.onOpen;

  /** URIs already played, so an intent reported twice is only ever opened once. */
  const handled = useRef<Map<string, number>>(new Map());

  /**
   * Files that were opened while the library was still scanning, so it could not
   * yet say whether they belong in the library as well.
   *
   * They are played straight away — nobody should wait on a storage scan to hear
   * their file — and only the decision to ADD them is deferred. Without this,
   * every "Open with" during startup appended a duplicate entry to a library
   * that already contained the file.
   */
  const awaitingScan = useRef<OpenedFile[]>([]);
  const scannedRef = useRef(scanned);
  scannedRef.current = scanned;

  const persist = useCallback(
    async (file: OpenedFile) => {
      const existing = findLibraryEntry(libraryRef.current, file.item, file.path);
      // Already indexed: nothing to add, and playback can use the library entry.
      if (existing) return existing;
      // Keep the file so it stays playable later. The grant that came with the
      // intent only lasts as long as this task, so persistable access is
      // requested before storing it; when the sender granted none the file still
      // plays for this session.
      void takePersistableMediaAccess(file.uri);
      const items = libraryRef.current ?? [];
      const added = await pickedStore.add(
        [file.uri],
        { paths: new Set(items.map((m) => m.path)), items }
      );
      return added[0] ?? file.item;
    },
    [libraryRef]
  );

  const open = useCallback(
    async (uri: string, hint?: ExternalMedia) => {
      if (!isOpenableMediaUri(uri)) return;
      const now = Date.now();
      const seenAt = handled.current.get(uri);
      if (seenAt != null && now - seenAt < HANDLED_WINDOW_MS) return;
      handled.current.set(uri, now);

      try {
        const info = await resolveContentUri(uri);
        // The native side already read these for a cold start, so prefer them and
        // only fall back to a second ContentResolver round trip.
        const name = hint?.name ?? info?.name ?? undefined;
        const mime = hint?.mimeType ?? info?.mimeType ?? undefined;
        const size = hint?.size ?? info?.size ?? undefined;
        const path = hint?.path ?? info?.path ?? null;

        const item = itemFromDocumentPicker({ uri, name, mime, size });
        if (!item) {
          // No display name, no MIME and no usable extension — nothing to classify
          // the file as. Playing it anyway would guess between audio and video.
          logToAndroid(`openWith: unclassifiable file (mime=${mime ?? 'none'})`);
          return;
        }

        const file: OpenedFile = { ...hint, uri, name, mimeType: mime, size, path, item };

        if (!scannedRef.current) {
          // The library is mid-scan, so it cannot be consulted yet. Play now,
          // settle the library question once the scan lands.
          awaitingScan.current.push(file);
          await onOpenRef.current(item);
          return;
        }

        await onOpenRef.current(await persist(file));
      } catch (e) {
        logToAndroid(`openWith failed: ${String(e)}`);
      }
    },
    [libraryRef, onOpenRef, persist]
  );

  // Drain the deferred files once the library finally knows its full contents.
  useEffect(() => {
    if (!scanned || awaitingScan.current.length === 0) return;
    const queue = awaitingScan.current;
    awaitingScan.current = [];
    void (async () => {
      for (const file of queue) {
        try {
          await persist(file);
        } catch (e) {
          logToAndroid(`openWith persist failed: ${String(e)}`);
        }
      }
    })();
  }, [scanned, persist]);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;

    void (async () => {
      const launch = await consumeLaunchMedia();
      if (disposed || !launch?.uri) return;
      await open(launch.uri, launch);
    })();

    const unsubscribe = onExternalMediaOpen((media) => {
      if (disposed || !media?.uri) return;
      void open(media.uri, media);
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [ready, open]);
}