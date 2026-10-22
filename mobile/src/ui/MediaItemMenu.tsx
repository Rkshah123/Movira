import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
} from 'react-native';
import { formatSize, formatTime, type MediaItem } from '@shared';
import { useAppState } from '../state/AppContext';
import { useTheme } from '../theme';
import ActionSheet from './ActionSheet';
import ChoiceDialog, { ConfirmDialog, TextPromptDialog } from './ChoiceDialog';
import { pickedStore } from '../picked';
import { unlink, exists } from '@dr.pogodin/react-native-fs';
import { deleteContentUri, hasAllFilesAccess, openAllFilesAccessSettings, requestDeleteMedia } from '../system';

/**
 * Row-level "..." menu for a single video or audio file.
 *
 * The row itself keeps playing/opening its item; this menu is opened from the
 * row's own nested overflow button (`MediaRow.onOverflow`), which claims the
 * touch before the row's `onPress` can fire. Every sheet in here is a native
 * Modal with a dimmed backdrop, so:
 *
 *  - the menu is opaque (a real card over a scrim, never composited over the
 *    list), and
 *  - a single tap anywhere outside dismisses it immediately without the
 *    touch ever reaching the list underneath.
 *
 * Only actions Movira can actually perform are offered: play, queue, add to
 * playlist, inspect metadata, retitle the library entry, delete the file.
 */

type Stage = 'hidden' | 'root' | 'playlists' | 'newPlaylist' | 'info' | 'rename' | 'delete';

interface Target {
  item: MediaItem;
  /** The list the row belongs to, so Play starts at the right index. */
  list: MediaItem[];
}

const NEW_PLAYLIST = '__new_playlist__';

/**
 * Owns the open state of the per-row menu. Screens call `open(item, list)`
 * from the row's overflow button and render `node` once anywhere in their tree.
 */
export function useMediaItemMenu(): {
  open: (item: MediaItem, list: MediaItem[]) => void;
  node: React.ReactNode;
} {
  const [target, setTarget] = useState<Target | null>(null);
  const open = useCallback((item: MediaItem, list: MediaItem[]) => setTarget({ item, list }), []);
  const node = target ? <MediaItemMenu target={target} /> : null;
  return { open, node };
}

