# Movira

A modern, cross-platform media player for desktop (Windows) and mobile (Android), built on a shared service core. Inspired by VLC's capability set with an original UI and architecture.

Movira is **fully offline and private by design**: no auto-updates, no telemetry, no watch history — built for personal use.

## Artifacts

| Platform | Artifact | Location |
| --- | --- | --- |
| Android | `Movira-1.0.0-release.apk` | repo root / `mobile/android/app/build/outputs/apk/release/` |
| Windows | `Movira-Setup-1.0.0.exe` (NSIS installer) | repo root / `desktop/release/` |

> Note: on the dev machine the Android Emulator Hypervisor driver (`aehd`) is intentionally
> **disabled** (`sc config aehd start= disabled`) — it cannot initialize on that hardware and
> its boot-start configuration caused system instability. Emulator testing is not used; the
> APK is verified via bundle compilation and Gradle builds.

## Structure

```
shared-core/   Platform-agnostic TypeScript services + domain types
desktop/       Electron + React + Vite (Windows installer via electron-builder)
mobile/        React Native (Android-first, iOS-ready architecture)
scripts/       Icon pipeline: movira.png → ICO + Android mipmaps
```

### Shared core (`shared-core/src`)

- `MediaPlayerService` — queue engine: play/seek/next/prev, shuffle, repeat off/all/one, queue CRUD + reorder, persisted queue state
- `PlaylistService` — create/rename/delete, add/remove/reorder media, shuffle-play, persistence
- `MediaLibraryService` — folder scanning via pluggable `FileSystemAdapter`, metadata enrichment, missing-file validation, search (title/artist/album/filename)
- `SubtitleService` — SRT→WebVTT conversion, local + online provider loading
- `UserDataService` — favorites, settings, resume positions. **Privacy mode: watch history is never recorded or persisted** (any history written by older versions is wiped at startup)
- `storage.ts` — `StorageAdapter` interface; implemented by localStorage (desktop) and AsyncStorage (mobile)

Playback never lives in UI components: views talk to services, services talk to platform engines.

## Desktop

- Secure Electron: `contextIsolation`, `contextBridge` preload, no `nodeIntegration`, restricted IPC (extension-filtered dialogs, subtitle-only text reads, image-only data URLs)
- Video + audio playback with progress/seek/volume/mute/speed, fullscreen (F), PiP, double-click fullscreen
- Keyboard shortcuts: Space, ←/→ seek, ↑/↓ volume, N/P tracks, M mute, S shuffle, R repeat
- Media library with folder scan/rescan/remove, favorites, global search
- VLC-style fullscreen: controls auto-hide after 3s of mouse idle (smooth 350ms fade/slide), reappear on mouse move, stay visible while paused or hovering the controls; keyboard shortcuts unaffected
- Broad format support (mp4/mkv/webm/mov/avi/wmv/flv/ts/m2ts/mts/vob/mpg/3gp/ogv and audio mp3/flac/wav/aac/m4a/ogg/opus/wma/aiff/ac3/dts/midi …) — playback is attempted for all, unsupported codecs surface as a clear error instead of a freeze, and every file streams from disk (no full-file buffering)
- Playlists: full CRUD, reorder, shuffle play; persistent queue
- Online subtitles (OpenSubtitles API) with language filter; local .srt/.vtt loading
- Audio metadata (title/artist/album/genre/artwork) via music-metadata; resume positions; dark/light/system themes; full settings
- Media-key global shortcuts (MediaPlayPause/Next/Prev/Stop) and power-save blocker during playback

## Mobile

- `react-native-track-player` → native Android `MediaSession` foreground service: background/locked-screen audio, notification + lock-screen controls, Bluetooth/headset buttons, audio focus (`autoHandleInterruptions`), `ContinuePlayback` when app is killed
- Video stops in background unless PiP is active (native behavior; no JS timer tricks)
- Document picker (audio/video), queue, favorites, playlists, dark/light system theme (privacy mode: no watch history)
- Release APK is fully standalone/offline: the Hermes JS bundle is embedded in `assets/index.android.bundle` — no Metro, USB, or Wi-Fi connection needed
- Manifest declares `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS`, `READ_MEDIA_AUDIO/VIDEO`

## Build

Prereqs: Node 18+, JDK 17, Android SDK (API 35) for mobile.

```bash
# Desktop
cd desktop
npm install
npm run dev        # Vite dev server
npm run dist       # NSIS installer → desktop/release/

# Mobile
cd mobile
npm install        # runs patch-package postinstall
npm run apk:release  # → mobile/android/app/build/outputs/apk/release/
```

### Mobile notes

- `mobile/android/init.gradle` resolves the legacy `com.facebook.react:react-native-gradle-plugin` buildscript reference used by some third-party libs; pass it on builds:
  `gradle -I init.gradle -Dmovira.root=<repo>/mobile assembleRelease`
- `mobile/patches/` carries the Kotlin null-safety fix for react-native-track-player 4.1.2 (applied automatically postinstall)
- Release builds currently sign with the debug keystore; swap in a real keystore in `app/build.gradle` before store submission
