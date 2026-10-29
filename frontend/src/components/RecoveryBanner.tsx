// 미완료 녹음 복구 배너 — 앱을 열었을 때 IndexedDB(localRec)에 업로드되지 않은 녹음이 남아 있으면 알린다.
// 업로드는 기존 업로더(start → /finish, 원본 없으면 recover)를 그대로 쓴다. 성공해도 로컬 사본은 '검토 대기'로 남고
// (회의 상세의 백업 패널에서 승인해야 삭제), 이 배너는 그 건수와 저장 공간 부족만 한 줄로 알린다.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Upload, Download, Trash2, HardDrive } from 'lucide-react';
import { toast } from 'sonner';
import { api, HttpError } from '../api';
import {
  estimateStorage, isPendingReview, listLocal, loadFull, localRec, LocalSummary, purgeLocal, saveBlobs,
  StorageEstimateInfo, useLocalRec,
} from '../localRec';
import { useUploader } from '../uploader';
import { useMeetings } from '../store';
import { dialog } from '../ui/dialog';
import { fmtBytes } from './format';

export default function RecoveryBanner() {
  const version = useLocalRec((s) => s.version);
  const uploading = useUploader((u) => u.byId);
  const refresh = useMeetings((s) => s.refresh);
  const navigate = useNavigate();
  const [items, setItems] = useState<LocalSummary[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [handed, setHanded] = useState<Set<number>>(new Set()); // 이번 실행에서 업로더에 넘긴 로컬 id
  const [est, setEst] = useState<StorageEstimateInfo | null>(null);
  const [saveReady, setSaveReady] = useState<{ id: number; blobs: Blob[] } | null>(null);

  useEffect(() => {
    let alive = true;
    listLocal()
      .then(async (list) => {
        // 오디오가 하나도 없는 미완료 메타(시작 직후 종료 등)만 정리 — 오디오가 있는 백업은 절대 자동 삭제하지 않는다
        const empty = list.filter((m) => !isPendingReview(m) && m.fullParts === 0 && m.slices === 0 && m.id !== localRec.activeId);
        for (const m of empty) await purgeLocal(m.id);
        if (alive) setItems(list.filter((m) => !empty.includes(m)));
      })
      .catch(() => { if (alive) setItems([]); });
    estimateStorage().then((e) => { if (alive) setEst(e); });
    return () => { alive = false; };
  }, [version]);

  // 지금 녹음 중이거나 이번 실행에서 업로더가 이미 맡고 있는 회의는 제외(상세 화면이 처리)
  const shown = items.filter((m) => !isPendingReview(m) && m.id !== localRec.activeId && !uploading[m.id] && !handed.has(m.id));
  const review = items.filter(isPendingReview);
  const low = !!est?.low && items.length > 0;
  if (!shown.length && !review.length && !low) return null;

  async function upload(m: LocalSummary) {
    setBusyId(m.id);
    try {
      const blobs = await loadFull(m.id);
      let target = m.id;
      try {
        await api.getMeeting(m.id);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
        if (!blobs.length) { toast.error('서버에서 회의가 삭제되었고 원본도 없어 복구할 수 없습니다'); return; }
        // 서버에서 회의가 지워졌다 → 새 회의로 올린다(로컬 키는 원래 id 로 정리)
        const s = await api.createSession(`${m.title || `회의 #${m.id}`} (복구)`);
        target = s.id;
      }
      setHanded((h) => new Set(h).add(m.id));
      if (blobs.length) useUploader.getState().start(target, blobs, { localId: m.id });
      else void useUploader.getState().recover(target); // 원본 없음 — 남은 전사 조각만 보내고 마무리
      await refresh();
      navigate(`/m/${target}`);
    } catch (e) {
      toast.error(`복구 업로드 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function save(m: LocalSummary) {
    try {
      // iOS 공유 시트는 제스처 안에서만 열린다 → 미리 읽어 둔 Blob 이 있으면 바로, 없으면 읽은 뒤 시도(만료 시 한 번 더 탭)
      const blobs = saveReady?.id === m.id ? saveReady.blobs : await loadFull(m.id);
      if (!blobs.length) { toast.error('저장된 원본 오디오가 없습니다'); return; }
      const r = await saveBlobs(m.id, blobs);
      if (r === 'gesture') { setSaveReady({ id: m.id, blobs }); toast('저장 준비가 됐습니다. "파일로 저장"을 한 번 더 눌러 주세요'); }
      else setSaveReady(null);
    } catch (e) {
      toast.error(`파일 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function remove(m: LocalSummary) {
    const ok = await dialog.confirm('기기에 보관된 녹음을 삭제할까요?', '삭제하면 되돌릴 수 없습니다. 먼저 업로드하거나 파일로 저장하세요.', '삭제');
    if (ok) await purgeLocal(m.id);
  }

  return (
    <div className="recover-banner" role="alert">
      {shown.length > 0 && (
        <div className="recover-head">
          <AlertTriangle size={18} /> 업로드되지 않은 녹음이 기기에 남아 있습니다
        </div>
      )}
      {shown.map((m) => (
        <div key={m.id} className="recover-item">
          <div className="recover-info">
            <div className="recover-title">{m.title || `회의 #${m.id}`}</div>
            <div className="recover-meta">
              {new Date(m.createdAt).toLocaleString()} · 원본 {fmtBytes(m.fullBytes)}
              {m.gens > 1 && ` (${m.gens}구간)`}
              {m.slices > 0 && ` · 미전송 조각 ${m.slices}개`}
              {m.finished && ' · 서버에는 원본 없이 종료됨 — 업로드하면 원본으로 다시 처리'}
            </div>
          </div>
          <div className="recover-actions">
            <button onClick={() => upload(m)} disabled={busyId !== null}><Upload size={14} /> {busyId === m.id ? '준비 중…' : '업로드'}</button>
            {m.fullParts > 0 && <button onClick={() => save(m)}><Download size={14} /> {saveReady?.id === m.id ? '다시 탭해서 저장' : '파일로 저장'}</button>}
            <button className="danger" onClick={() => remove(m)}><Trash2 size={14} /> 삭제</button>
          </div>
        </div>
      ))}
      {review.length > 0 && (
        <div className="recover-note">
          <HardDrive size={14} /> 업로드 후 검토 대기 중인 백업 {review.length}건 — 사이드바 「이 기기의 녹음 백업」에서 결과를 확인하고 승인하면 삭제됩니다.
        </div>
      )}
      {low && est && (
        <div className="recover-note warn">
          <AlertTriangle size={14} /> 기기 저장 공간이 부족합니다({fmtBytes(est.usage)} / {fmtBytes(est.quota)} 사용). 검토가 끝난 백업을 승인해 정리해 주세요 — 자동으로 지우지는 않습니다.
        </div>
      )}
    </div>
  );
}