function MediaItemMenu({ target }: { target: Target }) {
  const t = useTheme();
  const app = useAppState();
  const [stage, setStage] = useState<Stage>('root');
  const [deleteError, setDeleteError] = useState<{ message: string; canGrant: boolean } | null>(null);
  const { item, list } = target;

  // Each open hands over a fresh target object: reset to the root sheet.
  useEffect(() => setStage('root'), [target]);

  const hide = useCallback(() => setStage('hidden'), []);

  const inLibrary = app.services.library.getAll().some((i) => i.id === item.id);

  /**
   * Removes the entry from Movira's own library.
   *
   * Deliberately separate from removing the file, and deliberately done even when
   * the file could not be deleted. The list is Movira's; a user who asked to
   * remove something must always end up with it gone from the list. Leaving it
   * behind because the FILE deletion failed made a stale entry impossible to
   * clear — the entry pointed at a file that was already gone, so deleting it
   * could never succeed and the row stayed for good.
   */
  const dropEntry = useCallback(async () => {
    await pickedStore.remove(item.path);
    if (inLibrary) await app.services.library.validate();
  }, [item.path, inLibrary, app]);

  const doDelete = useCallback(async () => {
    let failure: unknown = null;
    if (item.path.startsWith('content://')) {
      // Picker-added files live behind content:// URIs, which unlink() can never
      // touch. Delete through the ContentResolver instead.
      try {
        await deleteContentUri(item.path);
      } catch (e) {
        failure = e;
      }
    } else {
      const path = filesystemPathOf(item.path);
      let gone = false;
      try {
        // A file:// URI is not a path unlink() accepts — it resolves to a file
        // literally named "file:" — so it has to be unwrapped first. Without
        // this every file picked through a plain file manager failed to delete.
        await unlink(path);
        // unlink() RESOLVES EVEN WHEN NOTHING WAS DELETED.
        //
        // Its native implementation is:
        //
        //   deleteRecursive(file)   // java.io.File.delete() returns a boolean
        //   promise.resolve(null)   // ...and that boolean is discarded
        //
        // So a refusal from the platform comes back as success. Measured on this
        // device: deleting a file without "All files access" left the file on
        // disk, left the library entry in place, and reported nothing at all —
        // which is exactly the "delete does nothing" report. This function must
        // never take unlink() at its word: the only trustworthy signal is whether
        // the file is actually gone.
        gone = !(await exists(path));
      } catch (e) {
        // A file that is already gone is the outcome the user asked for.
        if (isMissingFile(e)) gone = true;
        else failure = e;
      }
      // Still here? The platform refused the unlink, which for media it almost
      // always will without "All files access". Rather than dead-ending, hand it
      // to Android's own delete prompt, where the user can approve the removal
      // once and it really happens.
      if (!gone && failure == null && !(await fileIsGone(path))) {
        gone = await requestDeleteMedia([path]);
      }
      if (!gone && failure == null) failure = new DeleteDidNotHappen();
    }
    // Either way the entry leaves the library.
    await dropEntry();
    if (failure == null) return;
    setDeleteError(await describeDeleteFailure(item.title, failure));
  }, [item, dropEntry]);

  const closeDeleteError = useCallback(() => setDeleteError(null), []);

  const doRename = useCallback(
    (name: string) => {
      const title = name.trim();
      if (!title || title === item.title) return;
      if (inLibrary) void app.services.library.updateItem(item.id, { title });
      else void pickedStore.rename(item.id, title);
    },
    [item, inLibrary, app]
  );

  const infoRows = buildInfoRows(item);

  return (
    <>
      <ActionSheet
        visible={stage === 'root'}
        title={item.title}
        onDismiss={hide}
        actions={[
          {
            label: 'Play',
            icon: 'play',
            onPress: () => {
              const i = list.indexOf(item);
              app.play(list, i < 0 ? 0 : i);
            },
          },
          { label: 'Add to Playlist', icon: 'playlist', onPress: () => setStage('playlists') },
          { label: 'Add to Queue', icon: 'queue', onPress: () => app.services.player.addToQueue([item]) },
          { label: 'File Information', icon: 'info', onPress: () => setStage('info') },
          { label: 'Rename', icon: 'edit', onPress: () => setStage('rename') },
          { label: 'Delete', icon: 'trash', destructive: true, onPress: () => setStage('delete') },
        ]}
      />

      <ChoiceDialog
        visible={stage === 'playlists'}
        title="Add to playlist"
        choices={[
          ...app.playlists.map((p) => ({ label: p.name, value: p.id })),
          { label: 'New playlist…', value: NEW_PLAYLIST },
        ]}
        selected=""
        // The picker navigates to the rename-style prompt for "New playlist",
        // so it must not run its own close (which would win the race).
        closeOnSelect={false}
        onSelect={(value) => {
          if (value === NEW_PLAYLIST) {
            setStage('newPlaylist');
            return;
          }
          void app.services.playlists.addMedia(value, [item]);
          hide();
        }}
        onDismiss={hide}
      />

      <TextPromptDialog
        visible={stage === 'newPlaylist'}
        title="New playlist"
        placeholder="Playlist name"
        onCancel={hide}
        onSubmit={(name) => {
          if (!name) return;
          void (async () => {
            const pl = await app.createPlaylist(name);
            await app.services.playlists.addMedia(pl.id, [item]);
          })();
        }}
      />

      <FileInformationDialog visible={stage === 'info'} rows={infoRows} onClose={hide} />

      <TextPromptDialog
        visible={stage === 'rename'}
        title="Rename"
        placeholder="Title"
        initial={item.title}
        onCancel={hide}
        onSubmit={doRename}
      />

      <ConfirmDialog
        visible={stage === 'delete'}
        title="Delete file?"
        message={`"${item.title}" will be permanently removed from this device.`}
        confirmLabel="Delete"
        onCancel={hide}
        onConfirm={() => {
          hide();
          void doDelete();
        }}
      />

      {/* Reported in Movira's own dialog rather than a system alert: every other
          dialog in the app is themed, and a grey platform popup appearing after
          a themed confirmation reads as a different app entirely. */}
      <ConfirmDialog
        visible={deleteError != null}
        title="Could not delete"
        message={deleteError?.message ?? ''}
        confirmLabel={deleteError?.canGrant ? 'Grant access' : 'OK'}
        cancelLabel={deleteError?.canGrant ? 'Not now' : undefined}
        onCancel={closeDeleteError}
        onConfirm={() => {
          if (deleteError?.canGrant) void openAllFilesAccessSettings();
          closeDeleteError();
        }}
      />
    </>
  );
}

/**
 * unlink() reported success but the file is still on the device.
 *
 * Carries a message rather than a code, because it reaches the user through
 * `describeDeleteFailure`.
 */
class DeleteDidNotHappen extends Error {
  constructor() {
    super('the file is still on the device');
  }
}

/** Whether a path is really gone, treating an unreadable path as still present. */
async function fileIsGone(path: string): Promise<boolean> {
  try {
    return !(await exists(path));
  } catch {
    return false;
  }
}

