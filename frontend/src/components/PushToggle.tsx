import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';

type State = 'loading' | 'unsupported' | 'blocked' | 'on' | 'off';

const LABEL: Record<State, string> = {
  loading: '확인 중…', unsupported: '미지원', blocked: '차단됨', on: '켜짐', off: '꺼짐',
};

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// iOS 는 홈 화면에 추가한(standalone) 웹앱에서만 Web Push 를 지원한다.
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

function urlB64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** 사이드바 알림 토글. 권한 요청은 사용자가 켜기를 눌렀을 때만. */
export default function PushToggle() {
  const [state, setState] = useState<State>('loading');
  const [busy, setBusy] = useState(false);
  const iosHint = isIos() && !isStandalone();

  const refresh = useCallback(async () => {
    if (!supported()) return setState('unsupported');
    if (Notification.permission === 'denied') return setState('blocked');
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js') ?? await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setState(sub && Notification.permission === 'granted' ? 'on' : 'off');
    } catch {
      setState('off');
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function enable() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return refresh();
    const reg = await navigator.serviceWorker.ready;
    const { public_key } = await api.pushPublicKey();
    const sub = (await reg.pushManager.getSubscription())
      ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(public_key) }));
    await api.pushSubscribe(sub.toJSON());
  }

  async function disable() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await api.pushUnsubscribe(sub.endpoint).catch(() => {}); // 서버 실패해도 기기 구독은 해제(서버는 410 시 정리)
    await sub.unsubscribe();
  }

  async function toggle() {
    setBusy(true);
    try {
      if (state === 'on') await disable(); else await enable();
    } catch (e) {
      dialog.error(String((e as Error).message || e));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function test() {
    try {
      const { sent } = await api.pushTest();
      if (!sent) dialog.error('등록된 기기가 없습니다. 알림을 다시 켜주세요');
    } catch (e) {
      dialog.error(String((e as Error).message || e));
    }
  }

  const canToggle = state === 'on' || state === 'off';
  return (
    <div className="push-card">
      <div className="push-row">
        <span className="gpu-line">
          {state === 'on' ? <Bell size={14} /> : <BellOff size={14} />} 알림 {LABEL[state]}
        </span>
        {state === 'on' && <button className="gpu-btn" onClick={test}>테스트</button>}
        {canToggle && (
          <button className="gpu-btn" onClick={toggle} disabled={busy}>
            {state === 'on' ? '끄기' : '켜기'}
          </button>
        )}
      </div>
      {iosHint && <div className="push-hint">홈 화면에 추가한 앱에서만 알림을 받을 수 있어요</div>}
      {state === 'blocked' && <div className="push-hint">브라우저 설정에서 알림 권한을 허용해 주세요</div>}
    </div>
  );
}
