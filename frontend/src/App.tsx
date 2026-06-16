import { Routes, Route } from 'react-router-dom';
import { useState } from 'react';

function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [minutes, setMinutes] = useState('');
  const [error, setError] = useState('');

  async function run() {
    if (!file) return;
    setLoading(true);
    setError('');
    setTranscript('');
    setMinutes('');
    try {
      const fd = new FormData();
      fd.append('audio', file);
      const res = await fetch('/api/process', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `요청 실패 (${res.status})`);
      }
      const data = await res.json();
      setTranscript(data.transcript);
      setMinutes(data.minutes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: 24, fontFamily: 'sans-serif' }}>
      <h1>dRec — 회의 녹음 → 회의록</h1>
      <p style={{ color: '#666' }}>오디오 업로드 → 로컬 Whisper 전사 → Claude 회의록 정리</p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '16px 0' }}>
        <input
          type="file"
          accept="audio/*,video/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button onClick={run} disabled={!file || loading}>
          {loading ? '처리 중…' : '회의록 생성'}
        </button>
      </div>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {minutes && (
        <section>
          <h2>회의록</h2>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f8fa', padding: 16, borderRadius: 8 }}>
            {minutes}
          </pre>
        </section>
      )}

      {transcript && (
        <section>
          <h2>전사본</h2>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#fafafa', padding: 16, borderRadius: 8, color: '#555' }}>
            {transcript}
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
