import { app, BrowserWindow, ipcMain, dialog, shell, session, globalShortcut, powerSaveBlocker } from 'electron';
import { probeMedia, startStream, stopStream, stopAllStreams, shutdownStreamServer, decideMode, readEmbeddedSubtitle } from './streamServer';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { parseFile } from 'music-metadata';

const isDev = !app.isPackaged;

// --- Test isolation -------------------------------------------------------
// E2E harnesses must never touch the real user data (library, persisted
// queue, resume positions, settings) — a test once left its generated media
// in the persisted queue, so the home screen later offered to "play" a
// nonexistent file. When MOVIRA_USER_DATA_DIR is set, redirect Electron's
// userData BEFORE anything (including the single-instance lock) uses it.
const testUserDataDir = process.env.MOVIRA_USER_DATA_DIR;
if (testUserDataDir) {
  app.setPath('userData', testUserDataDir);
  app.setPath('sessionData', testUserDataDir); // cache/GPUCache too
}
let mainWindow: BrowserWindow | null = null;
let psbId: number | null = null;

// Single instance: opening a file from Explorer while Movira runs must reuse
// the existing window (the second process exits; its argv arrives below).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Media files passed on the command line (Windows "Open with" passes the file
// path as an argument; dev runs may include flags like '.' which are filtered).
let launchedFiles: string[] = [];

