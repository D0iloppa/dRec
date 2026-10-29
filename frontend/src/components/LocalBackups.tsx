// 사이드바 "이 기기의 녹음 백업" 목록 — 상태(업로드 미완료/검토 대기)·용량, 저장 공간 사용량, 상세 화면 이동.
// 정리는 상세 화면의 승인/삭제로만 한다(여기서 자동 삭제하지 않음).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HardDrive, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { estimateStorage, isPendingReview, listLocal, localRec, LocalSummary, StorageEstimateInfo, useLocalRec } from '../localRec';
import { useMeetings } from '../store';
import { fmtBytes } from './format';

export default function LocalBackups() {
  const version = useLocalRec((s) => s.version);
  const closeOnMobile = useMeetings((s) => s.closeOnMobile);
  const navigate = useNavigate();
  const [items, setItems] = useState<LocalSummary[]>([]);
  const [est, setEst] = useState<StorageEstimateInfo | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    listLocal().then((l) => { if (alive) setItems(l.filter((m) => m.id !== localRec.activeId && (m.fullParts > 0 || m.slices > 0))); }).catch(() => {});
    estimateStorage().then((e) => { if (alive) setEst(e); });
    return () => { alive = false; };
  }, [version]);

  if (!items.length && !est?.low) return null;
  const total = items.reduce((s, m) => s + m.fullBytes, 0);
  const review = items.filter(isPendingReview).length;

  return (
    <div className="backup-card">
      <button className="backup-card-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <HardDrive size={14} /> 이 기기의 녹음 백업
        <span className="backup-count">{items.length}건 · {fmtBytes(total)}</span>
      </button>
      {est?.low && (
        <div className="backup-low"><AlertTriangle size={12} /> 저장 공간 부족 — 검토가 끝난 백업을 승인해 정리하세요</div>
      )}
      {open && (
        <>
          {items.map((m) => (
            <button
              key={m.id}
              className="backup-row"
              onClick={() => { navigate(`/m/${m.serverId ?? m.id}`); closeOnMobile(); }}
            >
              <span className="backup-row-title">{m.title || `회의 #${m.id}`}</span>
              <span className="backup-row-meta">
                {new Date(m.createdAt).toLocaleDateString()} · {fmtBytes(m.fullBytes)} ·{' '}
                <span className={isPendingReview(m) ? 'st-review' : 'st-incomplete'}>{isPendingReview(m) ? '검토 대기' : '업로드 미완료'}</span>
              </span>
            </button>
          ))}
          {est && (
            <div className="backup-usage">
              앱 저장 공간 {fmtBytes(est.usage)} / {fmtBytes(est.quota)} 사용{review > 0 ? ` · 검토 대기 ${review}건` : ''}
            </div>
          )}
        </>
      )}
    </div>
  );
}
