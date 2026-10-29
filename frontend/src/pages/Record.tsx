import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, Square, Pause, Play, AlertTriangle, RefreshCw } from 'lucide-react';
import { api, SseEvent } from '../api';
import { useMeetings } from '../store';
import { useUploader } from '../uploader';
import { dialog } from '../ui/dialog';
import { diag, flushDiag } from '../diag';
import { appendFull, beginLocal, enqueueSlice, kickQueue, localRec, setLocalTitle, setRecordedMs, useLocalRec } from '../localRec';
import { Sketch } from '../components/SketchpadLazy';

// VAD 설정
const SILENCE_THRESHOLD = 8;    // RMS 임계값 (0-255 스케일)
const SILENCE_MS = 700;         // 이 시간 이상 무음이면 청크 종료
const MAX_CHUNK_MS = 5_000;     // 최대 청크 길이 (안전 상한 — 5초)

// 마이크 끊김 감시 (2026-10-29 meeting 80 재발방지: iPad 에서 트랙이 1초 만에 죽었는데 UI 는 계속 "녹음 중")
const FULL_SLICE_MS = 10_000;     // 전체 녹음 timeslice — 이 주기로 IndexedDB 에 append
const STALL_MS = 25_000;          // 전체 녹음 데이터가 이만큼 안 들어오면 정지로 판단(timeslice 가 동작하는 브라우저만)
const MUTE_GRACE_MS = 3_000;      // mute 후 이 시간 안에 unmute 되면 일시적 끊김으로 보고 넘어간다
const WATCH_MS = 5_000;           // 상태 점검 주기
const HEARTBEAT_MS = 30_000;      // 서버 무음 감시용 생존 신호 주기

// 일시정지 오탭 방지 (2026-10-29 실제 원인: 시작 버튼이 같은 자리에서 일시정지 토글로 바뀌어,
// 시작 직후의 두 번째 터치(더블탭·펜/손바닥)가 곧바로 일시정지 → 3시간 동안 일시정지 상태로 회의가 진행됨)
const PAUSE_LOCK_MS = 2_000;      // 시작/재개 직후 이 시간 동안 일시정지 버튼 잠금(확인 대화상자는 두지 않는다 — 의도적 일시정지에 마찰 없음)
const VERIFY_REQUEST_MS = 2_000;  // 새 녹음 구간 시작 후 이때까지 데이터가 없으면 requestData() 로 강제 방출
const VERIFY_FAIL_MS = 12_000;    // 그래도 이때까지 데이터(size>0)가 없으면 경고 + 재획득
const CONFIRM_GRACE_MS = 3_000;   // 타이머: 마지막 데이터 후 FULL_SLICE_MS+이 시간 안이면 녹음 중으로 확인
const TINY_WARN = 3;              // 비어 있는(≤500B) 전사 조각이 연속 이만큼이면 화면 경고
const TINY_RECONNECT = 6;         // 연속 이만큼이면 마이크 재획득
const PAUSE_ALERT_MS = 2 * 60_000; // 일시정지가 이보다 길어지면 진동·비프·로컬 알림, 이후 같은 간격으로 반복

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

/** 마이크 경고: lost=끊김(needTap 이면 사용자 탭으로만 재획득 가능), recovered=재연결됨(누락 구간 안내) */
type MicAlert =
  | { kind: 'lost'; reason: string; needTap: boolean; busy: boolean }
  | { kind: 'recovered'; gapSec: number };

/** 경보: 진동(지원 시) + 짧은 비프 2회(오디오 출력이 허용될 때만). 실패는 무시. */
function alarm() {
  try { navigator.vibrate?.([400, 150, 400]); } catch { /* 미지원 */ }
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    void ctx.resume().catch(() => {});
    [0, 0.35].forEach((t0) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = 880;
      g.gain.value = 0.25;
      osc.connect(g).connect(ctx.destination);
      osc.start(ctx.currentTime + t0);
      osc.stop(ctx.currentTime + t0 + 0.2);
    });
    setTimeout(() => { void ctx.close().catch(() => {}); }, 1500);
  } catch { /* 무시 */ }
}

/** 화면이 숨겨진 상태면 로컬 알림(권한이 이미 있을 때만 — 여기서 권한을 묻지 않는다). */
function localNotify(meetingId: number, body: string, title = '녹음이 중단되었습니다', tag = `rec-mic-${meetingId}`) {
  try {
    if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    void navigator.serviceWorker?.ready.then((r) =>
      r.showNotification(title, { body, tag, data: { url: '/' } }),
    ).catch(() => {});
  } catch { /* 무시 */ }
}

