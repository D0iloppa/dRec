// 녹음 진단 로그 — 녹음기 상태 전이·오류·트랙 이벤트·구간 크기·일시정지/재개 시각을 세션 단위로 모아
// `POST /api/sessions/{id}/diag` 로 배치 전송한다(서버는 meeting 디렉터리 diag.jsonl 에 append).
// 배경(2026-10-29 meeting 80): iPad Safari 에서 일시정지→재개 후 3시간 동안 데이터가 0이었는데 원인을 추정밖에 못 했다.
// 전송 실패는 무시(다음 배치에 다시 실어 보내되 상한을 둔다). 녹음 흐름에 절대 영향을 주지 않는다.
import { getStoredToken } from './api';

interface Entry { t: number; ev: string; [k: string]: unknown }

const FLUSH_MS = 15_000;
const MAX_BATCH = 200;
const MAX_BUFFER = 1000;

const buf = new Map<number, Entry[]>();
let timer: ReturnType<typeof setInterval> | null = null;

/** 진단 이벤트 1건 기록(동기, 예외 없음). */
export function diag(mid: number | null | undefined, ev: string, data: Record<string, unknown> = {}): void {
  if (mid == null) return;
  try {
    const list = buf.get(mid) ?? [];
    list.push({ t: Date.now(), ev, ...data });
    if (list.length > MAX_BUFFER) list.splice(0, list.length - MAX_BUFFER);
    buf.set(mid, list);
    if (!timer) timer = setInterval(() => { void flushDiag(); }, FLUSH_MS);
    if (list.length >= MAX_BATCH) void flushDiag(mid);
  } catch { /* 무시 */ }
}

/** 쌓인 로그 전송. keepalive 로 페이지가 닫히는 중에도 시도한다. */
export async function flushDiag(only?: number): Promise<void> {
  const token = getStoredToken();
  if (!token) return;
  for (const [mid, list] of [...buf.entries()]) {
    if (only !== undefined && mid !== only) continue;
    if (!list.length) { buf.delete(mid); continue; }
    const batch = list.splice(0, MAX_BATCH);
    try {
      const res = await fetch(`/api/sessions/${mid}/diag`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ events: batch }),
      });
      if (res.status === 404 || res.status === 401) continue; // 회의 없음/로그인 만료 — 버린다
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      list.unshift(...batch); // 다음 주기에 재시도(상한은 diag() 에서 자른다)
      if (list.length > MAX_BUFFER) list.splice(0, list.length - MAX_BUFFER);
    }
  }
  if (![...buf.values()].some((l) => l.length) && timer) { clearInterval(timer); timer = null; }
}

if (typeof window !== 'undefined') {
  // 탭 숨김/닫힘 직전에 비운다(iOS 는 pagehide 가 마지막 기회)
  window.addEventListener('pagehide', () => { void flushDiag(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void flushDiag(); });
}
