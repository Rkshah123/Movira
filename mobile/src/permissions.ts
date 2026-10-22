import { Linking, PermissionsAndroid, Platform } from 'react-native';
import type { Permission } from 'react-native';

/**
 * Runtime media access.
 *
 * The manifest declares `READ_MEDIA_AUDIO`/`READ_MEDIA_VIDEO`, but declaring is
 * not granting: on Android 13+ nothing may touch a media file until the user
 * answers the runtime dialog, and until they do the FUSE layer silently hides
 * those files from `readDir`. A recursive scan then reports "0 entries" for a
 * folder that visibly contains media, which is exactly what happens if the
 * request is never made.
 *
 * Two levels are needed:
 *
 *  - the granular `READ_MEDIA_*` permissions cover the standard media dirs
 *    (Movies, Music, DCIM, Download) and are requested with a normal dialog;
 *  - `MANAGE_EXTERNAL_STORAGE` ("All files access") additionally covers arbitrary
 *    user folders such as Documents and removable storage, which the folder
 *    browser offers. Android will not grant it via `PermissionsAndroid` — it
 *    has to be toggled in Settings, so it is surfaced as a deep link.
 */

const MANAGE_EXTERNAL_STORAGE = 'android.permission.MANAGE_EXTERNAL_STORAGE' as Permission;

export interface MediaAccess {
  /** `READ_MEDIA_*` (API 33+) or `READ_EXTERNAL_STORAGE` is granted. */
  media: boolean;
  /** "All files access" is granted. */
  allFiles: boolean;
}

const READ_MEDIA_PERMS: Permission[] = [
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.READ_MEDIA_VIDEO',
];

/** True when the OS will hand this app media files inside a shared folder. */
export async function checkMediaAccess(): Promise<MediaAccess> {
  if (Platform.OS !== 'android') return { media: true, allFiles: true };
  try {
    const wanted: Permission[] =
      Platform.Version >= 33
        ? READ_MEDIA_PERMS
        : ['android.permission.READ_EXTERNAL_STORAGE'];
    const results = await PermissionsAndroid.requestMultiple(wanted);
    const media = wanted.every((p) => results[p] === PermissionsAndroid.RESULTS.GRANTED);
    const allFiles = await PermissionsAndroid.check(MANAGE_EXTERNAL_STORAGE);
    return { media, allFiles };
  } catch (e) {
    console.warn('Movira: permission check failed', e);
    return { media: false, allFiles: false };
  }
}

/** Ask for the media permissions, then report what we ended up with. */
export async function requestMediaAccess(): Promise<MediaAccess> {
  if (Platform.OS !== 'android') return { media: true, allFiles: true };
  try {
    const wanted: Permission[] =
      Platform.Version >= 33
        ? [...READ_MEDIA_PERMS, 'android.permission.POST_NOTIFICATIONS']
        : ['android.permission.READ_EXTERNAL_STORAGE'];
    const results = await PermissionsAndroid.requestMultiple(wanted);
    const mediaOk =
      Platform.Version >= 33
        ? READ_MEDIA_PERMS.every((p) => results[p] === PermissionsAndroid.RESULTS.GRANTED)
        : results['android.permission.READ_EXTERNAL_STORAGE'] === PermissionsAndroid.RESULTS.GRANTED;

    let allFiles = false;
    try {
      allFiles = await PermissionsAndroid.check(MANAGE_EXTERNAL_STORAGE);
    } catch {
      allFiles = false;
    }
    return { media: mediaOk, allFiles };
  } catch (e) {
    console.warn('Movira: permission request failed', e);
    return { media: false, allFiles: false };
  }
}

/**
 * Deep-link to the "All files access" toggle. Android exposes no runtime
 * request for it, so the user has to flip it themselves; we return to the app
 * afterwards and the caller re-checks on resume.
 */
export async function openAllFilesAccessSettings(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Linking.openSettings();
  } catch (e) {
    console.warn('Movira: could not open app settings', e);
  }
}