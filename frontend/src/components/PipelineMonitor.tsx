import { useEffect, useState } from 'react';
import { Check, Pause, X } from 'lucide-react';
import { MeetingDetail } from '../api';
import { UploadState } from '../uploader';
import { fmtBytes, fmtDuration, fmtRemain } from './format';

type StepKey = 'upload' | 'prepare' | 'transcribe' | 'diarize' | 'minutes';

const LABEL: Record<StepKey, string> = {
  upload: '업로드',
  prepare: '오디오 준비',
  transcribe: '전사',
  diarize: '화자 분리',
  minutes: '회의록',
};

const MIN_PROGRESS_FOR_ETA = 0.03; // 이보다 작으면 ETA 가 요동쳐서 숨김

function parseUtc(iso: string): number {
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}

/** 현재 단계 결정: 업로드 우선 → 서버 stage → (stage 가 없는 구버전 행) status 기반 폴백. */
function currentStep(d: MeetingDetail, up?: UploadState): StepKey | null {
  if (up && up.phase !== 'done') return 'upload';
  if (d.stage === 'prepare' || d.stage === 'transcribe' || d.stage === 'diarize' || d.stage === 'minutes') return d.stage;
  if (d.status === 'processing_minutes') return 'minutes';
  if (d.status === 'processing') return d.stage === undefined ? 'diarize' : 'prepare';
  if (d.status === 'uploaded' || up?.phase === 'done') return 'prepare';
  return null;
}

export type PipelineAction = 'pause' | 'resume' | 'cancel';

const PENDING_LABEL: Record<'pause' | 'cancel' | 'resume', string> = {
  pause: '일시정지 중…', cancel: '취소 중…', resume: '재개 중…',
};

/** 일시정지 카드에 보여줄 "무엇이 보존되는가 / 재개하면 어떻게 되는가" 문구. */
function pausedNote(stage: StepKey, hasTranscript: boolean): string {
  if (stage === 'minutes') return '전사 결과 보존됨 · 재개하면 회의록 생성을 처음부터 다시 합니다.';
  if (stage === 'diarize' && hasTranscript) return '전사 결과 보존됨 · 재개하면 화자 분리부터 이어서 합니다.';
  return `재개하면 ${LABEL[stage]} 단계를 처음부터 다시 시작합니다.`;
}

