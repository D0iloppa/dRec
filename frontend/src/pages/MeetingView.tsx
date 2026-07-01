import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, ListMusic, PenLine, Play, Pause, Download, Copy, RefreshCw, Mic } from 'lucide-react';
import { api, MeetingDetail, Segment, SpeakerInfo, SseEvent } from '../api';
import { useMeetings } from '../store';
import { dialog } from '../ui/dialog';
import { SketchpadPanel } from '../components/Sketchpad';

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
  segments, speakers, meta, audioUrl,
}: {
  segments: Segment[];
  speakers: string[];
  meta: Record<string, SpeakerInfo>;
  audioUrl: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [active, setActive] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
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
        preload="auto"
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
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

function ProcessingBanner({ message }: { message: string }) {
  return (
    <div className="processing-banner">
      <span className="processing-spinner" />
      {message}
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
  const refresh = useMeetings((s) => s.refresh);

  useEffect(() => {
    let alive = true;
    setData(null); setError(''); setTab('minutes'); setTranscribedTab('record');
    api.getMeeting(mid)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e.message || e)));
    return () => { alive = false; };
  }, [mid]);

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

  // 폴링 폴백: processing_minutes
  useEffect(() => {
    if (data?.status !== 'processing_minutes') return;
    const t = setInterval(() => {
      api.getMeeting(mid).then((d) => { setData(d); if (d.status !== 'processing_minutes') refresh(); }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [data?.status, mid, refresh]);

  // processing 폴백 폴링 (SSE 끊긴 경우)
  useEffect(() => {
    if (data?.status !== 'processing') return;
    const t = setInterval(() => {
      api.getMeeting(mid).then((d) => { if (d.status !== 'processing') { setData(d); if (d.status === 'done') refresh(); } }).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [data?.status, mid, refresh]);

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

  async function handleRegenerate() {
    if (!data) return;
    const ok = await dialog.confirm('원천 오디오를 기반으로 화자분리와 회의록을 다시 생성합니다.');
    if (!ok) return;
    setError('');
    try {
      await api.regenerateMeeting(mid);
      setData((prev) => prev ? { ...prev, status: 'processing', segments: [], named_transcript: '', minutes: '' } : null);
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

  if (error && !data) return <div className="page"><p className="err">{error}</p></div>;
  if (!data) return <div className="page"><p style={{ color: '#999' }}>불러오는 중…</p></div>;

  const isDone = data.status === 'done';
  const isTranscribed = data.status === 'transcribed';
  const isProcessing = data.status === 'processing';
  const isProcessingMinutes = data.status === 'processing_minutes';

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
        {isProcessing && <span className="badge processing">화자 분리 중…</span>}
        {isProcessingMinutes && <span className="badge processing">회의록 생성 중…</span>}
        {data.status === 'error' && <span className="badge error">오류</span>}
        {data.has_audio && (
          <button className="regen-btn" onClick={handleRegenerate} title="원천 오디오로 재생성">
            <RefreshCw size={13} /> 재생성
          </button>
        )}
      </div>

      {error && <p className="err">{error}</p>}

      {/* processing + transcribed: [회의록 녹취 | 스케치패드] 탭 */}
      {(isProcessing || isTranscribed) && (
        <>
          <div className="chips">
            <button className={`chip${transcribedTab === 'record' ? ' active' : ''}`} onClick={() => setTranscribedTab('record')}>
              <Mic size={15} /> 회의록 녹취
            </button>
            <button className={`chip${transcribedTab === 'sketch' ? ' active' : ''}`} onClick={() => setTranscribedTab('sketch')}>
              <PenLine size={15} /> 스케치패드
            </button>
          </div>

          {transcribedTab === 'record' && (
            <>
              {isProcessing && <ProcessingBanner message="화자 분리 중입니다…" />}
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

          {transcribedTab === 'sketch' && <SketchpadPanel meetingId={mid} />}
        </>
      )}

      {isProcessingMinutes && <ProcessingBanner message="회의록을 생성하고 있습니다…" />}

      {isDone && (
        <>
          <div className="chips">
            <button className={`chip${tab === 'minutes' ? ' active' : ''}`} onClick={() => setTab('minutes')}>
              <FileText size={15} /> 회의록
            </button>
            <button className={`chip${tab === 'transcript' ? ' active' : ''}`} onClick={() => setTab('transcript')}>
              <ListMusic size={15} /> 전사 전문
            </button>
            <button className={`chip${tab === 'sketch' ? ' active' : ''}`} onClick={() => setTab('sketch')}>
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
            {data.segments?.length ? (
              <>
                <SpeakerLegend speakers={speakers} meta={data.speaker_meta} onEdit={editSpeaker} />
                {data.has_audio ? (
                  <SyncedTranscript
                    segments={data.segments}
                    speakers={speakers}
                    meta={data.speaker_meta}
                    audioUrl={api.audioUrl(mid)}
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
          {tab === 'sketch' && <SketchpadPanel meetingId={mid} />}
        </>
      )}
    </div>
  );
}