/** The bare filesystem path behind an entry, ready for unlink(). */
function filesystemPathOf(path: string): string {
  if (!path.startsWith('file://')) return path;
  try {
    return decodeURIComponent(path.slice('file://'.length)) || path;
  } catch {
    return path;
  }
}

/** Whether a failed delete just means the file is not there any more. */
function isMissingFile(error: unknown): boolean {
  const text = String((error as { message?: string })?.message ?? error).toLowerCase();
  return (
    text.includes('enoent') ||
    text.includes('no such file') ||
    text.includes('does not exist') ||
    text.includes('not found')
  );
}

/**
 * Why a file could not be deleted, and what the user can do about it.
 *
 * The wording matters here: the item is still in the library, and saying
 * otherwise would only move the confusion to the next refresh. It is still there
 * because the library is rebuilt by scanning the folders it watches, so dropping
 * the entry would not stick — the file is on disk, so the next scan finds it
 * again. The real fix is to delete the file, and deleting it needs "All files
 * access".
 *
 * That case gets a route to the fix rather than an instruction to go and find
 * it: the same native helper the playback error uses takes the user straight to
 * Movira's page in Android settings.
 */
async function describeDeleteFailure(
  title: string,
  failure: unknown
): Promise<{ message: string; canGrant: boolean }> {
  let canGrant = false;
  try {
    canGrant = Platform.OS === 'android' && !(await hasAllFilesAccess());
  } catch {
    // Probe failed — do not claim the user can fix it.
  }
  if (canGrant) {
    return {
      message:
        `"${title}" could not be deleted because Movira is not allowed to delete files from this device.\n\n` +
        'The file is still on your phone and still listed in the library. Grant Movira ' +
        '"All files access", then delete it again.',
      canGrant: true,
    };
  }
  return {
    message:
      `"${title}" could not be deleted — ` +
      `${(failure as { message?: string })?.message ?? String(failure)}. ` +
      'The file is still on your phone and still listed in the library.',
    canGrant: false,
  };
}

/** Metadata read-out: only the fields that actually carry a value. */
function buildInfoRows(item: MediaItem): [string, string][] {
  const rows: [string, string][] = [['Type', item.type === 'video' ? 'Video' : 'Audio']];
  if (item.format) rows.push(['Format', item.format]);
  if (item.duration) rows.push(['Duration', formatTime(item.duration)]);
  if (item.size) rows.push(['Size', formatSize(item.size)]);
  if (item.width && item.height) rows.push(['Resolution', `${item.width} × ${item.height}`]);
  if (item.artist) rows.push(['Artist', item.artist]);
  if (item.album) rows.push(['Album', item.album]);
  if (item.year) rows.push(['Year', String(item.year)]);
  rows.push(['Added', new Date(item.addedAt).toLocaleDateString()]);
  rows.push(['Path', item.path]);
  return rows;
}

/**
 * Raised-card metadata dialog. Same treatment as the other dialogs: a scrim
 * that swallows a single outside tap, over an opaque card.
 */
function FileInformationDialog({
  visible,
  rows,
  onClose,
}: {
  visible: boolean;
  rows: [string, string][];
  onClose: () => void;
}) {
  const t = useTheme();
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <TouchableOpacity
        activeOpacity={1}
        style={[styles.backdrop, { backgroundColor: t.overlay }]}
        onPress={onClose}
      >
        <View style={[styles.card, { backgroundColor: t.bg3, shadowColor: t.shadow }]}>
          <Text style={[styles.cardTitle, { color: t.text }]} numberOfLines={1}>
            File information
          </Text>
          <ScrollView bounces={false} style={styles.infoList}>
            {rows.map(([key, value]) => (
              <View
                key={key}
                style={[styles.infoRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }]}
              >
                <Text style={[styles.infoKey, { color: t.dim }]}>{key}</Text>
                <Text style={[styles.infoValue, { color: t.text }]} numberOfLines={3}>
                  {value}
                </Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.infoActions}>
            <TouchableOpacity accessibilityRole="button" style={styles.infoButton} onPress={onClose}>
              <Text style={[styles.infoButtonText, { color: t.accent }]}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 6,
    paddingVertical: 6,
    elevation: 12,
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  cardTitle: { fontSize: 17, paddingHorizontal: 22, paddingTop: 16, paddingBottom: 12 },
  infoList: { maxHeight: 340 },
  infoRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 10,
    alignItems: 'flex-start',
  },
  infoKey: { width: 78, fontSize: 13 },
  infoValue: { flex: 1, fontSize: 13.5, textAlign: 'right' },
  infoActions: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 10, paddingTop: 4 },
  infoButton: { paddingHorizontal: 16, paddingVertical: 12 },
  infoButtonText: { fontSize: 15, fontWeight: '500' },
});
