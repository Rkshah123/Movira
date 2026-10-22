export interface StorageAdapter {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export const storageKeys = {
  playlists: 'playlists',
  queue: 'queue',
  history: 'history',
  favorites: 'favorites',
  settings: 'settings',
  libraryFolders: 'libraryFolders',
  libraryItems: 'libraryItems',
  resume: 'resumePositions',
  preferences: 'playbackPrefs',
} as const;
