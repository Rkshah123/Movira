/**
 * DIAGNOSTICS VIEW
 * ================
 * A read-only panel over `lagRecorder`. It shows what the player is doing right
 * now and lists every stall the recorder froze, with the seconds leading up to
 * it. The point is that a user who sees stutter can open this afterwards and
 * hand over real numbers instead of a description.
 *
 * It only reads. It never seeks, reloads or restarts playback.
 */
import { useCallback, useEffect, useState } from 'react';
import { lagRecorder, type LagIncident, type LagSample } from '../lagRecorder';

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function kindLabel(k: LagIncident['kind']): string {
  return k === 'decode' ? 'DECODE/DROP' : k === 'both' ? 'DECODE + MAIN' : 'MAIN THREAD';
}

export default function DiagnosticsView({ onClose }: { onClose: () => void }) {
  const [, force] = useState(0);
  const [sel, setSel] = useState<LagIncident | null>(null);
  const [copied, setCopied] = useState(false);

  // Poll at 2 Hz. Reading is cheap and the numbers are a snapshot in time, so a
  // live interval is clearer than an event-driven update here.
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, []);

  const live = lagRecorder.live();
  const incidents: LagIncident[] = lagRecorder.incidents();
  const thaw = lagRecorder.lastSeek();

  const copy = useCallback(async () => {
    const text = JSON.stringify(lagRecorder.report(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, []);

  return (
    <div className="settings-view">
      <header>
        <h2>Diagnostics</h2>
        <div>
          <button onClick={copy}>{copied ? 'Copied' : 'Copy report'}</button>
          <button onClick={() => { lagRecorder.reset(); setSel(null); }}>Reset</button>
          <button onClick={onClose}>Close</button>
        </div>
      </header>

      <section>
        <h3>Live</h3>
        <div className="diag-grid">
          <div><span>Recording</span><b>{live.recording ? 'yes' : 'no'}</b></div>
          <div><span>Frame gap</span><b>{live.gapMs} ms</b></div>
          <div><span>Worst gap</span><b>{live.worstGapMs} ms</b></div>
          <div><span>Worst long task</span><b>{live.worstLongTaskMs} ms</b></div>
          <div><span>Dropped / total frames</span><b>{live.droppedFrames} / {live.totalFrames}</b></div>
          <div><span>readyState</span><b>{live.readyState}</b></div>
          <div>
            <span>Last seek: picture resumed</span>
            <b>{thaw && thaw.thawMs !== null ? `${thaw.thawMs} ms` : 'seek first'}</b>
          </div>
          <div>
            <span>&nbsp;&nbsp;of which element ready</span>
            <b>{thaw && thaw.readyMs !== null ? `${thaw.readyMs} ms` : '--'}</b>
          </div>
          <div>
            <span>&nbsp;&nbsp;then first new frame</span>
            <b>{thaw && thaw.presentMs !== null ? `${thaw.presentMs} ms` : '--'}</b>
          </div>
          <div><span>Buffer ahead</span><b>{live.ahead < 0 ? 'unknown' : `${live.ahead}s`}</b></div>
          <div><span>Seeking</span><b>{live.seeking ? 'yes' : 'no'}</b></div>
          <div><span>Fallback tier</span><b>{live.tier2 ? 'ffmpeg/MSE' : 'native'}</b></div>
          <div><span>JS heap</span><b>{live.heapMB} MB</b></div>
          <div><span>Samples</span><b>{live.samples}</b></div>
          <div><span>Stalls (&gt;400ms)</span><b>{live.stalls}</b></div>
        </div>
        <p className="hint">
          Leave this open while the problem happens, or just play normally and come
          back afterwards — every stall is recorded in the background.
        </p>
      </section>

      <section>
        <h3>Stalls</h3>
        {incidents.length === 0 ? (
          <p className="hint">No stall over 400 ms recorded so far.</p>
        ) : (
          <table className="diag-table">
            <thead>
              <tr>
                <th>#</th><th>At</th><th>Media</th><th>Stall</th><th>Kind</th>
                <th>rs</th><th>Ahead</th><th>Dropped</th><th>Heap</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((i: LagIncident) => (
                <tr
                  key={i.id}
                  onClick={() => setSel(i)}
                  className={sel && sel.id === i.id ? 'sel' : ''}
                >
                  <td>{i.id}</td>
                  <td>{fmtTime(i.t / 1000)}</td>
                  <td>{fmtTime(i.mediaTime)}</td>
                  <td><b>{i.gapMs} ms</b></td>
                  <td>{kindLabel(i.kind)}</td>
                  <td>{i.readyState}</td>
                  <td>{i.bufferedAhead < 0 ? '?' : `${i.bufferedAhead}s`}</td>
                  <td>{i.droppedFrames}</td>
                  <td>{i.heapMB} MB</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {sel && (
        <section>
          <h3>Stall #{sel.id} — {sel.gapMs} ms before</h3>
          <p className="hint">
            Longest task in the session so far: {sel.longTaskMs} ms.
            {sel.errors.length > 0 && ` Errors: ${sel.errors.join(' | ')}`}
          </p>
          <table className="diag-table">
            <thead>
              <tr><th>ms</th><th>media</th><th>gap</th><th>rs</th><th>seeking</th><th>ahead</th><th>dropped</th></tr>
            </thead>
            <tbody>
              {sel.pre.map((s: LagSample, i: number) => (
                <tr key={i} className={s.gap >= 400 ? 'sel' : ''}>
                  <td>{s.t}</td><td>{s.media.toFixed(2)}</td><td>{s.gap}</td>
                  <td>{s.readyState}</td><td>{s.seeking ? 'y' : 'n'}</td>
                  <td>{s.ahead < 0 ? '?' : s.ahead}</td><td>{s.droppedFrames}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}