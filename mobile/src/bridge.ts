type Bridge = {
  remotePlay: () => Promise<void>;
  remotePause: () => Promise<void>;
  remoteNext: () => Promise<void>;
  remotePrev: () => Promise<void>;
  remoteSeek: (t: number) => Promise<void>;
  remoteQueueEnded: () => Promise<void>;
};

let impl: Bridge | null = null;

export const playbackEngineBridge: Bridge = {
  async remotePlay() {
    await impl?.remotePlay();
  },
  async remotePause() {
    await impl?.remotePause();
  },
  async remoteNext() {
    await impl?.remoteNext();
  },
  async remotePrev() {
    await impl?.remotePrev();
  },
  async remoteSeek(t) {
    await impl?.remoteSeek(t);
  },
  async remoteQueueEnded() {
    await impl?.remoteQueueEnded();
  },
};

export function setPlaybackBridge(b: Bridge | null) {
  impl = b;
}
