// 하단 광고 배너 — 로그인/로비 등 정적 화면 전용. Phaser canvas 바깥의 일반 DOM 이라
// transform/innerHTML 재작성 영향을 받지 않는다. 마운트당 1회만 push (ref 가드).
import { useEffect, useRef } from 'react';

const ADSENSE_CLIENT = 'ca-pub-4322659154168202';
const ADSENSE_SLOT = '3606107040';

export default function AdBar() {
  const pushed = useRef(false);

  useEffect(() => {
    if (!ADSENSE_SLOT || pushed.current) return;
    pushed.current = true;
    try {
      ((window as any).adsbygoogle = (window as any).adsbygoogle || []).push({});
    } catch {
      /* 로더 미로드 시 무시 */
    }
  }, []);

  if (!ADSENSE_SLOT) return null;
  return (
    <div className="dopl-adbar">
      <ins
        className="adsbygoogle"
        style={{ display: 'block', width: '100%', maxWidth: 728 }}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-slot={ADSENSE_SLOT}
        data-ad-format="horizontal"
        data-full-width-responsive="true"
      />
    </div>
  );
}
