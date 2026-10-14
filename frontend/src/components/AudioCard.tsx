import { Headphones } from 'lucide-react';
import { api } from '../api';
import { fmtDuration } from './format';

/** 업로드된 원본 녹음 플레이어. 처리 상태와 무관하게 has_audio 이면 노출해 녹음이 저장됐는지 바로 확인하게 한다. */
export default function AudioCard({ id, hasM4a, durationSec }: { id: number; hasM4a: boolean; durationSec?: number | null }) {
  return (
    <div className="audio-card">
      <div className="audio-card-head">
        <Headphones size={15} />
        <span>원본 녹음</span>
        {durationSec ? <span className="audio-card-dur">{fmtDuration(durationSec)}</span> : null}
      </div>
      {/* preload=none: 상세 진입 시 수십 MB 오디오를 미리 당기지 않는다(길이는 헤더의 durationSec 로 표시). 재생 시 Range 로 스트리밍. */}
      {/* key: 포맷 후보가 바뀌면(m4a 변환 완료) 소스를 다시 평가 */}
      <audio key={hasM4a ? 'm4a' : 'webm'} controls preload="none">
        {hasM4a && <source src={api.audioUrl(id, 'm4a')} type="audio/mp4" />}
        <source src={api.audioUrl(id, 'webm')} type="audio/webm" />
      </audio>
    </div>
  );
}
