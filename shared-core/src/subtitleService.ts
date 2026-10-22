import type { SubtitleTrack } from './types';
import type { StorageAdapter } from './storage';

export interface SubtitleSearchResult {
  id: string;
  label: string;
  language: string;
  url: string;
  format: 'srt' | 'vtt';
}

export interface SubtitleProvider {
  search(query: { name: string; languages?: string[] }): Promise<SubtitleSearchResult[]>;
  download(result: SubtitleSearchResult): Promise<string>;
}

function srtTimeToSeconds(t: string): number {
  const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

export function parseSrt(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cues: string[] = [];
  let current: { start: number; end: number; text: string[] } | null = null;
  const push = () => {
    if (current && current.text.length) {
      cues.push(
        `${current.start.toFixed(3)} --> ${current.end.toFixed(3)}\n` +
          current.text.join('\n').replace(/<[^>]+>/g, '')
      );
    }
  };
  for (const line of lines) {
    if (line.includes('-->')) {
      push();
      const [a, b] = line.split('-->');
      current = { start: srtTimeToSeconds(a), end: srtTimeToSeconds(b), text: [] };
    } else if (current) {
      if (line.trim() === '') {
        push();
        current = null;
      } else if (/^\d+$/.test(line.trim()) && current.text.length === 0) {
        continue;
      } else {
        current.text.push(line);
      }
    }
  }
  push();
  return `WEBVTT\n\n${cues.join('\n\n')}`;
}

export class SubtitleService {
  private cache = new Map<string, SubtitleTrack>();
  private listeners = new Set<(t: SubtitleTrack | null) => void>();

  constructor(private provider?: SubtitleProvider) {}

  async searchOnline(name: string, languages?: string[]): Promise<SubtitleSearchResult[]> {
    if (!this.provider) return [];
    try {
      return await this.provider.search({ name, languages });
    } catch {
      return [];
    }
  }

  async loadOnline(result: SubtitleSearchResult): Promise<SubtitleTrack> {
    const cached = this.cache.get(result.url);
    if (cached) return cached;
    const content = await this.provider!.download(result);
    const vtt = result.format === 'srt' ? parseSrt(content) : content;
    const track: SubtitleTrack = { id: result.id, label: result.label, language: result.language, content: vtt };
    this.cache.set(result.url, track);
    return track;
  }

  loadLocal(name: string, content: string): SubtitleTrack {
    const isVtt = /^\s*WEBVTT/.test(content);
    return {
      id: `local-${name}`,
      label: name,
      content: isVtt ? content : parseSrt(content),
    };
  }

  notifySubtitleChange(track: SubtitleTrack | null) {
    for (const fn of this.listeners) fn(track);
  }

  onSubtitleChange(fn: (t: SubtitleTrack | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