export default function PipelineMonitor({
  data, upload, pending, onRetry, onRecover, onRegenerate, onAction, onCancelUpload, onRestart,
}: {
  data: MeetingDetail;
  upload?: UploadState;
  pending?: PipelineAction | null;      // 요청했고 서버가 아직 반영 전인 동작(일시정지 중… / 취소 중…)
  onRetry: () => void;
  onRecover: () => void;
  onRegenerate: () => void;
  onAction: (a: PipelineAction) => void;
  onCancelUpload: () => void;
  onRestart: () => void;                // 취소로 되돌아간 행의 전사 재시작
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 취소로 uploaded 로 되돌아간 상태: 오디오는 보관, 처리는 멈춤 — 다시 시작할 수 있게 한다.
  if (data.status === 'uploaded' && data.stage === 'cancelled' && !(upload && upload.phase !== 'done')) {
    return (
      <div className="pipeline paused">
        <div className="pipe-title">처리가 취소되었습니다</div>
        <div className="pipe-hint">업로드된 녹음은 그대로 보관되어 있습니다. 필요하면 전사를 다시 시작하세요.</div>
        <div className="pipe-actions">
          <button className="pipe-btn primary" onClick={onRestart} disabled={!!pending}>전사 다시 시작</button>
        </div>
      </div>
    );
  }

  if (data.status === 'paused') {
    const cp = data.checkpoint;
    const ps: StepKey = (['prepare', 'transcribe', 'diarize', 'minutes'] as const).find((k) => k === (cp?.stage ?? data.stage)) ?? 'prepare';
    const pSteps: StepKey[] = ['upload', 'prepare', 'transcribe', 'diarize'];
    if (ps === 'minutes') pSteps.push('minutes');
    const pIdx = pSteps.indexOf(ps);
    return (
      <div className="pipeline paused">
        <ol className="pipe-steps">
          {pSteps.map((k, i) => (
            <li key={k} className={i < pIdx ? 'done' : i === pIdx ? 'cur' : ''}>
              <span className="pipe-dot">{i < pIdx ? <Check size={13} strokeWidth={3} /> : i === pIdx ? <Pause size={12} strokeWidth={2.5} fill="currentColor" /> : i + 1}</span>
              <span className="pipe-label">{LABEL[k]}</span>
            </li>
          ))}
        </ol>
        <div className="pipe-head"><span className="pipe-title">{LABEL[ps]} 단계에서 일시정지됨</span></div>
        <div className="pipe-detail">{pausedNote(ps, !!cp?.has_transcript)}</div>
        <div className="pipe-actions">
          {pending ? (
            <span className="pipe-pending"><span className="processing-spinner" /> {PENDING_LABEL[pending]}</span>
          ) : (
            <>
              <button className="pipe-btn primary" onClick={() => onAction('resume')}>재개</button>
              <button className="pipe-btn" onClick={() => onAction('cancel')}>취소</button>
            </>
          )}
        </div>
      </div>
    );
  }

  const step = currentStep(data, upload);
  if (!step) return null;

  const steps: StepKey[] = ['upload', 'prepare', 'transcribe', 'diarize'];
  if (step === 'minutes' || data.status === 'processing_minutes') steps.push('minutes');
  // 회의록 단계에서는 앞 단계가 모두 끝난 상태이므로 업로드까지 포함한 전체 스텝퍼를 그대로 쓴다.
  const curIdx = steps.indexOf(step);

  const dur = data.audio_duration_sec ?? null;
  const startedAt = data.stage_started_at ? parseUtc(data.stage_started_at) : null;
  const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1000) : null;
  const p = step === 'transcribe' && typeof data.progress === 'number' ? Math.min(1, Math.max(0, data.progress)) : null;

  const stalled =
    step !== 'upload' && elapsed !== null && elapsed > Math.max(600, 2 * (dur ?? 0));

  // 현재 단계의 진행 표시
  let pct: number | null = null;     // null → 불확정(indeterminate) 바
  let detail: string[] = [];         // 바 아래 보조 정보
  let headline = LABEL[step];

  if (step === 'upload' && upload) {
    if (upload.phase === 'failed') {
      headline = '업로드 실패';
    } else if (upload.phase === 'converting') {
      pct = null;
      headline = '업로드 완료 · 서버에서 변환 중';
      detail = [fmtBytes(upload.total)];
    } else {
      pct = upload.total > 0 ? upload.loaded / upload.total : 0;
      headline = '녹음 업로드 중';
      detail = [`${fmtBytes(upload.loaded)} / ${fmtBytes(upload.total)}`];
      if (upload.speed > 0) detail.push(`${fmtBytes(upload.speed)}/s`);
      if (upload.etaSec !== null) detail.push(`남은 시간 약 ${fmtRemain(upload.etaSec)}`);
    }
  } else if (p !== null) {
    pct = p;
    if (p >= MIN_PROGRESS_FOR_ETA && elapsed !== null) detail.push(`남은 시간 약 ${fmtRemain((elapsed * (1 - p)) / p)}`);
    if (elapsed !== null) detail.push(`경과 ${fmtRemain(elapsed)}`);
  } else if (elapsed !== null) {
    detail.push(`경과 ${fmtRemain(elapsed)}`);
  }
  if (dur && step !== 'upload') detail.push(`녹음 길이 ${fmtDuration(dur)}`);
  if (step === 'minutes') headline = '회의록 생성 중';

  const failed = step === 'upload' && upload?.phase === 'failed';

  return (
    <div className={`pipeline${failed ? ' failed' : ''}`}>
      <ol className="pipe-steps">
        {steps.map((k, i) => (
          <li key={k} className={i < curIdx ? 'done' : i === curIdx ? (failed ? 'cur err' : 'cur') : ''}>
            <span className="pipe-dot">{i < curIdx ? <Check size={13} strokeWidth={3} /> : i === curIdx && failed ? <X size={13} strokeWidth={3} /> : i + 1}</span>
            <span className="pipe-label">{LABEL[k]}</span>
          </li>
        ))}
      </ol>

      <div className="pipe-head">
        {!failed && pct === null && <span className="processing-spinner" />}
        <span className="pipe-title">{headline}</span>
        {pct !== null && <span className="pipe-pct">{Math.floor(pct * 100)}%</span>}
      </div>

      {!failed && (
        <div className={`pipe-bar${pct === null ? ' indet' : ''}`}>
          <div className="pipe-bar-fill" style={pct === null ? undefined : { width: `${pct * 100}%` }} />
        </div>
      )}
      {detail.length > 0 && !failed && <div className="pipe-detail">{detail.join(' · ')}</div>}

      {step === 'upload' && upload?.phase === 'uploading' && (
        <>
          <div className="pipe-hint">업로드가 끝날 때까지 이 창을 닫지 마세요.</div>
          <div className="pipe-actions">
            <button className="pipe-btn" onClick={onCancelUpload}>취소</button>
          </div>
        </>
      )}
      {/* 서버가 처리 중인 단계의 일시정지/취소 (업로드 단계·실패 상태 제외) */}
      {step !== 'upload' && (data.status === 'processing' || data.status === 'processing_minutes') && (
        <div className="pipe-actions">
          {pending ? (
            <span className="pipe-pending"><span className="processing-spinner" /> {PENDING_LABEL[pending]}</span>
          ) : (
            <>
              <button className="pipe-btn" onClick={() => onAction('pause')}>일시정지</button>
              <button className="pipe-btn" onClick={() => onAction('cancel')}>취소</button>
            </>
          )}
        </div>
      )}
      {failed && (
        <>
          <div className="pipe-error">{upload?.error || '업로드에 실패했습니다.'}</div>
          <div className="pipe-actions">
            <button className="pipe-btn primary" onClick={onRetry}>재시도</button>
            <button className="pipe-btn" onClick={onRecover}>조각으로 복구</button>
          </div>
          <div className="pipe-hint">조각으로 복구하면 실시간 전사에 쓰인 짧은 조각을 이어 붙여 처리하며, 음질이 낮을 수 있습니다.</div>
        </>
      )}
      {stalled && (
        <div className="pipe-hint warn">
          평소보다 오래 걸리고 있습니다. 계속 멈춰 있다면{' '}
          <button className="pipe-link" onClick={onRegenerate}>재생성</button>을 시도해 보세요.
        </div>
      )}
    </div>
  );
}
