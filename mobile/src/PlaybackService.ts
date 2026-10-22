import TrackPlayer, { Event } from 'react-native-track-player';
import { playbackEngineBridge } from './bridge';

let mounted = false;

export async function PlaybackService() {
  if (mounted) return;
  mounted = true;
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    void playbackEngineBridge.remotePlay();
  });
  TrackPlayer.addEventListener(Event.RemotePause, () => {
    void playbackEngineBridge.remotePause();
  });
  TrackPlayer.addEventListener(Event.RemoteNext, () => {
    void playbackEngineBridge.remoteNext();
  });
  TrackPlayer.addEventListener(Event.RemotePrevious, () => {
    void playbackEngineBridge.remotePrev();
  });
  TrackPlayer.addEventListener(Event.RemoteSeek, (e: { position: number }) => {
    void playbackEngineBridge.remoteSeek(e.position);
  });
  TrackPlayer.addEventListener(Event.RemoteDuck, () => {
    void playbackEngineBridge.remotePause();
  });
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => {
    void playbackEngineBridge.remoteQueueEnded();
  });
}
