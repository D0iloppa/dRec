// 사이드바 "녹음 백업" 진입 행 — 건수 배지만 보이고, 목록·정리는 백업 관리 페이지(/backups)에서 한다.
// 백업이 없으면 보이지 않는다(저장 공간 부족 경고가 있을 때만 예외).
import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { HardDrive, ChevronRight } from 'lucide-react';
import { estimateStorage, isPendingReview, listLocal, localRec, useLocalRec } from '../localRec';
import { useMeetings } from '../store';

export default function LocalBackups() {
  const version = useLocalRec((s) => s.version);
  const closeOnMobile = useMeetings((s) => s.closeOnMobile);
  const [count, setCount] = useState(0);
  const [review, setReview] = useState(0);
  const [low, setLow] = useState(false);

  useEffect(() => {
    let alive = true;
    listLocal()
      .then((l) => {
        if (!alive) return;
        const items = l.filter((m) => m.id !== localRec.activeId && (m.fullParts > 0 || m.slices > 0));
        setCount(items.length);
        setReview(items.filter(isPendingReview).length);
      })
      .catch(() => {});
    estimateStorage().then((e) => { if (alive) setLow(!!e?.low); });
    return () => { alive = false; };
  }, [version]);

  if (!count && !low) return null;
  const incomplete = count - review;

  return (
    <NavLink to="/backups" className={({ isActive }) => `backup-entry${isActive ? ' active' : ''}`} onClick={closeOnMobile}>
      <HardDrive size={14} />
      <span className="backup-entry-label">녹음 백업</span>
      {review > 0 && <span className="bk-badge review">{review}건 검토 대기</span>}
      {incomplete > 0 && <span className="bk-badge incomplete">{incomplete}건 미완료</span>}
      {count === 0 && low && <span className="bk-badge warn">공간 부족</span>}
      <ChevronRight size={14} className="backup-entry-chev" />
    </NavLink>
  );
}
