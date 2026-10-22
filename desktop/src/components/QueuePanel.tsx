import React from 'react';
import type { QueueState } from '@shared';
import { formatTime } from '@shared';
import type { DesktopServices } from '../services';

interface Props {
  services: DesktopServices;
  queue: QueueState;
  onQueueChange: () => void;
  onClose: () => void;
}

/** Memoized: the parent re-renders ~10×/s on progress ticks; the queue only
 *  changes on actual queue operations, so skip those re-renders. */
function QueuePanel({ services, queue, onQueueChange, onClose }: Props) {
  const playAt = (i: number) => {
    void services.player.playAt(i).then(onQueueChange);
  };

  const remove = (i: number) => {
    services.player.removeFromQueue(i);
    onQueueChange();
  };

  const move = (from: number, to: number) => {
    services.player.reorderQueue(from, to);
    onQueueChange();
  };

  return (
    <div className="queue-panel">
      <div className="panel-header">
        <h3>Queue · {queue.items.length}</h3>
        <div className="panel-actions">
          <button
            onClick={() => { void services.player.toggleShuffle().then(onQueueChange); }}
            className={queue.shuffle ? 'active' : ''}
          >Shuffle</button>
          <button onClick={() => { services.player.clearQueue(); onQueueChange(); }}>Clear</button>
          <button onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="queue-list">
        {queue.items.map((item, i) => (
          <div key={item.id} className={`queue-item ${i === queue.index ? 'current' : ''}`}>
            <span className="q-index">{i === queue.index ? '▶' : i + 1}</span>
            <button className="q-main" onClick={() => playAt(i)} onDoubleClick={() => playAt(i)}>
              <span className="q-title">{item.title}</span>
              <span className="q-sub">{item.artist ?? item.type}</span>
            </button>
            <span className="q-duration">{item.duration ? formatTime(item.duration) : ''}</span>
            <button className="q-btn" onClick={() => move(i, Math.max(0, i - 1))} title="Move up">↑</button>
            <button className="q-btn" onClick={() => move(i, Math.min(queue.items.length - 1, i + 1))} title="Move down">↓</button>
            <button className="q-btn" onClick={() => remove(i)} title="Remove">✕</button>
          </div>
        ))}
        {!queue.items.length && <div className="empty-note">Queue is empty</div>}
      </div>
    </div>
  );
}

export default React.memo(QueuePanel);
