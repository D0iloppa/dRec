import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, Square, Pause, Play } from 'lucide-react';
import { api, SseEvent } from '../api';
import { useMeetings } from '../store';
import { SketchpadPanel } from '../components/Sketchpad';

// VAD 설정
const SILENCE_THRESHOLD = 8;    // RMS 임계값 (0-255 스케일)
const SILENCE_MS = 700;         // 이 시간 이상 무음이면 청크 종료
const MAX_CHUNK_MS = 5_000;     // 최대 청크 길이 (안전 상한 — 5초)

function pickMime(): string {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const m of cands) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

type Status = 'idle' | 'recording' | 'paused';

interface LiveSeg { text: string; start: number; end: number }

export default function Record() {
  const [status, setStatus] = useState<Status>('idle');
  const [busy, setBusy] = useState(false);
  const [liveSegs, setLiveSegs] = useState<LiveSeg[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState('');
  const [sessionId, setSessionId] = useState<number | null>(null);
  const navigate = useNavigate();
  const refresh = useMeetings((s) => s.refresh);

  // 녹음 refs
  const streamRef = useRef<MediaStream | null>(null);
  const sliceStreamRef = useRef<MediaStream | null>(null);
  const sliceRecRef = useRef<MediaRecorder | null>(null);
  const slicePartsRef = useRef<Blob[]>([]);
  const sessionRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const activeRef = useRef(false);
  const mimeRef = useRef('');

  // 타임스탬프 추적 refs
  const recordingStartMsRef = useRef(0);   // Date.now() 기준 녹음 시작 시각
  const totalPausedMsRef = useRef(0);      // 누적 일시정지 시간(ms)
  const pauseStartMsRef = useRef<number | null>(null);
  const chunkStartMsRef = useRef(0);       // 현재 청크 시작 시점의 active elapsed(ms)

  // VAD refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadRafRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const maxChunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // SSE ref
  const sseRef = useRef<EventSource | null>(null);

  // elapsed 타이머
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (tickRef.current) clearInterval(tickRef.current); }, []);

  function getActiveMs(): number {
    const now = Date.now();
    const paused = pauseStartMsRef.current !== null
      ? totalPausedMsRef.current + (now - pauseStartMsRef.current)
      : totalPausedMsRef.current;
    return now - recordingStartMsRef.current - paused;
  }

  function startTick() {
    tickRef.current = setInterval(() => setElapsedMs(getActiveMs()), 200);
  }
  function stopTick() {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }

  // ── 청크 처리 ──────────────────────────────────────────────────────────────

  function flushChunk() {
    if (maxChunkTimerRef.current) clearTimeout(maxChunkTimerRef.current);
    maxChunkTimerRef.current = null;
    if (sliceRecRef.current && sliceRecRef.current.state !== 'inactive') {
      sliceRecRef.current.stop(); // onstop 에서 전송 + 새 청크 시작
    }
  }

  function startSlice() {
    if (!sliceStreamRef.current || !activeRef.current) return;
    slicePartsRef.current = [];
    chunkStartMsRef.current = getActiveMs();

    const rec = new MediaRecorder(
      sliceStreamRef.current,
      mimeRef.current ? { mimeType: mimeRef.current } : undefined,
    );
    rec.ondataavailable = (e) => { if (e.data.size > 0) slicePartsRef.current.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(slicePartsRef.current, { type: mimeRef.current || 'audio/webm' });
      const seq = seqRef.current++;
      const timeOffset = chunkStartMsRef.current / 1000;
      if (blob.size > 500 && sessionRef.current !== null) {
        api.sendChunk(sessionRef.current, seq, timeOffset, blob).catch(() => {});
      }
      if (activeRef.current) startSlice();
    };
    rec.start();
    sliceRecRef.current = rec;

    // 최대 청크 길이 안전 상한
    maxChunkTimerRef.current = setTimeout(flushChunk, MAX_CHUNK_MS);
  }

  // ── VAD 루프 ───────────────────────────────────────────────────────────────

  function startVAD() {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (!activeRef.current) return;
      analyser.getByteFrequencyData(data);
      const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);

      if (rms < SILENCE_THRESHOLD) {
        if (!silenceStartRef.current) silenceStartRef.current = Date.now();
        else if (Date.now() - silenceStartRef.current >= SILENCE_MS) {
          silenceStartRef.current = null;
          flushChunk();
        }
      } else {
        silenceStartRef.current = null;
      }
      vadRafRef.current = requestAnimationFrame(tick);
    };
    vadRafRef.current = requestAnimationFrame(tick);
  }

  function stopVAD() {
    if (vadRafRef.current !== null) cancelAnimationFrame(vadRafRef.current);
    vadRafRef.current = null;
    silenceStartRef.current = null;
  }

  // ── 녹음 제어 ──────────────────────────────────────────────────────────────

  async function start() {
    setError(''); setLiveSegs([]); setElapsedMs(0);
    seqRef.current = 0;
    recordingStartMsRef.current = Date.now();
    totalPausedMsRef.current = 0;
    pauseStartMsRef.current = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      mimeRef.current = pickMime();

      const session = await api.createSession();
      sessionRef.current = session.id;
      setSessionId(session.id);

      // SSE 구독 (청크 전사 결과 수신)
      const es = new EventSource(api.eventsUrl(session.id));
      sseRef.current = es;
      es.onmessage = (e) => {
        const ev: SseEvent = JSON.parse(e.data);
        if (ev.type === 'segment') {
          setLiveSegs((prev) => [...prev, { text: ev.text, start: ev.start, end: ev.end }]);
        }
      };

      // VAD 청크 전송용 클론 스트림
      sliceStreamRef.current = new MediaStream(stream.getAudioTracks().map((t) => t.clone()));

      // VAD 설정
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      activeRef.current = true;
      setStatus('recording');
      startTick();
      startSlice();
      startVAD();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function pause() {
    activeRef.current = false;
    pauseStartMsRef.current = Date.now();
    stopVAD();
    if (maxChunkTimerRef.current) { clearTimeout(maxChunkTimerRef.current); maxChunkTimerRef.current = null; }
    if (sliceRecRef.current && sliceRecRef.current.state !== 'inactive') sliceRecRef.current.stop();
    stopTick();
    setStatus('paused');
  }

  function resume() {
    if (pauseStartMsRef.current !== null) {
      totalPausedMsRef.current += Date.now() - pauseStartMsRef.current;
      pauseStartMsRef.current = null;
    }
    activeRef.current = true;
    setStatus('recording');
    startTick();
    startSlice();
    startVAD();
  }

  async function finish() {
    activeRef.current = false;
    setBusy(true);
    stopTick();
    stopVAD();
    if (maxChunkTimerRef.current) { clearTimeout(maxChunkTimerRef.current); maxChunkTimerRef.current = null; }
    if (sliceRecRef.current && sliceRecRef.current.state !== 'inactive') sliceRecRef.current.stop();
    setStatus('idle');

    // SSE 연결 종료 (MeetingView에서 새로 구독)
    sseRef.current?.close();
    sseRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    sliceStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    analyserRef.current = null;

    const id = sessionRef.current!;
    try {
      await api.finishSession(id); // 즉시 리턴 (백그라운드 화자분리 시작)
      // 스케치패드 자동저장 debounce 완료 대기
      await new Promise((r) => setTimeout(r, 500));
      await refresh();
      navigate(`/m/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const active = status !== 'idle';
  const liveBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = liveBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveSegs]);

  return (
    <div className="rec-split">
      <div className="rec-left">
        <div className="rec-hero">
          <h1>회의 녹음</h1>
          <p>버튼을 누르면 바로 녹음이 시작됩니다. 말이 끊기면 자동으로 전사됩니다.</p>

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

          {active && <div className="rec-time">{fmtElapsed(elapsedMs)}</div>}

          <div className="rec-status">
            {status === 'recording' && <span><span className="dot">●</span> 녹음 중…</span>}
            {status === 'paused' && <span>⏸ 일시정지됨</span>}
            {busy && <span>처리 중…</span>}
            {error && <span className="err">{error}</span>}
          </div>

          {active && (
            <button className="finish-btn" onClick={finish} disabled={busy}>
              <Square size={14} /> 종료
            </button>
          )}
        </div>

        {active && (
          <div className="live-panel">
            <div className="live-head">실시간 전사</div>
            <div className="live-body" ref={liveBodyRef}>
              {liveSegs.length === 0 ? (
                <span className="live-wait">말씀하시면 전사됩니다…</span>
              ) : (
                liveSegs.map((s, i) => (
                  <div key={i} className={i === liveSegs.length - 1 ? 'live-line live-last' : 'live-line'}>
                    {s.text}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <div className="rec-right">
        {sessionId !== null ? (
          <SketchpadPanel meetingId={sessionId} />
        ) : (
          <div className="rec-sketch-idle">✏️<br />녹음을 시작하면<br />스케치패드가 열립니다</div>
        )}
      </div>
    </div>
  );
}
