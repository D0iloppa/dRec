import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, ListMusic, Play, Pause } from 'lucide-react';
import { api, MeetingDetail, Segment, SpeakerInfo } from '../api';
import { useMeetings } from '../store';
import { dialog } from '../ui/dialog';

type Tab = 'minutes' | 'transcript' | 'audio';

// 기본 화자 색상: 빨·주·노·초·파·남·보 (등장 순서대로, 초과 시 순환). 커스텀 색상이 있으면 우선.
const PALETTE = ['#e03e3e', '#e8830c', '#d9a400', '#0f9d58', '#2383e2', '#3b4fc4', '#7048e8'];
const colorOf = (label: string, speakers: string[], meta: Record<string, SpeakerInfo>) =>
  meta[label]?.color || PALETTE[Math.max(0, speakers.indexOf(label)) % PALETTE.length];
const nameOf = (label: string, meta: Record<string, SpeakerInfo>) => meta[label]?.name || label;

function TranscriptView({ text }: { text: string }) {
  // "[화자 N] …" 줄을 가볍게 강조해 렌더(타임스탬프 없을 때 폴백).
  return (
    <div className="transcript">
      {text.split('\n').map((line, i) => {
        const m = line.match(/^(\[[^\]]+\])\s*(.*)$/);
        return (
          <div key={i}>
            {m ? (
              <>
                <span className="spk">{m[1]}</span> {m[2]}
              </>
            ) : (
              line
            )}
          </div>
        );
      })}
    </div>
  );
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 자막 싱킹 + 하단 고정 전용 플레이어: 구절 클릭 시 그 지점 재생, 재생 중 현재 구절 하이라이트.
function SyncedTranscript({
  segments,
  speakers,
  meta,
  audioUrl,
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
  const rowsRef = useRef<(HTMLDivElement | null)[]>([]);

  function onTimeUpdate() {
    const t = audioRef.current?.currentTime ?? 0;
    setCur(t);
    const idx = segments.findIndex((s) => t >= s.start && t < s.end);
    if (idx !== active) {
      setActive(idx);
      if (idx >= 0) rowsRef.current[idx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function seek(start: number) {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = start;
    a.play();
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play(); else a.pause();
  }

  const curSpeaker = active >= 0 ? segments[active].speaker : null;
  const curColor = curSpeaker ? colorOf(curSpeaker, speakers, meta) : 'var(--text-dim)';

  return (
    <div>
      <audio
        ref={audioRef}
        src={audioUrl}
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
              onClick={() => seek(s.start)}
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
          type="range"
          min={0}
          max={dur || 0}
          step={0.1}
          value={Math.min(cur, dur || 0)}
          onChange={(e) => { if (audioRef.current) audioRef.current.currentTime = Number(e.target.value); }}
        />
        <span className="player-time">{fmtTime(cur)} / {fmtTime(dur)}</span>
      </div>
    </div>
  );
}

// 화자 색상/별칭 지정 — 등장 화자 칩(색상 점 + 이름) 클릭 시 편집.
function SpeakerLegend({
  speakers,
  meta,
  onEdit,
}: {
  speakers: string[];
  meta: Record<string, SpeakerInfo>;
  onEdit: (label: string) => void;
}) {
  if (speakers.length === 0) return null;
  return (
    <div className="spk-legend">
      {speakers.map((sp) => (
        <button key={sp} className="spk-chip" onClick={() => onEdit(sp)} title="색상·이름 지정">
          <span className="spk-dot" style={{ background: colorOf(sp, speakers, meta) }} />
          {nameOf(sp, meta)}
          {meta[sp]?.name && <span className="spk-orig"> ({sp})</span>} ✎
        </button>
      ))}
    </div>
  );
}

export default function MeetingView() {
  const { id } = useParams();
  const mid = Number(id);
  const [data, setData] = useState<MeetingDetail | null>(null);
  const [tab, setTab] = useState<Tab>('minutes');
  const [error, setError] = useState('');
  const refresh = useMeetings((s) => s.refresh);

  useEffect(() => {
    let alive = true;
    setData(null); setError(''); setTab('minutes');
    api.getMeeting(mid)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e.message || e)));
    return () => { alive = false; };
  }, [mid]);

  // 생성 중이면 폴링.
  useEffect(() => {
    if (data?.status !== 'processing') return;
    const t = setInterval(() => {
      api.getMeeting(mid).then((d) => { setData(d); if (d.status !== 'processing') refresh(); }).catch(() => {});
    }, 3000);
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
    setData({ ...data, speaker_meta: meta }); // 낙관적 갱신
    await api.setSpeakerMeta(mid, meta).catch((e) => setError(String(e.message || e)));
  }

  if (error) return <div className="page"><p className="err">{error}</p></div>;
  if (!data) return <div className="page"><p style={{ color: '#999' }}>불러오는 중…</p></div>;

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
        {data.status === 'processing' && <span className="badge processing">회의록 생성 중…</span>}
        {data.status === 'error' && <span className="badge error">오류</span>}
      </div>

      <div className="chips">
        <button className={`chip${tab === 'minutes' ? ' active' : ''}`} onClick={() => setTab('minutes')}>
          <FileText size={15} /> 회의록
        </button>
        <button className={`chip${tab === 'transcript' ? ' active' : ''}`} onClick={() => setTab('transcript')}>
          <ListMusic size={15} /> 전사 전문
        </button>
        <button
          className={`chip${tab === 'audio' ? ' active' : ''}`}
          onClick={() => setTab('audio')}
          disabled={!data.has_audio}
        >
          <Play size={15} /> 녹음 재생
        </button>
      </div>

      {tab === 'minutes' &&
        (data.minutes ? (
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.minutes}</ReactMarkdown>
          </div>
        ) : (
          <p style={{ color: '#999' }}>아직 회의록이 없습니다.</p>
        ))}

      {tab === 'transcript' && (
        data.segments?.length ? (
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
                    <span className="spk" style={{ color: colorOf(s.speaker, speakers, data.speaker_meta) }}>
                      {nameOf(s.speaker, data.speaker_meta)}
                    </span>{' '}
                    {s.text}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : data.transcript ? (
          <TranscriptView text={data.transcript} />
        ) : (
          <p style={{ color: '#999' }}>전사본이 없습니다.</p>
        )
      )}

      {tab === 'audio' &&
        (data.has_audio ? (
          <audio controls src={api.audioUrl(mid)} />
        ) : (
          <p style={{ color: '#999' }}>녹음본이 없습니다.</p>
        ))}
    </div>
  );
}
