// 회의 상세의 "이 기기의 녹음 백업" 패널 — 업로드 결과(서버 녹음 길이)를 로컬 원본과 비교해 보고,
// 사용자가 승인해야만 백업을 지운다(자동 삭제 없음). 재생 / 파일로 저장(iOS 공유 시트) / 백업으로 다시 업로드.
import { useEffect, useMemo, useState } from 'react';
import { HardDrive, Play, Download, Upload, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import {
  isPendingReview, listLocal, loadFull, localRec, LocalSummary, matchesMeeting, probeDuration, purgeLocal, saveBlobs,
  useLocalRec,
} from '../localRec';
import { useUploader } from '../uploader';
import { dialog } from '../ui/dialog';
import { fmtBytes, fmtDuration } from './format';

const MISMATCH_RATIO = 0.95; // 서버 길이가 로컬의 95% 미만이면 경고

interface Props {
  meetingId: number;
  serverDurationSec?: number | null;
  serverHasAudio: boolean;
}

export default function LocalBackupPanel({ meetingId, serverDurationSec, serverHasAudio }: Props) {
  const version = useLocalRec((s) => s.version);
  const upload = useUploader((u) => u.byId[meetingId]);
  const [meta, setMeta] = useState<LocalSummary | null>(null);
  const [blobs, setBlobs] = useState<Blob[] | null>(null);
  const [localSec, setLocalSec] = useState<number | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [playIdx, setPlayIdx] = useState<number | null>(null);

  // 이 회의의 백업 찾기(녹음 중인 회의는 제외)
  useEffect(() => {
    let alive = true;
    listLocal()
      .then((list) => {
        if (!alive) return;
        const m = list.find((x) => matchesMeeting(x, meetingId) && x.id !== localRec.activeId && x.fullParts > 0) ?? null;
        setMeta(m);
      })
      .catch(() => { if (alive) setMeta(null); });
    return () => { alive = false; };
  }, [version, meetingId]);

  // 원본을 미리 읽어 둔다(재생·iOS 공유는 제스처 안에서 바로 써야 하므로) + 실제 길이 측정
  const localId = meta?.id;
  const fullBytes = meta?.fullBytes;
  useEffect(() => {
    if (localId === undefined) { setBlobs(null); setLocalSec(null); return; }
    let alive = true;
    setMeasuring(true);
    loadFull(localId)
      .then(async (bs) => {
        if (!alive) return;
        setBlobs(bs);
        const ds = await Promise.all(bs.map((b) => probeDuration(b)));
        if (alive) setLocalSec(ds.every((d) => d != null) ? ds.reduce<number>((s, d) => s + (d ?? 0), 0) : null);
      })
      .catch(() => { if (alive) setBlobs(null); })
      .finally(() => { if (alive) setMeasuring(false); });
    return () => { alive = false; };
  }, [localId, fullBytes]);

  const urls = useMemo(() => (blobs ?? []).map((b) => URL.createObjectURL(b)), [blobs]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  if (!meta) return null;

  // 측정 실패 시 녹음 화면이 기록한 시간으로 대체(≈)
  const approx = localSec == null && meta.recordedMs ? meta.recordedMs / 1000 : null;
  const localDur = localSec ?? approx;
  const serverDur = serverHasAudio ? serverDurationSec ?? null : null;
  const uploadBusy = upload?.phase === 'uploading' || upload?.phase === 'converting';
  let warn = '';
  if (uploadBusy) warn = ''; // 업로드 중에는 서버 길이가 아직 없다
  else if (!serverHasAudio) warn = '서버에 원본 녹음이 없습니다. 백업으로 다시 업로드하세요.';
  else if (localDur && serverDur != null && serverDur < localDur * MISMATCH_RATIO) {
    warn = `서버 녹음(${fmtDuration(serverDur)})이 기기 백업(${fmtDuration(localDur)})보다 ${Math.round((1 - serverDur / localDur) * 100)}% 짧습니다. 업로드·조립 중 일부가 빠졌을 수 있습니다.`;
  }
  const pending = isPendingReview(meta);

  async function save() {
    if (!blobs?.length) return;
    const r = await saveBlobs(meetingId, blobs);
    if (r === 'gesture') toast('저장 준비가 됐습니다. "파일로 저장"을 한 번 더 눌러 주세요');
  }

  async function reupload() {
    if (!meta || !blobs?.length) return;
    const ok = await dialog.confirm(
      '기기 백업으로 다시 업로드할까요?',
      '서버의 원본 녹음을 이 백업으로 교체하고 전사·화자 분리를 다시 실행합니다. 백업은 그대로 남습니다.',
      '다시 업로드',
    );
    if (ok) useUploader.getState().start(meetingId, blobs, { localId: meta.id });
  }

  async function approve() {
    if (!meta) return;
    if (warn) {
      const again = await dialog.confirm('길이 불일치 경고가 있습니다', `${warn}\n그래도 승인하고 백업을 삭제하면 기기의 원본을 되살릴 수 없습니다.`, '그래도 진행');
      if (!again) return;
    }
    const ok = await dialog.confirm(
      '업로드 완료를 승인하고 백업을 삭제할까요?',
      '서버의 녹음·전사 결과를 확인했다면 승인하세요. 삭제 후에는 되돌릴 수 없습니다. 필요하면 먼저 "파일로 저장"하세요.',
      '승인하고 삭제',
    );
    if (ok) { await purgeLocal(meta.id); toast.success('기기 백업을 삭제했습니다'); }
  }

  async function removeIncomplete() {
    if (!meta) return;
    const ok = await dialog.confirm('업로드되지 않은 백업입니다', '삭제하면 이 녹음의 원본을 되살릴 수 없습니다. 정말 삭제할까요?', '삭제');
    if (ok) await purgeLocal(meta.id);
  }

  return (
    <div className={`backup-panel${warn ? ' warn' : ''}`}>
      <div className="backup-head">
        <HardDrive size={16} /> 이 기기의 녹음 백업
        <span className={`backup-state${pending ? ' review' : ' incomplete'}`}>{pending ? '검토 대기' : '업로드 미완료'}</span>
      </div>
      <div className="backup-compare">
        <div>
          <div className="backup-k">기기 백업</div>
          <div className="backup-v">
            {measuring && localDur == null ? '측정 중…' : localDur != null ? `${approx != null ? '≈ ' : ''}${fmtDuration(localDur)}` : '길이 알 수 없음'}
            <span className="backup-sub"> · {fmtBytes(meta.fullBytes)}{meta.gens > 1 ? ` · ${meta.gens}구간` : ''}</span>
          </div>
        </div>
        <div>
          <div className="backup-k">서버 녹음</div>
          <div className="backup-v">{serverDur != null ? fmtDuration(serverDur) : serverHasAudio ? '길이 미확인' : '없음'}</div>
        </div>
      </div>
      {warn && <div className="backup-warn"><AlertTriangle size={14} /> {warn}</div>}

      {playIdx !== null && urls[playIdx] && (
        <div className="backup-player">
          {urls.length > 1 && (
            <div className="backup-gens">
              {urls.map((_, i) => (
                <button key={i} className={i === playIdx ? 'on' : ''} onClick={() => setPlayIdx(i)}>구간 {i + 1}</button>
              ))}
            </div>
          )}
          <audio key={urls[playIdx]} src={urls[playIdx]} controls autoPlay playsInline />
        </div>
      )}

      <div className="backup-actions">
        <button onClick={() => setPlayIdx(playIdx === null ? 0 : null)} disabled={!urls.length}><Play size={14} /> {playIdx === null ? '백업 재생' : '재생 닫기'}</button>
        <button onClick={save} disabled={!blobs?.length}><Download size={14} /> 파일로 저장</button>
        <button onClick={reupload} disabled={!blobs?.length || uploadBusy}><Upload size={14} /> {uploadBusy ? '업로드 중…' : '백업으로 다시 업로드'}</button>
        {pending ? (
          <button className={`approve${warn ? ' risky' : ''}`} onClick={approve} disabled={uploadBusy}>
            {warn ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />} 업로드 완료 승인 → 백업 삭제
          </button>
        ) : (
          <button className="danger" onClick={removeIncomplete} disabled={uploadBusy}>백업 삭제</button>
        )}
      </div>
      <div className="backup-hint">백업은 승인하기 전까지 자동으로 지워지지 않습니다.</div>
    </div>
  );
}
