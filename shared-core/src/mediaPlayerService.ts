import type { MediaItem, RepeatMode, QueueState, SubtitleTrack } from './types';

export interface PlayerEngine {
  load(item: MediaItem, autoplay?: boolean): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(t: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  setRate(r: number): Promise<void>;
  setRepeat(m: RepeatMode): void;
  setShuffle(s: boolean): void;
  setSubtitles(track: SubtitleTrack | null): Promise<void>;
  setAudioTrack(index: number): Promise<void>;
  getAudioTracks(): Promise<{ index: number; label: string }[]>;
}

export interface EngineEvents {
  onProgress(t: number, duration: number): void;
  onEnded(): void;
  onError(message: string): void;
  onPlayingChange(playing: boolean): void;
}

export class MediaPlayerService {
  private queue: MediaItem[] = [];
  private index = -1;
  private repeat: RepeatMode = 'off';
  private shuffle = false;
  private shuffledOrder: number[] = [];
  private history: MediaItem[] = [];

  constructor(
    private engine: PlayerEngine,
    private events: EngineEvents,
    private persist: (state: QueueState) => void
  ) {}

  setQueue(items: MediaItem[], startIndex = 0, autoplay = true) {
    this.queue = [...items];
    this.rebuildShuffle();
    this.index = this.queue.length ? Math.min(startIndex, this.queue.length - 1) : -1;
    this.events.onPlayingChange(false);
    void this.loadCurrent(autoplay);
  }

  addToQueue(items: MediaItem[]) {
    const wasEmpty = this.queue.length === 0;
    this.queue.push(...items);
    this.rebuildShuffle();
    if (wasEmpty && this.queue.length) {
      this.index = 0;
      void this.loadCurrent(true);
    }
    this.persistState();
  }

  removeFromQueue(index: number) {
    if (index < 0 || index >= this.queue.length) return;
    const wasCurrent = index === this.index;
    this.queue.splice(index, 1);
    if (index < this.index) this.index--;
    else if (wasCurrent) {
      this.index = Math.min(this.index, this.queue.length - 1);
      if (this.index >= 0) void this.loadCurrent(true);
      else this.events.onPlayingChange(false);
    }
    this.rebuildShuffle();
    this.persistState();
  }

  reorderQueue(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= this.queue.length || to >= this.queue.length) return;
    const [it] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, it);
    if (this.index === from) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this.rebuildShuffle();
    this.persistState();
  }

  clearQueue() {
    this.queue = [];
    this.index = -1;
    this.events.onPlayingChange(false);
    this.persistState();
  }

  async togglePlay() {
    await this.engine.play();
  }

  async pause() {
    await this.engine.pause();
  }

  async toggleShuffle() {
    this.shuffle = !this.shuffle;
    this.rebuildShuffle();
    this.persistState();
    return this.shuffle;
  }

  cycleRepeat(): RepeatMode {
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off';
    this.engine.setRepeat(this.repeat);
    this.persistState();
    return this.repeat;
  }

  getQueue(): QueueState {
    return { items: [...this.queue], index: this.index, repeat: this.repeat, shuffle: this.shuffle };
  }

  getCurrent(): MediaItem | null {
    return this.index >= 0 && this.index < this.queue.length ? this.queue[this.index] : null;
  }

  getHistory(): MediaItem[] {
    return [...this.history];
  }

  isShuffled(): boolean {
    return this.shuffle;
  }

  getRepeat(): RepeatMode {
    return this.repeat;
  }

  private rebuildShuffle() {
    const n = this.queue.length;
    this.shuffledOrder = Array.from({ length: n }, (_, i) => i);
    if (this.shuffle && n > 1) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.shuffledOrder[i], this.shuffledOrder[j]] = [this.shuffledOrder[j], this.shuffledOrder[i]];
      }
    }
  }

  private shuffledNext(from: number): number {
    const pos = this.shuffledOrder.indexOf(from);
    if (pos >= 0 && pos < this.shuffledOrder.length - 1) return this.shuffledOrder[pos + 1];
    if (this.repeat === 'all') return this.shuffledOrder[0] ?? -1;
    return -1;
  }

  async next(userInitiated = true): Promise<boolean> {
    if (!this.queue.length) return false;
    let nextIdx: number;
    if (this.shuffle) {
      nextIdx = this.shuffledNext(this.index);
      if (nextIdx === -1) return false;
    } else {
      if (this.index < this.queue.length - 1) nextIdx = this.index + 1;
      else if (this.repeat === 'all' || userInitiated) nextIdx = 0;
      else return false;
    }
    this.index = nextIdx;
    await this.loadCurrent(true);
    return true;
  }

  async previous(): Promise<boolean> {
    if (!this.queue.length) return false;
    let prevIdx: number;
    if (this.shuffle) {
      const pos = this.shuffledOrder.indexOf(this.index);
      if (pos > 0) prevIdx = this.shuffledOrder[pos - 1];
      else prevIdx = this.shuffledOrder[this.shuffledOrder.length - 1];
    } else {
      if (this.index > 0) prevIdx = this.index - 1;
      else prevIdx = this.repeat === 'all' ? this.queue.length - 1 : 0;
    }
    this.index = prevIdx;
    await this.loadCurrent(true);
    return true;
  }

  async playAt(index: number) {
    if (index < 0 || index >= this.queue.length) return;
    this.index = index;
    await this.loadCurrent(true);
  }

  private async loadCurrent(autoplay: boolean) {
    const item = this.getCurrent();
    if (!item) return;
    this.history = [item, ...this.history.filter((h) => h.id !== item.id)].slice(0, 50);
    try {
      await this.engine.load(item, autoplay);
      this.persistState();
    } catch (e) {
      this.events.onError(e instanceof Error ? e.message : String(e));
    }
  }

  handleEnded() {
    if (this.repeat === 'one' && this.index >= 0) {
      void this.loadCurrent(true);
      return;
    }
    void this.next(false).then((moved) => {
      if (!moved) this.events.onPlayingChange(false);
    });
  }

  private persistState() {
    this.persist({ items: [...this.queue], index: this.index, repeat: this.repeat, shuffle: this.shuffle });
  }
}