export default function Record() {
  const [status, setStatus] = useState<Status>('idle');
  const [busy, setBusy] = useState(false);
  const [liveSegs, setLiveSegs] = useState<LiveSeg[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  // 타이머 표시 상태: ok=데이터 수신 확인, checking=새 구간에서 아직 데이터 없음, stalled=데이터가 끊김
  const [timeState, setTimeState] = useState<'ok' | 'checking' | 'stalled'>('checking');
  const confirmedMsRef = useRef(0);
  const [error, setError] = useState('');
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [micAlert, setMicAlert] = useState<MicAlert | null>(null);
  const pendingSlices = useLocalRec((s) => s.pending);
  const storageError = useLocalRec((s) => s.storageError);
  const statusRef = useRef<Status>('idle');
  statusRef.current = status;
  const [pauseLocked, setPauseLocked] = useState(false); // 시작/재개 직후 일시정지 잠금(오탭 방지)
  const pauseUnlockAtRef = useRef(0);
  const [pausedForMs, setPausedForMs] = useState(0);
  const [dataWarn, setDataWarn] = useState('');
  const [resuming, setResuming] = useState(false);
  const sendFailures = useLocalRec((s) => s.sendFailures);
  const lastSendError = useLocalRec((s) => s.lastSendError);
  const [title, setTitle] = useState('');
  const savedTitleRef = useRef('');   // 서버에 반영된 제목(생성 시 전달 또는 마지막 PATCH)
  const titleRef = useRef('');
  titleRef.current = title;
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
  // 저장용 연속 녹음(전체 파일). 미리보기용 3초 조각(slice)과 별개로 같은 스트림을 한 번에 이어서 녹음한다.
  // 마이크를 다시 잡으면 녹음기를 새로 만들어야 하므로 "세대(gen)" 단위로 따로 모은다(세대 = 독립 파일 1개).
  const fullRecRef = useRef<MediaRecorder | null>(null);
  const fullGensRef = useRef<{ type: string; parts: Blob[] }[]>([]);
  const fullSeqRef = useRef(0);                         // IndexedDB 키용 전체 조각 순번(세대 무관 증가)
  const intendedStopRef = useRef(new WeakSet<MediaRecorder>()); // 우리가 멈춘 녹음기(그 외 stop = 이상)
  const lastFullDataRef = useRef(0);                    // 마지막 전체 조각 수신 시각
  const fullTimesliceOkRef = useRef(false);             // 이 세대에서 timeslice 조각이 한 번이라도 왔는가

  // 마이크 끊김/재연결
  const reconnectingRef = useRef(false);
  const needReconnectRef = useRef(false);               // 일시정지/백그라운드라 재획득을 미룸
  const lostAtRef = useRef<number | null>(null);
  const genDataSeenRef = useRef(false);                 // 현재 구간에서 데이터(size>0)가 한 번이라도 왔는가(재개 직후 검증)
  const requestedDataRef = useRef(false);               // requestData() 로 강제한 방출(timeslice 동작 판정에서 제외)
  const verifyTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const tinySlicesRef = useRef(0);                      // 연속으로 비어 있던 전사 조각 수
  const resumingRef = useRef(false);
  const muteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimesRef = useRef<number[]>([]);       // 자동 재연결 시각(폭주 방지)
  const tapRequiredRef = useRef(false);                 // 자동 재연결 포기 → 사용자 탭 대기

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

  // 타이머는 "실제로 녹음 데이터가 들어오고 있는 시간"만 센다 — 재개했는데 녹음기가 데이터를 안 내면 멈춰 있어야 한다.
  // 현재 구간에서 데이터가 한 번이라도 왔고(genDataSeen) 마지막 데이터가 timeslice+여유 안이면 확인된 것으로 보고 전진,
  // 아니면 마지막으로 확인된 값에 고정한다(데이터가 오면 녹음기가 그 사이도 담고 있으므로 따라잡는다).
  function startTick() {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      const ok = genDataSeenRef.current && Date.now() - lastFullDataRef.current < FULL_SLICE_MS + CONFIRM_GRACE_MS;
      if (ok) confirmedMsRef.current = Math.max(confirmedMsRef.current, getActiveMs());
      setElapsedMs(confirmedMsRef.current);
      setTimeState(ok ? 'ok' : genDataSeenRef.current ? 'stalled' : 'checking');
    }, 200);
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

    const stream = sliceStreamRef.current;
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mimeRef.current ? { mimeType: mimeRef.current } : undefined);
      rec.start();
    } catch (e) {
      // 트랙이 죽은 스트림이면 여기서 실패한다 — 예전엔 조용히 끊겨 이후 조각이 하나도 안 갔다
      micProblem(`전사 조각 녹음 실패: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    rec.ondataavailable = (e) => { if (e.data.size > 0) slicePartsRef.current.push(e.data); };
    rec.onerror = () => micProblem('전사 조각 녹음기 오류');
    rec.onstop = () => {
      const blob = new Blob(slicePartsRef.current, { type: mimeRef.current || 'audio/webm' });
      const seq = seqRef.current++;
      const timeOffset = chunkStartMsRef.current / 1000;
      const mid = sessionRef.current;
      if (blob.size > 500 && mid !== null) {
        // IndexedDB 에 먼저 남기고 전송 — 실패하면 큐가 백오프로 재시도
        enqueueSlice(mid, seq, timeOffset, blob);
        if (tinySlicesRef.current) { tinySlicesRef.current = 0; setDataWarn(''); }
      } else if (mid !== null) {
        // 예전엔 여기서 조용히 버렸다(meeting 80 은 재개 후 3시간 동안 이 경로였을 수 있다) → 기록·연속이면 경고
        diag(mid, 'slice_tiny', { seq, size: blob.size, parts: slicePartsRef.current.length, active: activeRef.current });
        if (activeRef.current && sliceStreamRef.current === stream) {
          const n = ++tinySlicesRef.current;
          if (n === TINY_WARN) setDataWarn(`전사 조각이 연속 ${n}개 비어 있습니다 — 마이크 입력을 확인하세요`);
          if (n >= TINY_RECONNECT) { tinySlicesRef.current = 0; micProblem('마이크 입력 데이터가 비어 있습니다'); return; }
        }
      }
      // 같은 스트림일 때만 다음 조각(재연결 중 옛 스트림의 onstop 이 새 조각을 만들지 않도록)
      if (activeRef.current && sliceStreamRef.current === stream) startSlice();
    };
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

  // ── 스트림/녹음기 구성 ──────────────────────────────────────────────────────

  /** 새 마이크 스트림에 감시·VAD·전체 녹음기(새 세대)를 붙인다. 시작과 재연결이 공유. */
  function attachStream(stream: MediaStream) {
    streamRef.current = stream;
    const mid = sessionRef.current!;
    for (const t of stream.getAudioTracks()) {
      diag(mid, 'track', { label: t.label, state: t.readyState, muted: t.muted, settings: t.getSettings?.() });
      t.addEventListener('ended', () => {
        diag(mid, 'track_ended', { current: streamRef.current === stream });
        if (streamRef.current === stream) micProblem('마이크 연결이 끊겼습니다');
      });
      t.addEventListener('mute', () => {
        diag(mid, 'track_mute', { current: streamRef.current === stream });
        if (streamRef.current !== stream) return;
        // iOS 는 전화·Siri·다른 앱 오디오로 잠시 mute 됐다가 돌아오기도 한다 → 잠깐 기다렸다 판단
        if (muteTimerRef.current) clearTimeout(muteTimerRef.current);
        muteTimerRef.current = setTimeout(() => {
          muteTimerRef.current = null;
          if (streamRef.current === stream && t.muted) micProblem('마이크 입력이 중단되었습니다(다른 앱/화면 잠금)');
        }, MUTE_GRACE_MS);
      });
      t.addEventListener('unmute', () => {
        diag(mid, 'track_unmute', { current: streamRef.current === stream });
        if (muteTimerRef.current) { clearTimeout(muteTimerRef.current); muteTimerRef.current = null; }
      });
    }

    // VAD 청크 전송용 클론 스트림
    sliceStreamRef.current = new MediaStream(stream.getAudioTracks().map((t) => t.clone()));

    // VAD 설정
    try {
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
    } catch { analyserRef.current = null; /* VAD 없이도 MAX_CHUNK_MS 로 조각은 나간다 */ }

    // 전체 녹음: timeslice 로 주기적으로 dataavailable 을 받아 긴 녹음에서도 한 덩어리 버퍼링을 피한다.
    // 받는 즉시 IndexedDB 에 append → 탭이 죽어도 다음 실행 때 복구할 수 있다.
    // 일시정지/재개도 이 경로로 새 구간을 만든다(MediaRecorder.pause/resume 은 쓰지 않는다 — Safari 에서 재개 후 데이터 0)
    const gen = fullGensRef.current.length;
    const full = new MediaRecorder(stream, mimeRef.current ? { mimeType: mimeRef.current } : undefined);
    const bucket = { type: full.mimeType || mimeRef.current || 'audio/webm', parts: [] as Blob[] };
    fullGensRef.current.push(bucket);
    let genBytes = 0;
    full.ondataavailable = (e) => {
      diag(mid, 'full_data', { gen, size: e.data.size, state: full.state, forced: requestedDataRef.current });
      if (e.data.size <= 0) return;
      bucket.parts.push(e.data);
      genBytes += e.data.size;
      lastFullDataRef.current = Date.now();
      if (fullRecRef.current === full) {
        genDataSeenRef.current = true;
        if (requestedDataRef.current) requestedDataRef.current = false;
        else if (full.state !== 'inactive') fullTimesliceOkRef.current = true;
      }
      void appendFull(mid, gen, fullSeqRef.current++, e.data);
      setRecordedMs(mid, Math.max(0, getActiveMs()));
    };
    full.onerror = (e) => {
      const err = (e as Event & { error?: DOMException }).error;
      diag(mid, 'full_error', { gen, name: err?.name, msg: err?.message, state: full.state });
      if (fullRecRef.current === full) micProblem('녹음기 오류가 발생했습니다');
    };
    full.onstart = () => diag(mid, 'full_start', { gen, mime: full.mimeType, state: full.state });
    full.onstop = () => {
      const intended = intendedStopRef.current.has(full);
      diag(mid, 'full_stop', { gen, intended, bytes: genBytes, parts: bucket.parts.length });
      // 우리가 멈춘 게 아닌데 멈췄다(Safari 는 트랙이 끝나면 녹음기를 스스로 멈춘다)
      if (!intended && fullRecRef.current === full) micProblem('녹음이 예기치 않게 중단되었습니다');
    };
    full.start(FULL_SLICE_MS);
    fullRecRef.current = full;
    fullTimesliceOkRef.current = false;
    lastFullDataRef.current = Date.now();

    // 구간 시작 직후 검증: 실제 데이터가 나오는지 확인(재개 직후 25초 정지 감시보다 엄격하게)
    genDataSeenRef.current = false;
    requestedDataRef.current = false;
    clearVerify();
    verifyTimersRef.current = [
      setTimeout(() => {
        if (fullRecRef.current !== full || genDataSeenRef.current || full.state !== 'recording') return;
        requestedDataRef.current = true;
        try { full.requestData(); } catch { /* 미지원 */ }
      }, VERIFY_REQUEST_MS),
      setTimeout(() => {
        if (fullRecRef.current !== full || genDataSeenRef.current || statusRef.current !== 'recording') return;
        diag(mid, 'verify_fail', { gen, state: full.state, track: stream.getAudioTracks()[0]?.readyState, muted: stream.getAudioTracks()[0]?.muted });
        micProblem('녹음을 시작했지만 데이터가 들어오지 않습니다');
      }, VERIFY_FAIL_MS),
    ];
  }

  function clearVerify() {
    verifyTimersRef.current.forEach(clearTimeout);
    verifyTimersRef.current = [];
  }

  /** 현재 스트림/녹음기 정리(재연결 전). 마지막 조각들은 각자의 onstop/ondataavailable 로 저장·전송된다. */
  function detachStream() {
    clearVerify();
    activeRef.current = false; // 슬라이스 onstop 이 옛 스트림으로 다음 조각을 만들지 않게
    stopVAD();
    if (maxChunkTimerRef.current) { clearTimeout(maxChunkTimerRef.current); maxChunkTimerRef.current = null; }
    if (sliceRecRef.current && sliceRecRef.current.state !== 'inactive') {
      try { sliceRecRef.current.stop(); } catch { /* 이미 멈춤 */ }
    }
    sliceRecRef.current = null;
    const full = fullRecRef.current;
    fullRecRef.current = null;
    if (full) {
      intendedStopRef.current.add(full);
      if (full.state !== 'inactive') { try { full.stop(); } catch { /* 이미 멈춤 */ } }
    }
    if (muteTimerRef.current) { clearTimeout(muteTimerRef.current); muteTimerRef.current = null; }
    sliceStreamRef.current?.getTracks().forEach((t) => t.stop());
    sliceStreamRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
  }

  // ── 마이크 끊김 감지 · 재연결 ────────────────────────────────────────────────

  /** 끊김 감지 진입점(트랙 ended/mute, 녹음기 error/예기치 않은 stop, 정지 감시). */
  function micProblem(reason: string) {
    if (statusRef.current === 'idle' || sessionRef.current === null || reconnectingRef.current) return;
    diag(sessionRef.current, 'mic_problem', { reason, status: statusRef.current, hidden: document.hidden });
    if (lostAtRef.current === null) {
      lostAtRef.current = Date.now();
      alarm();
      localNotify(sessionRef.current, reason);
    }
    if (tapRequiredRef.current) {
      setMicAlert({ kind: 'lost', reason, needTap: true, busy: false });
      return;
    }
    setMicAlert({ kind: 'lost', reason, needTap: false, busy: false });
    if (statusRef.current === 'paused' || document.hidden) {
      // 일시정지 중이면 재개 버튼(사용자 제스처)에서, 백그라운드면 화면 복귀 시 다시 잡는다
      needReconnectRef.current = true;
      return;
    }
    // 1분에 3번 넘게 자동 재연결했는데도 계속 끊기면 더 돌지 않고 사용자 탭을 기다린다
    const now = Date.now();
    reconnectTimesRef.current = reconnectTimesRef.current.filter((t) => now - t < 60_000);
    if (reconnectTimesRef.current.length >= 3) {
      tapRequiredRef.current = true;
      setMicAlert({ kind: 'lost', reason: `${reason} — 자동 재연결이 반복 실패했습니다`, needTap: true, busy: false });
      return;
    }
    reconnectTimesRef.current.push(now);
    void reconnect(reason);
  }

  /** getUserMedia 로 마이크를 다시 잡아 녹음을 이어간다. 실패하면 "탭해서 재개" 버튼(사용자 제스처)으로. */
  async function reconnect(reason: string) {
    // 일시정지 중엔 스트림이 없다 — 재개(resume)가 새로 잡는다
    if (reconnectingRef.current || sessionRef.current === null || statusRef.current !== 'recording') return;
    reconnectingRef.current = true;
    needReconnectRef.current = false;
    setMicAlert({ kind: 'lost', reason, needTap: false, busy: true });
    const mid = sessionRef.current;
    diag(mid, 'reconnect_begin', { reason });
    detachStream();
    const detachedAt = Date.now();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // await 동안 종료/일시정지됐을 수 있다(ref 라 TS 좁히기를 풀어 다시 읽는다)
      if ((statusRef.current as Status) !== 'recording' || sessionRef.current === null) { stream.getTracks().forEach((t) => t.stop()); return; }
      // 녹음기가 없던 구간은 타임라인(활성 시간)에서 뺀다 → 전사 조각 오프셋이 이어 붙인 원본과 맞는다
      const holdFrom = pauseStartMsRef.current ?? detachedAt; // 앞선 재획득 실패로 시간을 멈춰 뒀으면 그때부터
      totalPausedMsRef.current += Date.now() - holdFrom;
      pauseStartMsRef.current = null;
      attachStream(stream);
      activeRef.current = true;
      startSlice();
      startVAD();
      const gapMs = lostAtRef.current ? Date.now() - lostAtRef.current : 0;
      const gapSec = Math.round(gapMs / 1000);
      diag(mid, 'reconnect_ok', { gapMs, gen: fullGensRef.current.length - 1 });
      lostAtRef.current = null;
      tapRequiredRef.current = false;
      setMicAlert({ kind: 'recovered', gapSec });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      tapRequiredRef.current = true; // 제스처가 필요하거나 권한 거부 — 자동으로 다시 돌지 않는다
      diag(mid, 'reconnect_fail', { name: (e as DOMException | null)?.name, msg });
      // 녹음기 없는 시간은 타임라인에서 빼야 하므로 일시정지와 같은 방식으로 시간을 멈춰 둔다
      if (pauseStartMsRef.current === null) pauseStartMsRef.current = detachedAt;
      setMicAlert({ kind: 'lost', reason: `${reason} — 마이크를 다시 열 수 없습니다(${msg})`, needTap: true, busy: false });
    } finally {
      reconnectingRef.current = false;
    }
  }

  /** 트랙·녹음기 상태 점검(주기 + 화면 복귀). 이벤트 없이 조용히 죽는 경우를 잡는다. */
  function checkHealth() {
    if (statusRef.current !== 'recording' || reconnectingRef.current) return;
    if (needReconnectRef.current) { micProblem('마이크 연결이 끊겼습니다'); return; }
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') { micProblem('마이크 연결이 끊겼습니다'); return; }
    const full = fullRecRef.current;
    if (!full || full.state === 'inactive') { micProblem('녹음이 예기치 않게 중단되었습니다'); return; }
    if (fullTimesliceOkRef.current && Date.now() - lastFullDataRef.current > STALL_MS) {
      micProblem('녹음 데이터가 들어오지 않습니다');
      return;
    }
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {}); // iOS 'interrupted' → VAD 복구
  }

  // ── 녹음 제어 ──────────────────────────────────────────────────────────────

  async function start() {
    setError(''); setLiveSegs([]); setElapsedMs(0);
    confirmedMsRef.current = 0; setTimeState('checking');
    seqRef.current = 0;
    recordingStartMsRef.current = Date.now();
    totalPausedMsRef.current = 0;
    pauseStartMsRef.current = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mimeRef.current = pickMime();

      const session = await api.createSession(title);
      sessionRef.current = session.id;
      savedTitleRef.current = title.trim();
      setSessionId(session.id);
      localRec.setActive(session.id);
      void beginLocal(session.id, title.trim());
      fullGensRef.current = [];
      fullSeqRef.current = 0;
      tinySlicesRef.current = 0;
      setDataWarn('');
      setMicAlert(null);
      diag(session.id, 'start', {
        ua: navigator.userAgent, mime: mimeRef.current,
        standalone: window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
      });

      // SSE 구독 (청크 전사 결과 수신)
      const es = new EventSource(api.eventsUrl(session.id));
      sseRef.current = es;
      es.onmessage = (e) => {
        const ev: SseEvent = JSON.parse(e.data);
        if (ev.type === 'segment') {
          setLiveSegs((prev) => [...prev, { text: ev.text, start: ev.start, end: ev.end }]);
        }
      };

      attachStream(stream);

      activeRef.current = true;
      setStatus('recording');
      statusRef.current = 'recording';
      lockPause();
      startTick();
      startSlice();
      startVAD();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** 일시정지: MediaRecorder.pause() 대신 전체·전사 녹음기를 모두 stop 해 구간을 확정(IndexedDB 저장)하고
   *  마이크도 놓는다. Safari 26 에서 pause→resume 뒤 데이터가 0 이었던 사고(meeting 80)의 재발방지. */
  function pause() {
    if (statusRef.current !== 'recording') return;
    const mid = sessionRef.current;
    pauseStartMsRef.current = Date.now();
    stopTick();
    detachStream(); // 슬라이스 onstop → 마지막 조각 전송, full onstop → 마지막 데이터 append
    tinySlicesRef.current = 0;
    setDataWarn('');
    setStatus('paused');
    statusRef.current = 'paused';
    diag(mid, 'pause', { activeMs: getActiveMs(), gens: fullGensRef.current.length });
    void flushDiag(mid ?? undefined);
  }

  /** 재개: 항상 getUserMedia 로 새 스트림을 받아 새 녹음기 구간을 시작한다(사용자 제스처 안에서 호출됨).
   *  타임라인(활성 시간)은 실제로 녹음이 다시 시작되는 순간에 일시정지를 끝내 이어 붙인 원본과 오프셋을 맞춘다. */
  async function resume() {
    if (statusRef.current !== 'paused' || resumingRef.current || sessionRef.current === null) return;
    resumingRef.current = true;
    setResuming(true);
    const mid = sessionRef.current;
    diag(mid, 'resume_begin', {});
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if ((statusRef.current as Status) !== 'paused') { stream.getTracks().forEach((t) => t.stop()); return; }
      if (pauseStartMsRef.current !== null) {
        totalPausedMsRef.current += Date.now() - pauseStartMsRef.current;
        pauseStartMsRef.current = null;
      }
      setStatus('recording');
      statusRef.current = 'recording';
      attachStream(stream);
      activeRef.current = true;
      lostAtRef.current = null;
      tapRequiredRef.current = false;
      needReconnectRef.current = false;
      setMicAlert(null);
      lockPause();
      startTick();
      startSlice();
      startVAD();
      diag(mid, 'resume_ok', { activeMs: getActiveMs(), gen: fullGensRef.current.length - 1 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      diag(mid, 'resume_fail', { name: (e as DOMException | null)?.name, msg });
      alarm();
      setMicAlert({ kind: 'lost', reason: `마이크를 다시 열 수 없습니다(${msg})`, needTap: true, busy: false });
    } finally {
      resumingRef.current = false;
      setResuming(false);
    }
  }

  /** 시작/재개 직후 PAUSE_LOCK_MS 동안 일시정지 입력 무시. */
  function lockPause() {
    pauseUnlockAtRef.current = Date.now() + PAUSE_LOCK_MS;
    setPauseLocked(true);
    setTimeout(() => setPauseLocked(false), PAUSE_LOCK_MS);
  }

  /** 일시정지 요청: 시작/재개 직후 잠금 시간만 무시(확인 대화상자 없음 — 의도적 일시정지에 마찰을 두지 않는다). */
  function requestPause() {
    if (statusRef.current !== 'recording' || Date.now() < pauseUnlockAtRef.current) return;
    pause();
  }

  /** 종료 요청: 오탭으로 회의 도중 종료되지 않게 확인을 거친다. */
  async function requestFinish() {
    if (statusRef.current === 'idle') return;
    const ok = await dialog.confirmGuarded('녹음을 종료할까요?', '종료하면 녹음을 업로드하고 전사·회의록 생성을 시작합니다. 이어서 녹음할 수 없습니다.', '종료');
    if (ok && (statusRef.current as Status) !== 'idle') void finish();
  }

  /** "탭해서 재개" — 사용자 제스처 안에서 getUserMedia 를 다시 호출한다. */
  function tapReconnect() {
    tapRequiredRef.current = false;
    reconnectTimesRef.current = [];
    if (statusRef.current === 'paused') { void resume(); return; }
    void reconnect('마이크 연결이 끊겼습니다');
  }

  /** 전체 녹음을 멈추고 세대별 Blob 목록으로 돌려준다(빈 세대 제외, 전부 비면 []).
   *  녹음기가 이미 inactive(트랙 종료로 스스로 멈춤 등)여도 모아 둔 데이터는 버리지 않는다. */
  function stopFullRecording(): Promise<Blob[]> {
    const rec = fullRecRef.current;
    fullRecRef.current = null;
    const collect = () => {
      const out = fullGensRef.current
        .map((g) => new Blob(g.parts, { type: g.type }))
        .filter((b) => b.size > 0);
      fullGensRef.current = [];
      return out;
    };
    if (!rec || rec.state === 'inactive') return Promise.resolve(collect());
    intendedStopRef.current.add(rec);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(collect()); } };
      rec.addEventListener('stop', finish);
      setTimeout(finish, 3000); // stop 이벤트가 안 오는 브라우저 대비
      try { rec.stop(); } catch { finish(); }
    });
  }

  async function finish() {
    activeRef.current = false;
    statusRef.current = 'idle';
    needReconnectRef.current = false;
    tapRequiredRef.current = false;
    reconnectTimesRef.current = [];
    lostAtRef.current = null;
    setMicAlert(null);
    setBusy(true);
    stopTick();
    stopVAD();
    if (maxChunkTimerRef.current) { clearTimeout(maxChunkTimerRef.current); maxChunkTimerRef.current = null; }
    if (sliceRecRef.current && sliceRecRef.current.state !== 'inactive') sliceRecRef.current.stop();
    setStatus('idle');

    // SSE 연결 종료 (MeetingView에서 새로 구독)
    sseRef.current?.close();
    sseRef.current = null;

    sliceStreamRef.current?.getTracks().forEach((t) => t.stop());
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;

    const id = sessionRef.current!;
    try {
      const blobs = await stopFullRecording();
      diag(id, 'finish', { activeMs: getActiveMs(), segments: blobs.map((b) => b.size), slicesSent: seqRef.current });
      void flushDiag(id);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      localRec.setActive(null);
      // 업로드는 전역 업로더가 맡고(라우트 이동에도 유지), 완료 후 /finish 까지 호출한다.
      // 전체 녹음이 없으면(MediaRecorder 실패 등) 조각 복구로 바로 finish(미전송 조각을 먼저 보낸다).
      // 로컬 백업(IndexedDB)은 업로드 + /finish 성공 후에만 삭제된다 — 실패해도 다음 실행 때 복구 가능.
      if (blobs.length) useUploader.getState().start(id, blobs);
      else await useUploader.getState().recover(id);
      // 녹음 중 수정한 제목 중 아직 저장 안 된 것을 마저 반영
      const t = titleRef.current.trim();
      if (t && t !== savedTitleRef.current) { await api.renameMeeting(id, t).catch(() => {}); savedTitleRef.current = t; }
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

  // 녹음 중 제목 편집 → 디바운스 저장(비어 있으면 서버 기본 제목 유지)
  useEffect(() => {
    const id = sessionRef.current;
    const t = title.trim();
    if (!active || id === null || !t || t === savedTitleRef.current) return;
    const h = setTimeout(() => {
      setLocalTitle(id, t);
      api.renameMeeting(id, t).then(() => { savedTitleRef.current = t; refresh(); }).catch(() => {});
    }, 800);
    return () => clearTimeout(h);
  }, [title, active, sessionId, refresh]);

  // GPU 서버 선행 기동(진입 시 1회, 멱등) — 콜드 로드(~2.5분)를 녹음 시작 전에 끝내 둔다.
  useEffect(() => { api.gpuWarmup().catch(() => {}); }, []);

  // 녹음/일시정지 동안 GPU 유휴 절전을 막는다: 시작 시 1회 + 5분마다. 종료·이탈 시 중단.
  useEffect(() => {
    if (!active) return;
    const ping = () => { api.gpuCaffeine().catch(() => {}); };
    ping();
    const t = setInterval(ping, 5 * 60_000);
    return () => clearInterval(t);
  }, [active]);

  // 상태 점검(트랙·녹음기·데이터 정지) — 녹음/일시정지 동안
  useEffect(() => {
    if (!active) return;
    const t = setInterval(checkHealth, WATCH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 서버 무음 감시용 생존 신호: 상태가 바뀔 때 즉시 + 30초마다
  useEffect(() => {
    const id = sessionRef.current;
    if (!active || id === null) return;
    const beat = () => { api.sessionHeartbeat(id, status === 'paused' ? 'paused' : 'recording').catch(() => {}); };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [active, status, sessionId]);

  // 화면 꺼짐 방지(Screen Wake Lock) — 녹음/일시정지 중. 화면이 숨으면 브라우저가 해제하므로 복귀 시 재획득. 미지원이면 무시.
  useEffect(() => {
    if (!active) return;
    let lock: WakeLockSentinel | null = null;
    let disposed = false;
    const acquire = async () => {
      if (disposed || document.hidden || !('wakeLock' in navigator) || (lock && !lock.released)) return;
      try {
        lock = await navigator.wakeLock.request('screen');
        if (disposed) void lock.release().catch(() => {});
      } catch { /* 미지원·거부(저전력 모드 등) */ }
    };
    const onVis = () => { if (!document.hidden) void acquire(); };
    void acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => {});
    };
  }, [active]);

  // 백그라운드 → 복귀: 트랙 상태 점검 + 미뤄 둔 재연결 + 전송 큐 재시도
  useEffect(() => {
    if (!active) return;
    const onVis = () => {
      if (document.hidden) return;
      kickQueue();
      if (statusRef.current !== 'recording') return;
      const track = streamRef.current?.getAudioTracks()[0];
      if (needReconnectRef.current || !track || track.readyState === 'ended' || track.muted) {
        micProblem(track?.muted ? '마이크 입력이 중단되었습니다(다른 앱/화면 잠금)' : '마이크 연결이 끊겼습니다');
        return;
      }
      // 백그라운드 동안 타이머가 멈췄을 수 있으니 데이터 정지 판단에 유예를 준다(그 뒤에도 안 오면 checkHealth 가 잡는다)
      lastFullDataRef.current = Date.now();
      checkHealth();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pageshow', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pageshow', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 녹음 중 탭 닫기/새로고침 경고(닫혀도 로컬 백업은 남지만 녹음 자체는 끊긴다)
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);

  // 일시정지 경과 표시 + 장기 일시정지 반복 경고(PAUSE_ALERT_MS 마다 진동·비프·로컬 알림)
  useEffect(() => {
    if (status !== 'paused') { setPausedForMs(0); return; }
    let nextAlert = PAUSE_ALERT_MS;
    const t = setInterval(() => {
      const since = pauseStartMsRef.current;
      if (since === null) return;
      const ms = Date.now() - since;
      setPausedForMs(ms);
      if (ms >= nextAlert) {
        nextAlert = ms + PAUSE_ALERT_MS;
        alarm();
        const id = sessionRef.current;
        if (id !== null) localNotify(id, `${Math.floor(ms / 60_000)}분째 일시정지 중입니다. 회의 중이라면 재개하세요.`, '녹음이 일시정지 상태입니다', `rec-paused-${id}`);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [status]);

  // 재연결 성공 안내는 잠시 뒤 자동으로 닫는다
  useEffect(() => {
    if (micAlert?.kind !== 'recovered') return;
    const t = setTimeout(() => setMicAlert((a) => (a?.kind === 'recovered' ? null : a)), 15_000);
    return () => clearTimeout(t);
  }, [micAlert]);

  const liveBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = liveBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveSegs]);

  return (
    <div className="rec-split">
      <div className="rec-left">
        {micAlert?.kind === 'lost' && (
          <div className="mic-alert" role="alert">
            <div className="mic-alert-title"><AlertTriangle size={26} /> 녹음이 중단되었습니다</div>
            <div className="mic-alert-reason">{micAlert.reason}</div>
            {micAlert.busy ? (
              <div className="mic-alert-busy"><RefreshCw size={16} className="spin" /> 마이크 다시 연결 중…</div>
            ) : (
              <button className="mic-alert-btn" onClick={tapReconnect}>
                <Mic size={20} /> {micAlert.needTap ? '탭해서 녹음 재개' : status === 'paused' ? '재개하면 다시 연결합니다' : '지금 다시 연결'}
              </button>
            )}
          </div>
        )}
        {status === 'paused' && micAlert?.kind !== 'lost' && (
          <div className="pause-alert" role="alert">
            <div className="pause-alert-title"><Pause size={24} /> 일시정지 중 — 지금 녹음되지 않고 있습니다</div>
            <div className="pause-alert-sub">{fmtElapsed(pausedForMs)}째 일시정지{pausedForMs >= PAUSE_ALERT_MS ? ' · 회의 중이라면 바로 재개하세요' : ''}</div>
            <button className="pause-alert-btn" onClick={() => void resume()} disabled={busy || resuming}><Play size={20} /> {resuming ? '재개 중…' : '녹음 재개'}</button>
          </div>
        )}
        {micAlert?.kind === 'recovered' && (
          <div className="mic-alert recovered" role="status">
            마이크를 다시 연결해 녹음을 이어갑니다{micAlert.gapSec > 0 ? ` · 약 ${micAlert.gapSec}초 누락` : ''}
            <button className="mic-alert-close" onClick={() => setMicAlert(null)} aria-label="닫기">✕</button>
          </div>
        )}
        <div className="rec-hero">
          <h1>회의 녹음</h1>
          <p>버튼을 누르면 바로 녹음이 시작됩니다. 말이 끊기면 자동으로 전사됩니다.</p>

          <input
            className="rec-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="제목 (선택, 비우면 자동)"
            maxLength={120}
            aria-label="회의 제목"
            disabled={busy}
          />

          {status === 'idle' ? (
            <button className="rec-btn" onClick={start} disabled={busy} aria-label="녹음 시작">
              <Mic size={34} />
            </button>
          ) : status === 'recording' ? (
            // 녹음 중 가운데는 버튼이 아닌 표시등 — 시작 버튼 자리에 일시정지가 오지 않게(오탭 방지)
            <div className="rec-btn recording rec-indicator" role="img" aria-label="녹음 중">
              <Mic size={34} />
            </div>
          ) : (
            // 일시정지 중 가운데는 재개 버튼(잘못 눌러도 녹음이 재개될 뿐이라 안전)
            <button className="rec-btn rec-resume" onClick={() => void resume()} disabled={busy || resuming} aria-label="녹음 재개">
              <Play size={30} />
            </button>
          )}

          {active && <div className={`rec-time${status === 'recording' && timeState !== 'ok' ? ' unconfirmed' : ''}`}>{fmtElapsed(elapsedMs)}</div>}

          <div className="rec-status">
            {status === 'recording' && micAlert?.kind !== 'lost' && timeState === 'ok' && <span><span className="dot">●</span> 녹음 중…</span>}
            {status === 'recording' && micAlert?.kind !== 'lost' && timeState === 'checking' && <span className="warn">녹음 확인 중… (데이터가 들어오면 시간이 흐릅니다)</span>}
            {status === 'recording' && micAlert?.kind !== 'lost' && timeState === 'stalled' && <span className="err">● 녹음 데이터가 들어오지 않습니다 — 시간 정지</span>}
            {status === 'recording' && micAlert?.kind === 'lost' && <span className="err">● 녹음 중단됨</span>}
            {status === 'paused' && <span>⏸ 일시정지됨</span>}
            {busy && <span>처리 중…</span>}
            {error && <span className="err">{error}</span>}
          </div>
          {active && (pendingSlices > 0 || storageError) && (
            <div className="rec-substatus">
              {pendingSlices > 0 && <div>전사 조각 {pendingSlices}개 전송 대기 — 자동 재시도 중(녹음은 기기에 보관됨)</div>}
              {storageError && <div className="err">{storageError}</div>}
            </div>
          )}
          {active && (dataWarn || sendFailures >= 3) && (
            <div className="rec-substatus">
              {dataWarn && <div className="err">{dataWarn}</div>}
              {sendFailures >= 3 && <div className="err">전사 조각 전송이 연속 {sendFailures}회 실패했습니다({lastSendError}) — 녹음은 기기에 보관되고 자동 재시도합니다</div>}
            </div>
          )}

          {active && (
            <div className="rec-controls">
              {status === 'recording' && (
                <button className="finish-btn pause-btn" onClick={requestPause} disabled={busy || pauseLocked} aria-label="일시정지">
                  <Pause size={14} /> 일시정지
                </button>
              )}
              <button className="finish-btn" onClick={requestFinish} disabled={busy}>
                <Square size={14} /> 종료
              </button>
            </div>
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
          <Sketch meetingId={sessionId} />
        ) : (
          <div className="rec-sketch-idle">✏️<br />녹음을 시작하면<br />스케치패드가 열립니다</div>
        )}
      </div>
    </div>
  );
}
