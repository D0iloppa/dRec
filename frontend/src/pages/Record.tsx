import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, Square, Pause, Play } from 'lucide-react';
import { api } from '../api';
import { useMeetings } from '../store';

const SLICE_MS = 3_000; // 미리보기 전사 조각 주기(3초). 저장용 녹음은 별도 연속 녹음이라 영향 없음.

function pickMime(): string {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const m of cands) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

type Status = 'idle' | 'recording' | 'paused';

export default function Record() {
  const [status, setStatus] = useState<Status>('idle');
  const [busy, setBusy] = useState(false);
  const [chunks, setChunks] = useState<Record<number, string>>({});
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const refresh = useMeetings((s) => s.refresh);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const sliceStreamRef = useRef<MediaStream | null>(null);
  const fullRecRef = useRef<MediaRecorder | null>(null); // 저장용 연속 녹음(이음매 없음, 네이티브 pause/resume)
  const fullPartsRef = useRef<Blob[]>([]);
  const sliceRecRef = useRef<MediaRecorder | null>(null); // 미리보기용 짧은 조각(전사 전용)
  const sliceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const activeRef = useRef(false);
  const pending = useRef<Promise<void>[]>([]);
  const mimeRef = useRef('');

  useEffect(() => () => { if (tickRef.current) clearInterval(tickRef.current); }, []);

  function startTick() { tickRef.current = setInterval(() => setElapsed((e) => e + 1), 1000); }
  function stopTick() { if (tickRef.current) clearInterval(tickRef.current); tickRef.current = null; }

  async function previewChunk(seq: number, blob: Blob) {
    const data = await api.sendChunk(sessionRef.current!, seq, blob);
    setChunks((prev) => ({ ...prev, [data.seq]: data.text }));
  }

  // 미리보기 조각: 클론 스트림에서 3초마다 독립 webm 을 만들어 전사(저장 안 함).
  function startSliceSegment() {
    const rec = new MediaRecorder(sliceStreamRef.current!, mimeRef.current ? { mimeType: mimeRef.current } : undefined);
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) parts.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(parts, { type: mimeRef.current || 'audio/webm' });
      const seq = seqRef.current++;
      if (blob.size > 0) pending.current.push(previewChunk(seq, blob).catch(() => {}));
      if (activeRef.current) startSliceSegment();
    };
    rec.start();
    sliceRecRef.current = rec;
    sliceTimerRef.current = setTimeout(() => rec.state !== 'inactive' && rec.stop(), SLICE_MS);
  }

  async function start() {
    setError(''); setChunks({}); setElapsed(0); seqRef.current = 0; pending.current = []; fullPartsRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      mimeRef.current = pickMime();
      sessionRef.current = (await api.createSession()).id;

      // 저장용 연속 녹음(원본 스트림).
      const full = new MediaRecorder(stream, mimeRef.current ? { mimeType: mimeRef.current } : undefined);
      full.ondataavailable = (e) => { if (e.data.size > 0) fullPartsRef.current.push(e.data); };
      full.start();
      fullRecRef.current = full;

      // 미리보기용 클론 스트림(두 레코더 동시 사용 안정성).
      sliceStreamRef.current = new MediaStream(stream.getAudioTracks().map((t) => t.clone()));

      activeRef.current = true; setStatus('recording');
      startTick();
      startSliceSegment();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function pause() {
    activeRef.current = false;
    if (sliceTimerRef.current) clearTimeout(sliceTimerRef.current);
    if (sliceRecRef.current && sliceRecRef.current.state !== 'inactive') sliceRecRef.current.stop();
    if (fullRecRef.current && fullRecRef.current.state === 'recording') fullRecRef.current.pause();
    stopTick();
    setStatus('paused');
  }

  function resume() {
    activeRef.current = true;
    if (fullRecRef.current && fullRecRef.current.state === 'paused') fullRecRef.current.resume();
    setStatus('recording');
    startTick();
    startSliceSegment();
  }

  async function finish() {
    activeRef.current = false; setBusy(true);
    stopTick();
    if (sliceTimerRef.current) clearTimeout(sliceTimerRef.current);
    if (sliceRecRef.current && sliceRecRef.current.state !== 'inactive') sliceRecRef.current.stop();
    setStatus('idle');

    // 저장용 연속 녹음 정지 → 최종 blob 확보.
    const full = fullRecRef.current;
    const fullBlob: Blob | null = full
      ? await new Promise<Blob>((resolve) => {
          full.onstop = () => resolve(new Blob(fullPartsRef.current, { type: mimeRef.current || 'audio/webm' }));
          if (full.state !== 'inactive') full.stop(); else resolve(new Blob(fullPartsRef.current));
        })
      : null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    sliceStreamRef.current?.getTracks().forEach((t) => t.stop());
    await new Promise((r) => setTimeout(r, 200));
    await Promise.allSettled(pending.current);

    const id = sessionRef.current!;
    try {
      if (fullBlob && fullBlob.size > 0) await api.uploadSessionAudio(id, fullBlob);
      await api.finishSession(id);
      await refresh();
      navigate(`/m/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const liveLines = Object.keys(chunks)
    .map(Number).sort((a, b) => a - b).map((k) => chunks[k]).filter((t) => t.trim());
  const active = status !== 'idle';
  const liveBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = liveBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chunks]);

  return (
    <div className="page">
      <div className="rec-hero">
        <h1>회의 녹음</h1>
        <p>버튼을 누르면 바로 녹음이 시작됩니다. 일시정지로 멈췄다 이어서 녹음할 수 있고, 종료하면 회의록을 정리합니다.</p>

        {status === 'idle' ? (
          <button className="rec-btn" onClick={start} disabled={busy} aria-label="녹음 시작">
            <Mic size={34} />
          </button>
        ) : (
          <button
            className={`rec-btn${status === 'recording' ? ' recording' : ''}`}
            onClick={status === 'recording' ? pause : resume}
            aria-label={status === 'recording' ? '일시정지' : '재개'}
          >
            {status === 'recording' ? <Pause size={30} /> : <Play size={30} />}
          </button>
        )}

        {active && <div className="rec-time">{fmtElapsed(elapsed)}</div>}

        <div className="rec-status">
          {status === 'recording' && <span><span className="dot">●</span> 녹음 중…</span>}
          {status === 'paused' && <span>⏸ 일시정지됨</span>}
          {busy && <span>회의록 생성 중…</span>}
          {error && <span className="err">{error}</span>}
        </div>

        {active && (
          <button className="finish-btn" onClick={finish} disabled={busy}>
            <Square size={14} /> 종료 + 회의록
          </button>
        )}
      </div>

      {active && (
        <div className="live-panel">
          <div className="live-head">실시간 전사</div>
          <div className="live-body" ref={liveBodyRef}>
            {liveLines.length === 0 ? (
              <span className="live-wait">전사 대기 중…</span>
            ) : (
              liveLines.map((t, i) => (
                <div key={i} className={i === liveLines.length - 1 ? 'live-line live-last' : 'live-line'}>
                  {t}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
