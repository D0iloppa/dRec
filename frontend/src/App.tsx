import { Routes, Route } from 'react-router-dom';
import { useRef, useState } from 'react';

const SLICE_MS = 60_000; // 60초마다 조각 전송

function pickMime(): string {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const m of cands) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

function Home() {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chunks, setChunks] = useState<Record<number, string>>({}); // seq → text
  const [minutes, setMinutes] = useState('');
  const [error, setError] = useState('');

  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const recordingRef = useRef(false);
  const pending = useRef<Promise<void>[]>([]);
  const mimeRef = useRef('');

  async function sendChunk(seq: number, blob: Blob) {
    const fd = new FormData();
    fd.append('seq', String(seq));
    fd.append('audio', blob, `chunk-${seq}.webm`);
    const res = await fetch(`/api/sessions/${sessionRef.current}/chunk`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`조각 ${seq} 전사 실패 (${res.status})`);
    const data = await res.json();
    setChunks((prev) => ({ ...prev, [data.seq]: data.text }));
  }

  function startSegment() {
    const rec = new MediaRecorder(streamRef.current!, mimeRef.current ? { mimeType: mimeRef.current } : undefined);
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) parts.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(parts, { type: mimeRef.current || 'audio/webm' });
      const seq = seqRef.current++;
      if (blob.size > 0) pending.current.push(sendChunk(seq, blob).catch((e) => setError(String(e.message || e))));
      if (recordingRef.current) startSegment(); // 다음 세그먼트 이어서
    };
    rec.start();
    recRef.current = rec;
    timerRef.current = setTimeout(() => rec.state !== 'inactive' && rec.stop(), SLICE_MS);
  }

  async function start() {
    setError(''); setMinutes(''); setChunks({}); seqRef.current = 0; pending.current = [];
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      mimeRef.current = pickMime();
      const res = await fetch('/api/sessions', { method: 'POST' });
      if (!res.ok) throw new Error('세션 생성 실패');
      sessionRef.current = (await res.json()).id;
      recordingRef.current = true; setRecording(true);
      startSegment();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function stop() {
    recordingRef.current = false; setRecording(false); setBusy(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); // 마지막 조각 flush
    streamRef.current?.getTracks().forEach((t) => t.stop());
    // 마지막 onstop → sendChunk 가 pending 에 들어갈 시간을 짧게 준 뒤 모두 대기
    await new Promise((r) => setTimeout(r, 300));
    await Promise.allSettled(pending.current);
    try {
      const res = await fetch(`/api/sessions/${sessionRef.current}/finish`, { method: 'POST' });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.detail || `회의록 생성 실패 (${res.status})`);
      }
      setMinutes((await res.json()).minutes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const liveTranscript = Object.keys(chunks)
    .map(Number).sort((a, b) => a - b).map((k) => chunks[k]).join('\n');

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: 24, fontFamily: 'sans-serif' }}>
      <h1>dRec — 회의 녹음 → 회의록</h1>
      <p style={{ color: '#666' }}>
        녹음 중 60초마다 전사가 진행됩니다. 종료하면 곧바로 회의록을 정리합니다.
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '16px 0' }}>
        {!recording ? (
          <button onClick={start} disabled={busy}>● 녹음 시작</button>
        ) : (
          <button onClick={stop}>■ 종료 + 회의록</button>
        )}
        {recording && <span style={{ color: 'crimson' }}>● 녹음 중…</span>}
        {busy && <span>회의록 생성 중…</span>}
      </div>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {minutes && (
        <section>
          <h2>회의록</h2>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f8fa', padding: 16, borderRadius: 8 }}>{minutes}</pre>
        </section>
      )}

      {liveTranscript && (
        <section>
          <h2>전사본 {recording ? '(실시간)' : ''}</h2>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#fafafa', padding: 16, borderRadius: 8, color: '#555' }}>
            {liveTranscript}
          </pre>
        </section>
      )}
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  );
}
