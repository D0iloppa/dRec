import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, ListMusic, PenLine, Play, Pause, Download, Copy, RefreshCw, Mic } from 'lucide-react';
import { api, MeetingDetail, Segment, SpeakerInfo, SseEvent } from '../api';
import { useMeetings } from '../store';
import { dialog } from '../ui/dialog';
import { Sketch, prefetchSketchpad } from '../components/SketchpadLazy';
import AudioCard from '../components/AudioCard';
import PipelineMonitor, { PipelineAction } from '../components/PipelineMonitor';
import { useUploader } from '../uploader';

// 상세 응답 전에 먼저 그려지는 페이지 뼈대: 사이드바 목록에 있는 제목/날짜를 미리 보여주고 나머지는 스켈레톤.
function MeetingShell({ id, error, onRetry }: { id: number; error: string; onRetry: () => void }) {
  const item = useMeetings((s) => s.items.find((m) => m.id === id));
  return (
    <div className="page" aria-busy={!error}>
      <div className="page-title page-title-ro">{item?.title || (error ? '회의를 불러오지 못했습니다' : '\u00a0')}</div>
      <div className="page-meta">
        {item ? <span>{new Date(item.created_at).toLocaleString('ko-KR')}</span> : <span className="skel" style={{ width: 150 }} />}
      </div>
      {error ? (
        <div className="pipeline failed">
          <div className="pipe-title">불러오기 실패</div>
          <div className="pipe-hint">{error}</div>
          <div className="pipe-actions"><button className="pipe-btn primary" onClick={onRetry}>다시 시도</button></div>
        </div>
      ) : (
        <>
          <div className="skel skel-card" />
          <div className="chips" aria-hidden>
            <span className="skel skel-chip" /><span className="skel skel-chip" /><span className="skel skel-chip" />
          </div>
          <div className="skel skel-line" style={{ width: '70%' }} />
          <div className="skel skel-line" />
          <div className="skel skel-line" style={{ width: '85%' }} />
          <div className="skel skel-line" style={{ width: '55%' }} />
        </>
      )}
    </div>
  );
}

type Tab = 'minutes' | 'transcript' | 'sketch';

const PALETTE = ['#e03e3e', '#e8830c', '#d9a400', '#0f9d58', '#2383e2', '#3b4fc4', '#7048e8'];
const colorOf = (label: string, speakers: string[], meta: Record<string, SpeakerInfo>) =>
  meta[label]?.color || PALETTE[Math.max(0, speakers.indexOf(label)) % PALETTE.length];
