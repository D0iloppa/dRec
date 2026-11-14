// 회의 상세의 "이 기기의 녹음 백업" 카드 — 업로드 결과(서버 녹음 길이)를 로컬 원본과 비교해 보고,
// 사용자가 승인해야만 백업을 지운다(자동 삭제 없음). 재생 / 파일로 저장(iOS 공유 시트) / 백업으로 다시 업로드.
// 전체 백업 목록·일괄 정리는 백업 관리 페이지(/backups).
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { HardDrive, Play, Download, Upload, CheckCircle2, AlertTriangle, ChevronRight, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  isPendingReview, listLocal, loadFull, localRec, LocalSummary, matchesMeeting, probeDuration, saveBlobs,
  useLocalRec,
} from '../localRec';
import { useUploader } from '../uploader';
import { dialog } from '../ui/dialog';
import { approveAndPurge, BackupCompare, purgeIncomplete, REUPLOAD_CONFIRM, StateBadge, verdict } from './backupCommon';

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
  const approxSec = localSec == null && meta.recordedMs ? meta.recordedMs / 1000 : null;
  const localDur = localSec ?? approxSec;
  const serverDur = serverHasAudio ? serverDurationSec ?? null : null;
  const uploadBusy = upload?.phase === 'uploading' || upload?.phase === 'converting';
  const { kind, warn } = verdict(localDur, serverDur, serverHasAudio, uploadBusy);
  const pending = isPendingReview(meta);

  async function save() {
    if (!blobs?.length) return;
    const r = await saveBlobs(meetingId, blobs);
    if (r === 'gesture') toast('저장 준비가 됐습니다. "파일로 저장"을 한 번 더 눌러 주세요');
  }

  async function reupload() {
    if (!meta || !blobs?.length) return;
    if (await dialog.confirm(REUPLOAD_CONFIRM.title, REUPLOAD_CONFIRM.text, REUPLOAD_CONFIRM.ok)) {
      useUploader.getState().start(meetingId, blobs, { localId: meta.id });
    }
  }

  return (
    <section className={`bk-card${warn ? ' warn' : ''}`}>
      <header className="bk-head">
        <HardDrive size={16} />
        <span className="bk-title">이 기기의 음성 백업</span>
        <StateBadge meta={meta} />
        <Link className="bk-link" to="/backups">백업 관리 <ChevronRight size={13} /></Link>
      </header>

      <BackupCompare
        meta={meta} localDur={localDur} approx={approxSec != null && localSec == null} measuring={measuring}
        serverDur={serverDur} serverHasAudio={serverHasAudio} kind={kind}
      />
      {warn && <div className="bk-warn"><AlertTriangle size={14} /> <span>{warn}</span></div>}

      {playIdx !== null && urls[playIdx] && (
        <div className="bk-player">
          {urls.length > 1 && (
            <div className="bk-gens">
              {urls.map((_, i) => (
                <button key={i} className={i === playIdx ? 'on' : ''} onClick={() => setPlayIdx(i)}>구간 {i + 1}</button>
              ))}
            </div>
          )}
          <audio key={urls[playIdx]} src={urls[playIdx]} controls autoPlay playsInline />
        </div>
      )}

      {pending ? (
        <button className={`bk-primary${warn ? ' risky' : ''}`} onClick={() => void approveAndPurge(meta, warn)} disabled={uploadBusy}>
          {warn ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />} 업로드 완료 승인 → 백업 삭제
        </button>
      ) : (
        <button className="bk-primary danger" onClick={() => void purgeIncomplete(meta)} disabled={uploadBusy}>
          <X size={16} /> 백업 삭제
        </button>
      )}
      <div className="bk-actions">
        <button onClick={() => setPlayIdx(playIdx === null ? 0 : null)} disabled={!urls.length}><Play size={14} /> {playIdx === null ? '백업 재생' : '재생 닫기'}</button>
        <button onClick={save} disabled={!blobs?.length}><Download size={14} /> 파일로 저장</button>
        <button onClick={reupload} disabled={!blobs?.length || uploadBusy}><Upload size={14} /> {uploadBusy ? '업로드 중…' : '다시 업로드'}</button>
      </div>
      <div className="bk-note">백업은 승인하기 전까지 자동으로 지워지지 않습니다.</div>
    </section>
  );
}
