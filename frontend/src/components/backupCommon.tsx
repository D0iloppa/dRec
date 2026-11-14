// 로컬 백업 UI 공용 조각 — 회의 상세 카드(LocalBackupPanel)와 백업 관리 페이지(pages/Backups)가 같이 쓴다.
// 안전 원칙은 그대로: 백업은 사용자가 승인/삭제하기 전까지 자동으로 지우지 않는다.
import { AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';
import { toast } from 'sonner';
import { isPendingReview, LocalSummary, purgeLocal } from '../localRec';
import { dialog } from '../ui/dialog';
import { fmtBytes, fmtDuration } from './format';

const MISMATCH_RATIO = 0.95; // 서버 길이가 로컬의 95% 미만이면 불일치

export type VerdictKind = 'match' | 'mismatch' | 'missing' | 'busy' | 'unknown';
export interface Verdict { kind: VerdictKind; warn: string }

/** 기기 백업 길이와 서버 녹음 길이를 비교한다. */
export function verdict(localDur: number | null, serverDur: number | null, serverHasAudio: boolean, uploadBusy: boolean): Verdict {
  if (uploadBusy) return { kind: 'busy', warn: '' }; // 업로드 중에는 서버 길이가 아직 없다
  if (!serverHasAudio) return { kind: 'missing', warn: '서버에 원본 음성이 없습니다. 백업으로 다시 업로드하세요.' };
  if (localDur && serverDur != null) {
    if (serverDur < localDur * MISMATCH_RATIO) {
      return {
        kind: 'mismatch',
        warn: `서버 음성(${fmtDuration(serverDur)})이 기기 백업(${fmtDuration(localDur)})보다 ${Math.round((1 - serverDur / localDur) * 100)}% 짧습니다. 업로드·조립 중 일부가 빠졌을 수 있습니다.`,
      };
    }
    return { kind: 'match', warn: '' };
  }
  return { kind: 'unknown', warn: '' };
}

export function VerdictBadge({ kind }: { kind: VerdictKind }) {
  if (kind === 'match') return <span className="bk-badge ok"><CheckCircle2 size={12} /> 일치</span>;
  if (kind === 'mismatch' || kind === 'missing') return <span className="bk-badge warn"><AlertTriangle size={12} /> {kind === 'missing' ? '서버 없음' : '불일치'}</span>;
  if (kind === 'busy') return <span className="bk-badge">업로드 중</span>;
  return <span className="bk-badge"><HelpCircle size={12} /> 확인 중</span>;
}

export function StateBadge({ meta }: { meta: LocalSummary }) {
  return isPendingReview(meta)
    ? <span className="bk-badge review">검토 대기</span>
    : <span className="bk-badge incomplete">업로드 미완료</span>;
}

/** 기기 백업 vs 서버 녹음 나란히 비교(좁은 화면에서도 2열 유지). */
export function BackupCompare({ meta, localDur, approx, measuring, serverDur, serverHasAudio, kind }: {
  meta: LocalSummary; localDur: number | null; approx: boolean; measuring: boolean;
  serverDur: number | null; serverHasAudio: boolean; kind: VerdictKind;
}) {
  const mark = kind === 'match' ? 'ok' : kind === 'mismatch' || kind === 'missing' ? 'warn' : '';
  return (
    <div className={`bk-compare ${mark}`}>
      <div className="bk-tile">
        <div className="bk-k">기기 백업</div>
        <div className="bk-v">{measuring && localDur == null ? '측정 중…' : localDur != null ? `${approx ? '≈ ' : ''}${fmtDuration(localDur)}` : '알 수 없음'}</div>
        <div className="bk-sub">{fmtBytes(meta.fullBytes)}{meta.gens > 1 ? ` · ${meta.gens}구간` : ''}</div>
      </div>
      <div className="bk-eq" aria-hidden>{kind === 'match' ? '=' : kind === 'mismatch' || kind === 'missing' ? '≠' : '·'}</div>
      <div className="bk-tile">
        <div className="bk-k">서버 음성</div>
        <div className="bk-v">{serverDur != null ? fmtDuration(serverDur) : serverHasAudio ? '길이 미확인' : '없음'}</div>
        <div className="bk-sub">{kind === 'match' ? '길이 일치' : kind === 'mismatch' ? '더 짧음' : ' '}</div>
      </div>
    </div>
  );
}

/** 승인 → 삭제(불일치 경고가 있으면 한 번 더 확인). 삭제했으면 true. */
export async function approveAndPurge(meta: LocalSummary, warn: string): Promise<boolean> {
  if (warn) {
    const again = await dialog.confirm('길이 불일치 경고가 있습니다', `${warn}\n그래도 승인하고 백업을 삭제하면 기기의 원본을 되살릴 수 없습니다.`, '그래도 진행');
    if (!again) return false;
  }
  const ok = await dialog.confirm(
    '업로드 완료를 승인하고 백업을 삭제할까요?',
    '서버의 음성·받아쓰기 결과를 확인했다면 승인하세요. 삭제 후에는 되돌릴 수 없습니다. 필요하면 먼저 "파일로 저장"하세요.',
    '승인하고 삭제',
  );
  if (!ok) return false;
  await purgeLocal(meta.id);
  toast.success('기기 백업을 삭제했습니다');
  return true;
}

/** 업로드 미완료 백업 삭제(원본을 되살릴 수 없으므로 강하게 확인). */
export async function purgeIncomplete(meta: LocalSummary): Promise<boolean> {
  const ok = await dialog.confirm('업로드되지 않은 백업입니다', '삭제하면 이 음성의 원본을 되살릴 수 없습니다. 정말 삭제할까요?', '삭제');
  if (ok) await purgeLocal(meta.id);
  return ok;
}

export const REUPLOAD_CONFIRM = {
  title: '기기 백업으로 다시 업로드할까요?',
  text: '서버의 원본 음성을 이 백업으로 교체하고 받아쓰기·화자 분리를 다시 실행합니다. 백업은 그대로 남습니다.',
  ok: '다시 업로드',
};
