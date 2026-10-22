import { videoExtensions } from '@shared';

/**
 * Video extensions the shared list does not know about.
 *
 * `shared-core` is compiled into the desktop app as well, so it cannot be edited
 * from here; the supplement lives in the mobile app and is merged into the
 * mobile-side checks.
 *
 * `t` is the one that matters in practice: MPEG transport streams are routinely
 * dumped with a bare `.t` extension (satellite/set-top captures), and MediaStore
 * will not index that extension at all — not even when a scan is requested — so
 * such a file never appears in the library and cannot be opened by anyone without
 * "All files access". `m2t` and `mp2` are the other two transport/elementary
 * variants seen on real storage cards.
 */
export const EXTRA_VIDEO_EXTENSIONS: readonly string[] = ['t', 'm2t', 'mp2'];

const EXTRA_SET = new Set<string>(EXTRA_VIDEO_EXTENSIONS);
const SHARED_SET = new Set<string>(videoExtensions.map((e) => e.toLowerCase()));

/** True when either list recognises the extension as a video one. */
export function isVideoExtension(ext: string): boolean {
  const e = ext.toLowerCase();
  return SHARED_SET.has(e) || EXTRA_SET.has(e);
}