function mediaPathsFromArgv(argv: string[]): string[] {
  return argv
    .slice(1)
    .filter(
      (a) =>
        !a.startsWith('-') &&
        (VIDEO_EXT.has(a.toLowerCase().split('.').pop() ?? '') ||
          AUDIO_EXT.has(a.toLowerCase().split('.').pop() ?? '')) &&
        fs.existsSync(a)
    );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    icon: path.join(app.getAppPath(), process.env.VITE_DEV_SERVER_URL ? '../../public/Mov.png' : 'dist/renderer/Mov.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('fullscreenChanged', true));
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('fullscreenChanged', false));

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {        void mainWindow.loadFile(path.join(app.getAppPath(), 'dist/renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Full format coverage (spec §1/§3). Extensions mean "attempt playback" — actual
// decodability depends on the system media engine and is surfaced as a clean error.
const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'asf', 'flv', 'f4v',
  'ts', 'm2ts', 'mts', 'vob', 'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'mpv',
  '3gp', '3g2', 'ogv', 'ogg', 'divx', 'xvid', 'rm', 'rmvb', 'mxf', 'dv',
  'mod', 'tod',
]);
const AUDIO_EXT = new Set([
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'alac', 'aiff',
  'aif', 'aifc', 'amr', 'ape', 'mka', 'ac3', 'eac3', 'dts', 'ra', 'rm',
  'mid', 'midi',
]);
const SUB_EXT = new Set(['srt', 'vtt']);

// Every extension the open dialog should accept.
const ALL_MEDIA_EXT = [...new Set([...VIDEO_EXT, ...AUDIO_EXT])];

function walk(dir: string, out: { path: string; size: number; mtime: number }[], depth = 0) {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, out, depth + 1);
    } else {
      const ext = e.name.toLowerCase().split('.').pop() ?? '';
      if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) {
        try {
          const st = fs.statSync(p);
          out.push({ path: p, size: st.size, mtime: st.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    }
  }
}

function readVttSize(b64: string): number {
  try {
    const buf = Buffer.from(b64, 'base64');
    return buf.length;
  } catch {
    return 0;
  }
}

function registerIpc() {
  ipcMain.handle('dialog:openFile', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: ALL_MEDIA_EXT },
        { name: 'Video', extensions: [...VIDEO_EXT] },
        { name: 'Audio', extensions: [...AUDIO_EXT] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  // Single-select variant used by the Media menu's "Open File". The multi-file
  // picker above stays multi-select for "Open Multiple Files in Queue".
  ipcMain.handle('dialog:openFileSingle', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [
        { name: 'Media', extensions: ALL_MEDIA_EXT },
        { name: 'Video', extensions: [...VIDEO_EXT] },
        { name: 'Audio', extensions: [...AUDIO_EXT] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('dialog:openSubtitle', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'Subtitles', extensions: [...SUB_EXT] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('fs:listMedia', async (_e, folder: string) => {
    const out: { path: string; size: number; mtime: number }[] = [];
    walk(folder, out);
    return out;
  });

  ipcMain.handle('fs:exists', async (_e, p: string) => {
    try { await fsp.access(p); return true; } catch { return false; }
  });

  ipcMain.handle('fs:stat', async (_e, p: string) => {
    try {
      const st = await fsp.stat(p);
      return { size: st.size, mtime: st.mtimeMs };
    } catch {
      return null;
    }
  });

  ipcMain.handle('fs:readText', async (_e, p: string) => {
    const ext = p.toLowerCase().split('.').pop() ?? '';
    if (!SUB_EXT.has(ext)) throw new Error('Not allowed');
    return fsp.readFile(p, 'utf-8');
  });

  ipcMain.handle('fs:readDataUrl', async (_e, p: string) => {
    const ext = p.toLowerCase().split('.').pop() ?? '';
    const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : null;
    if (!mime) throw new Error('Not allowed');
    const buf = await fsp.readFile(p);
    return `data:${mime};base64,${buf.toString('base64')}`;
  });

  ipcMain.handle('media:metadata', async (_e, p: string) => {
    try {
      const ext = p.toLowerCase().split('.').pop() ?? '';
      const isAudio = AUDIO_EXT.has(ext);
      const mm = await parseFile(p, { duration: true });
      let width: number | undefined, height: number | undefined;
      const vstream = mm.common;
      const pic = mm.common.picture?.[0];
      let artwork: string | undefined;
      if (pic) {
        const mime = pic.format || 'image/jpeg';
        artwork = `data:${mime};base64,${Buffer.from(pic.data).toString('base64')}`;
      }
      void vstream;
      void readVttSize;
      if (isAudio) {
        return {
          type: 'audio' as const,
          title: mm.common.title,
          artist: mm.common.artist ?? mm.common.albumartist,
          album: mm.common.album,
          genre: mm.common.genre?.[0],
          year: mm.common.year,
          duration: mm.format.duration,
          artwork,
        };
      }
      return {
        type: 'video' as const,
        title: mm.common.title,
        duration: mm.format.duration,
        artwork,
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle('media:probeVideo', async (_e, p: string) => {
    try {
      const mm = await parseFile(p, { duration: true, skipCovers: true });
      const vstream = mm.format.trackInfo?.find((t) => t.video)?.video;
      return {
        width: vstream?.pixelWidth,
        height: vstream?.pixelHeight,
        duration: mm.format.duration,
      };
    } catch {
      return null;
    }
  });

  // ---- Playback fallback tier (remux/transcode streaming) ----
  ipcMain.handle('media:probe', (_e, p: string) => probeMedia(p));
  ipcMain.handle('media:startStream', (_e, opts: { src: string; mode: 'remux' | 'remux-tc-audio' | 'transcode-video' | 'transcode-audio-only'; seek?: number; audioCodec?: string; audioTrack?: number }) => startStream(opts));
  // Embedded subtitle extraction (V key). The fMP4 stream drops subtitles
  // (-sn) because MSE cannot render them, so a movie's own subtitle languages
  // are extracted on demand and handed back as WebVTT for a <track>.
  ipcMain.handle('media:readEmbeddedSubtitle', (_e, src: string, index: number) => readEmbeddedSubtitle(src, index));
  // Session-scoped teardown: kills ONLY the stream id the renderer owns. A Stop
  // followed quickly by Play can no longer kill the freshly started session.
  ipcMain.handle('media:stopStream', (_e, id: string) => {
    stopStream(String(id));
    return true;
  });
  ipcMain.handle('media:stopStreams', () => {
    stopAllStreams();
    return true;
  });
  ipcMain.handle(
    'media:decideMode',
    (_e, probe: Parameters<typeof decideMode>[0], audioCaps: string[], videoCaps: string[]) => {
      const aCaps = new Set(audioCaps.map((c) => c.toLowerCase()));
      const vCaps = new Set(videoCaps.map((c) => c.toLowerCase()));
      return decideMode(probe, (codec) => aCaps.has(codec), (codec) => vCaps.has(codec));
    }
  );
  ipcMain.handle('app:quit', () => app.quit());
  // Open Windows Settings → Default apps (registered via the installer's
  // Capabilities/RegisteredApplications entries) so the user can opt Movira
  // in as the default player for specific formats.
  ipcMain.handle('app:openDefaultApps', async () => {
    try {
      await shell.openExternal('ms-settings:defaultapps');
      return true;
    } catch {
      return false;
    }
  });
  // Files handed to the app at launch via file association ("Open with" →
  // Movira). Consumed once by the renderer after services are ready.
  ipcMain.handle('app:consumeLaunchedFiles', () => {
    const files = launchedFiles;
    launchedFiles = [];
    return files;
  });
  ipcMain.handle('app:setFullscreen', (_e, flag: boolean) => mainWindow?.setFullScreen(flag));
  ipcMain.handle('app:isFullscreen', () => mainWindow?.isFullScreen() ?? false);
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('subtitles:searchOnline', async (_e, name: string, langs: string[] | undefined) => {
    try {
      const url = `https://rest.opensubtitles.org/search/query-${encodeURIComponent(name)}${langs?.length ? `/sublanguageid-${langs.join(',')}` : ''}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'MoviraPlayer v1' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as Array<{ IDSubtitleFile: string; MovieName: string; SubFileName: string; ISO639: string; SubFormat: string }>;
      return data.slice(0, 30).map((d) => ({
        id: d.IDSubtitleFile,
        label: d.SubFileName || d.MovieName,
        language: d.ISO639 || 'und',
        url: d.IDSubtitleFile,
        format: (d.SubFormat === 'vtt' ? 'vtt' : 'srt') as 'srt' | 'vtt',
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('subtitles:downloadOnline', async (_e, id: string) => {
    try {
      const res = await fetch(`https://dl.opensubtitles.org/en/download/src-api/v3/file/${encodeURIComponent(id)}`, {
        headers: { 'User-Agent': 'MoviraPlayer v1' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('Download failed');
      const text = await res.text();
      if (!/<html|<!doctype/i.test(text.slice(0, 200))) return text;
      throw new Error('Invalid content');
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'Download failed');
    }
  });

  ipcMain.handle('power:keepAwake', (_e, on: boolean) => {
    if (on && psbId === null) psbId = powerSaveBlocker.start('prevent-display-sleep');
    else if (!on && psbId !== null) {
      powerSaveBlocker.stop(psbId);
      psbId = null;
    }
    return psbId !== null;
  });
}

app.whenReady().then(() => {
  // Files passed at launch via file association ("Open with" → Movira or
  // double-clicking an associated file in Explorer).
  launchedFiles = mediaPathsFromArgv(process.argv);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob: file: blob: mediastream:; connect-src 'self' blob: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'"],
      },
    });
  });

  registerIpc();
  createWindow();

  globalShortcut.register('MediaPlayPause', () => mainWindow?.webContents.send('mediaKey', 'playpause'));
  globalShortcut.register('MediaNextTrack', () => mainWindow?.webContents.send('mediaKey', 'next'));
  globalShortcut.register('MediaPreviousTrack', () => mainWindow?.webContents.send('mediaKey', 'prev'));
  globalShortcut.register('MediaStop', () => mainWindow?.webContents.send('mediaKey', 'stop'));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  shutdownStreamServer();
});

app.on('second-instance', (_e, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    // Opening another file while Movira runs: hand it to the existing window.
    // (No launchedFiles push here — the renderer is already subscribed and a
    // pushed-but-never-consumed path would go stale.)
    const files = mediaPathsFromArgv(argv);
    if (files.length) {
      mainWindow.webContents.send('open-media-paths', files);
    }
  }
});

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
});