const nameOf = (label: string, meta: Record<string, SpeakerInfo>) => meta[label]?.name || label;

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 클라이언트 사이드 파일 다운로드
function downloadFile(content: string, filename: string, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// 자막 싱킹 플레이어
function SyncedTranscript({
  segments, speakers, meta, audioUrl, durationSec,
}: {
  segments: Segment[];
  speakers: string[];
  meta: Record<string, SpeakerInfo>;
  audioUrl: string;
  durationSec?: number | null;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [active, setActive] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(durationSec || 0);
  const [clipEnd, setClipEnd] = useState<number | null>(null);
  const rowsRef = useRef<(HTMLDivElement | null)[]>([]);

  function onTimeUpdate() {
    const t = audioRef.current?.currentTime ?? 0;
    setCur(t);
    if (clipEnd !== null && t >= clipEnd) {
      audioRef.current?.pause();
      setClipEnd(null);
    }
    const idx = segments.findIndex((s) => t >= s.start && t < s.end);
    if (idx !== active) {
      setActive(idx);
      if (idx >= 0) rowsRef.current[idx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function seekAndPlay(start: number, end?: number) {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = start;
    setClipEnd(end ?? null);
    a.play();
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    setClipEnd(null);
    if (a.paused) a.play(); else a.pause();
  }

  const curSpeaker = active >= 0 ? segments[active].speaker : null;
  const curColor = curSpeaker ? colorOf(curSpeaker, speakers, meta) : 'var(--text-dim)';

  return (
    <div>
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="none"
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDur(d); }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="transcript with-player">
        {segments.map((s, i) => {
          const color = colorOf(s.speaker, speakers, meta);
          return (
            <div
              key={i}
              ref={(el) => { rowsRef.current[i] = el; }}
              className={`seg${i === active ? ' active' : ''}`}
              style={{ borderLeft: `3px solid ${color}` }}
              onClick={() => seekAndPlay(s.start, s.end)}
              title="클릭: 구간 재생"
            >
              <span className="seg-time">{fmtTime(s.start)}</span>
              <span className="spk" style={{ color }}>{nameOf(s.speaker, meta)}</span> {s.text}
            </div>
          );
        })}
      </div>
      <div className="player-bar">
        <button className="player-play" onClick={togglePlay} aria-label={playing ? '일시정지' : '재생'}>
          {playing ? <Pause size={20} /> : <Play size={20} />}
        </button>
        {curSpeaker && <span className="player-spk" style={{ color: curColor }}>{nameOf(curSpeaker, meta)}</span>}
        <input
          className="player-seek"
          type="range" min={0} max={dur || 0} step={0.1}
          value={Math.min(cur, dur || 0)}
          onChange={(e) => { if (audioRef.current) { setClipEnd(null); audioRef.current.currentTime = Number(e.target.value); } }}
        />
        <span className="player-time">{fmtTime(cur)} / {fmtTime(dur)}</span>
        <a className="player-dl" href={audioUrl} download title="오디오 다운로드" aria-label="오디오 다운로드">
          <Download size={15} />
        </a>
      </div>
    </div>
  );
}

// 화자 색상/별칭 편집 칩
function SpeakerLegend({ speakers, meta, onEdit }: {
  speakers: string[];
  meta: Record<string, SpeakerInfo>;
  onEdit: (label: string) => void;
}) {
  if (speakers.length === 0) return null;
  return (
    <div className="spk-legend">
      {speakers.map((sp) => (
        <button key={sp} className="spk-chip" onClick={() => onEdit(sp)} title="이름·색상 수정">
          <span className="spk-dot" style={{ background: colorOf(sp, speakers, meta) }} />
          {nameOf(sp, meta)}
          {meta[sp]?.name && <span className="spk-orig"> ({sp})</span>} ✎
        </button>
      ))}
    </div>
  );
}

// 화자 이름 입력 폼
function SpeakerForm({ speakers, initialMeta, onGenerate, busy }: {
  speakers: string[];
  initialMeta: Record<string, SpeakerInfo>;
  onGenerate: (meta: Record<string, SpeakerInfo>) => void;
  busy: boolean;
}) {
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(speakers.map((sp) => [sp, initialMeta[sp]?.name || '']))
  );
  function submit() {
    const meta: Record<string, SpeakerInfo> = {};
    speakers.forEach((sp, i) => {
      meta[sp] = { name: names[sp] || sp, color: initialMeta[sp]?.color || PALETTE[i % PALETTE.length] };
    });
    onGenerate(meta);
  }
  return (
    <div className="speaker-form">
      <div className="speaker-form-title">화자를 확인하고 이름을 입력하세요</div>
      <div className="speaker-form-rows">
        {speakers.map((sp, i) => (
          <div key={sp} className="speaker-form-row">
            <span className="spk-dot" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="speaker-form-label">{sp}</span>
            <input
              className="speaker-form-input"
              placeholder="이름 (선택)"
              value={names[sp]}
              onChange={(e) => setNames((prev) => ({ ...prev, [sp]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <button className="minutes-btn" onClick={submit} disabled={busy}>
        {busy ? '회의록 생성 중…' : '회의록 작성'}
      </button>
    </div>
  );
}

// ── 메인 뷰 ─────────────────────────────────────────────────────────────────

export default function MeetingView() {
  const { id } = useParams();
  const mid = Number(id);
  const [data, setData] = useState<MeetingDetail | null>(null);
  const [tab, setTab] = useState<Tab>('minutes');
  const [transcribedTab, setTranscribedTab] = useState<'record' | 'sketch'>('record');
  const [error, setError] = useState('');
  const [minutesBusy, setMinutesBusy] = useState(false);
  const [localAction, setLocalAction] = useState<PipelineAction | null>(null); // 요청 전송 중(서버 pending_action 이 보이기 전)
  const [seenTranscript, setSeenTranscript] = useState(false); // 전사 탭은 처음 열 때 마운트(숨은 오디오·세그먼트 렌더 방지)
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useMeetings((s) => s.refresh);

  useEffect(() => {
    let alive = true;
    setData(null); setError(''); setTab('minutes'); setTranscribedTab('record'); setSeenTranscript(false);
    api.getMeeting(mid)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e.message || e)));
    return () => { alive = false; };
  }, [mid, reloadKey]);

  useEffect(() => { if (tab === 'transcript') setSeenTranscript(true); }, [tab]);

  // SSE: processing 상태 → 화자분리 완료 대기
  useEffect(() => {
    if (data?.status !== 'processing') return;
    const es = new EventSource(api.eventsUrl(mid));
    es.onmessage = (e) => {
      const ev: SseEvent = JSON.parse(e.data);
      if (ev.type === 'diarize') {
        setData((prev) => prev ? { ...prev, segments: ev.segments, status: 'transcribed' } : null);
        es.close();
      } else if (ev.type === 'error') {
        setError(ev.message);
        setData((prev) => prev ? { ...prev, status: 'error' } : null);
        es.close();
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [data?.status, mid]);

  // 진행 상태 폴링: 처리 중에는 progress/stage 갱신을 위해 항상 setData (SSE 는 그대로 유지)
  const upload = useUploader((u) => u.byId[mid]);
  const status = data?.status;
  const polling = !!status && (['recording', 'uploaded', 'processing', 'processing_minutes'].includes(status) || !!upload);
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      api.getMeeting(mid)
        .then((d) => {
          setData(d);
          if (d.status !== status) refresh();
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [polling, status, mid, refresh]);

  // 서버가 상태를 바꿨으면(일시정지/취소/재개 반영) 요청 중 표시 해제
  useEffect(() => { setLocalAction(null); }, [status]);

  // 서버가 recording 을 벗어났으면(= /finish 반영) 완료된 업로드 항목 정리
  useEffect(() => {
    if (upload?.phase === 'done' && status && status !== 'recording') useUploader.getState().clear(mid);
  }, [upload?.phase, status, mid]);

  // 오디오 두 개(원본 플레이어 / 전사 싱크 플레이어)가 동시에 재생되지 않도록 하나가 재생되면 나머지를 멈춘다.
  useEffect(() => {
    const onPlay = (e: Event) => {
      document.querySelectorAll('audio').forEach((a) => { if (a !== e.target) a.pause(); });
    };
    document.addEventListener('play', onPlay, true); // play 는 버블링하지 않으므로 캡처
    return () => document.removeEventListener('play', onPlay, true);
  }, []);

  async function saveTitle(title: string) {
    if (!data || title === data.title) return;
    await api.renameMeeting(mid, title).catch((e) => setError(String(e.message || e)));
    refresh();
  }

  const speakers = data ? Array.from(new Set(data.segments.map((s) => s.speaker))) : [];

  async function editSpeaker(label: string) {
    if (!data) return;
    const cur = data.speaker_meta[label] || {};
    const res = await dialog.speaker(label, cur.name || '', cur.color || colorOf(label, speakers, data.speaker_meta));
    if (!res) return;
    const meta = { ...data.speaker_meta, [label]: { name: res.name, color: res.color } };
    setData({ ...data, speaker_meta: meta });
    await api.setSpeakerMeta(mid, meta).catch((e) => setError(String(e.message || e)));
  }

  async function handleGenerateMinutes(speakerMeta: Record<string, SpeakerInfo>) {
    setMinutesBusy(true);
    setError('');
    try {
      await api.generateMinutes(mid, speakerMeta);
      setData((prev) => prev ? { ...prev, status: 'processing_minutes', speaker_meta: speakerMeta } : null);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setMinutesBusy(false);
    }
  }

  const CANCEL_NOTE: Record<string, string> = {
    minutes: '회의록 생성을 취소합니다. 전사 결과는 유지됩니다.',
    other: '진행을 취소합니다. 업로드된 녹음은 유지되고 이 처리의 결과는 버려집니다. 나중에 전사를 다시 시작할 수 있습니다.',
  };

  async function handlePipelineAction(kind: PipelineAction) {
    if (!data) return;
    if (kind === 'cancel') {
      const isMinutes = data.status === 'processing_minutes' || data.checkpoint?.stage === 'minutes';
      if (!(await dialog.confirm('처리를 취소할까요?', CANCEL_NOTE[isMinutes ? 'minutes' : 'other'], '취소하기'))) return;
    }
    setError('');
    setLocalAction(kind);
    try {
      if (kind === 'pause') await api.pauseMeeting(mid);
      else if (kind === 'resume') await api.resumeMeeting(mid);
      else await api.cancelMeeting(mid);
      const d = await api.getMeeting(mid);
      setData(d);
      refresh();
      if (d.status !== data.status) setLocalAction(null);
    } catch (e) {
      setLocalAction(null);
      setError(String((e as Error).message || e));
    }
  }

  async function handleRestart() {
    setError('');
    setLocalAction('resume');
    try {
      await api.transcribeMeeting(mid);
      setData(await api.getMeeting(mid));
      refresh();
    } catch (e) {
      setLocalAction(null);
      setError(String((e as Error).message || e));
    }
  }

  async function handleRegenerate() {
    if (!data) return;
    const ok = await dialog.confirm('원천 오디오를 기반으로 화자분리와 회의록을 다시 생성합니다.');
    if (!ok) return;
    setError('');
    try {
      await api.regenerateMeeting(mid);
      setData((prev) => prev ? { ...prev, status: 'processing', stage: null, progress: null, stage_started_at: null, segments: [], named_transcript: '', minutes: '' } : null);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }

  // ── 클라이언트 사이드 export ──────────────────────────────────────────────

  function exportMinutesMd() {
    if (!data?.minutes) return;
    const title = data.title || '회의록';
    downloadFile(data.minutes, `${title}.md`, 'text/markdown');
  }

  async function copyMinutesMd() {
    if (!data?.minutes) return;
    await navigator.clipboard.writeText(data.minutes);
    await dialog.alert('복사 완료', '회의록이 클립보드에 복사됐습니다.');
  }

  function exportTranscriptMd() {
    if (!data) return;
    const title = data.title || '전사전문';
    let content = `# ${title} — 전사 전문\n\n`;
    if (data.segments.length > 0) {
      data.segments.forEach((s) => {
        const name = nameOf(s.speaker, data.speaker_meta);
        content += `**[${fmtTime(s.start)}] ${name}**: ${s.text}\n\n`;
      });
    } else {
      content += data.named_transcript || data.transcript;
    }
    downloadFile(content, `${title}_transcript.md`, 'text/markdown');
  }

  function exportTranscriptJson() {
    if (!data) return;
    const title = data.title || '전사전문';
    const payload = {
      title: data.title,
      created_at: data.created_at,
      speaker_meta: data.speaker_meta,
      segments: data.segments.map((s) => ({
        ...s,
        speaker_name: nameOf(s.speaker, data.speaker_meta),
      })),
    };
    downloadFile(JSON.stringify(payload, null, 2), `${title}_transcript.json`, 'application/json');
  }

  // 응답 전에도 뼈대를 즉시 그린다(전체 화면 스피너로 막지 않음).
  if (!data) return <MeetingShell id={mid} error={error} onRetry={() => setReloadKey((k) => k + 1)} />;

  const isDone = data.status === 'done';
  const isTranscribed = data.status === 'transcribed';
  const isProcessing = data.status === 'processing';
  const isProcessingMinutes = data.status === 'processing_minutes';
  const isPaused = data.status === 'paused';
  // 업로드 중이거나(상세 페이지로 먼저 이동) 업로드 직후 서버 처리 대기 상태: 탭 없이 모니터만 보여준다.
  const isPreProcessing = data.status === 'recording' || data.status === 'uploaded';
  const retryUpload = () => useUploader.getState().retry(mid);
  const recoverChunks = () => { void useUploader.getState().recover(mid); };
  const monitor = (
    <PipelineMonitor
      data={data} upload={upload}
      pending={localAction ?? data.pending_action ?? null}
      onRetry={retryUpload} onRecover={recoverChunks} onRegenerate={handleRegenerate}
      onAction={handlePipelineAction}
      onCancelUpload={() => useUploader.getState().cancel(mid)}
      onRestart={handleRestart}
    />
  );

  return (
    <div className="page">
      <input
        className="page-title"
        defaultValue={data.title || '제목 없는 회의'}
        key={data.id}
        onBlur={(e) => saveTitle(e.target.value)}
      />
      <div className="page-meta">
        <span>{new Date(data.created_at).toLocaleString('ko-KR')}</span>
        {upload && upload.phase !== 'done' && <span className="badge processing">{upload.phase === 'failed' ? '업로드 실패' : '업로드 중…'}</span>}
        {isProcessing && <span className="badge processing">화자 분리 중…</span>}
        {isProcessingMinutes && <span className="badge processing">회의록 생성 중…</span>}
        {isPaused && <span className="badge">일시정지됨</span>}
        {data.status === 'error' && <span className="badge error">오류</span>}
        {data.has_audio && !upload && (
          <button className="regen-btn" onClick={handleRegenerate} title="원천 오디오로 재생성">
            <RefreshCw size={13} /> 재생성
          </button>
        )}
      </div>

      {data.has_audio && <AudioCard id={mid} hasM4a={!!data.has_m4a} durationSec={data.audio_duration_sec} />}

      {error && <p className="err">{error}</p>}

      {isPreProcessing && (
        upload || data.status === 'uploaded' ? monitor : (
          <div className="pipeline failed">
            <div className="pipe-title">녹음이 완료 처리되지 않았습니다</div>
            <div className="pipe-hint">녹음 도중 창이 닫혔거나 업로드가 끊긴 것 같습니다. 이미 전송된 조각으로 회의록을 만들 수 있습니다.</div>
            <div className="pipe-actions">
              <button className="pipe-btn primary" onClick={recoverChunks}>조각으로 복구</button>
            </div>
          </div>
        )
      )}

      {/* processing + transcribed: [회의록 녹취 | 스케치패드] 탭 */}
      {(isProcessing || isTranscribed) && (
        <>
          <div className="chips">
            <button className={`chip${transcribedTab === 'record' ? ' active' : ''}`} onClick={() => setTranscribedTab('record')}>
              <Mic size={15} /> 회의록 녹취
            </button>
            <button className={`chip${transcribedTab === 'sketch' ? ' active' : ''}`} onClick={() => setTranscribedTab('sketch')} onPointerEnter={prefetchSketchpad}>
              <PenLine size={15} /> 스케치패드
            </button>
          </div>

          {transcribedTab === 'record' && (
            <>
              {isProcessing && monitor}
              {isTranscribed && (
                <>
                  <SpeakerForm
                    speakers={speakers}
                    initialMeta={data.speaker_meta}
                    onGenerate={handleGenerateMinutes}
                    busy={minutesBusy}
                  />
                  {speakers.length === 0 && (
                    <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>
                      화자 분리 결과가 없습니다. 회의록만 생성합니다.
                    </p>
                  )}
                  {data.segments.length > 0 && (
                    <div className="transcript-preview">
                      <div className="transcript-preview-head">
                        전사 전문 미리보기
                        {data.has_audio && <span style={{ fontWeight: 400, marginLeft: 6 }}>· 구간 클릭 시 재생</span>}
                      </div>
                      {data.has_audio ? (
                        <SyncedTranscript
                          segments={data.segments}
                          speakers={speakers}
                          meta={data.speaker_meta}
                          audioUrl={api.audioUrl(mid)}
                          durationSec={data.audio_duration_sec}
                        />
                      ) : (
                        <div className="transcript">
                          {data.segments.map((s, i) => (
                            <div key={i} className="seg" style={{ borderLeft: `3px solid ${colorOf(s.speaker, speakers, data.speaker_meta)}` }}>
                              <span className="seg-time">{fmtTime(s.start)}</span>
                              <span className="spk" style={{ color: colorOf(s.speaker, speakers, data.speaker_meta) }}>{s.speaker}</span> {s.text}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {transcribedTab === 'sketch' && <Sketch meetingId={mid} />}
        </>
      )}

      {(isProcessingMinutes || isPaused) && monitor}

      {isDone && (
        <>
          <div className="chips">
            <button className={`chip${tab === 'minutes' ? ' active' : ''}`} onClick={() => setTab('minutes')}>
              <FileText size={15} /> 회의록
            </button>
            <button className={`chip${tab === 'transcript' ? ' active' : ''}`} onClick={() => setTab('transcript')}>
              <ListMusic size={15} /> 전사 전문
            </button>
            <button className={`chip${tab === 'sketch' ? ' active' : ''}`} onClick={() => setTab('sketch')} onPointerEnter={prefetchSketchpad}>
              <PenLine size={15} /> 스케치패드
            </button>
          </div>

          {/* ── 회의록 탭 ── */}
          <div style={{ display: tab === 'minutes' ? undefined : 'none' }}>
            <div className="export-bar">
              <button className="export-btn" onClick={copyMinutesMd} title="클립보드에 복사">
                <Copy size={13} /> 복사
              </button>
              <button className="export-btn" onClick={exportMinutesMd} title="MD 파일로 저장">
                <Download size={13} /> MD 저장
              </button>
            </div>
            {data.minutes ? (
              <div className="md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.minutes}</ReactMarkdown>
              </div>
            ) : (
              <p style={{ color: '#999' }}>회의록이 없습니다.</p>
            )}
          </div>

          {/* ── 전사 전문 탭 ── */}
          <div style={{ display: tab === 'transcript' ? undefined : 'none' }}>
            <div className="export-bar">
              <button className="export-btn" onClick={exportTranscriptMd} title="MD 파일로 저장">
                <Download size={13} /> MD 저장
              </button>
              <button className="export-btn" onClick={exportTranscriptJson} title="JSON 파일로 저장">
                <Download size={13} /> JSON 저장
              </button>
            </div>
            {!seenTranscript ? null : data.segments?.length ? (
              <>
                <SpeakerLegend speakers={speakers} meta={data.speaker_meta} onEdit={editSpeaker} />
                {data.has_audio ? (
                  <SyncedTranscript
                    segments={data.segments}
                    speakers={speakers}
                    meta={data.speaker_meta}
                    audioUrl={api.audioUrl(mid)}
                    durationSec={data.audio_duration_sec}
                  />
                ) : (
                  <div className="transcript">
                    {data.segments.map((s, i) => (
                      <div key={i} className="seg" style={{ borderLeft: `3px solid ${colorOf(s.speaker, speakers, data.speaker_meta)}` }}>
                        <span className="seg-time">{fmtTime(s.start)}</span>
                        <span className="spk" style={{ color: colorOf(s.speaker, speakers, data.speaker_meta) }}>
                          {nameOf(s.speaker, data.speaker_meta)}
                        </span>{' '}{s.text}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : data.named_transcript ? (
              <div className="transcript">{data.named_transcript}</div>
            ) : (
              <p style={{ color: '#999' }}>전사본이 없습니다.</p>
            )}
          </div>

          {/* ── 스케치패드 탭 ── */}
          {tab === 'sketch' && <Sketch meetingId={mid} />}
        </>
      )}
    </div>
  );
}
