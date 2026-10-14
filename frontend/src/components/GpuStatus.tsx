import { useEffect, useState } from 'react';
import { api, GpuHealth } from '../api';

const POLL_IDLE_MS = 30_000;
const POLL_WARMING_MS = 3_000;

type View = { cls: 'ready' | 'warming' | 'down' | 'sleep'; text: string };

function view(h: GpuHealth | null, failed: boolean): View {
  if (failed) return { cls: 'down', text: '연결 불가' };
  if (!h) return { cls: 'sleep', text: '확인 중…' };
  if (h.warming) return { cls: 'warming', text: '깨우는 중…' };
  if (!h.reachable) return { cls: 'down', text: '연결 불가' };
  if (h.caffeine_sec > 0) return { cls: 'ready', text: `☕ 녹음 중 유지 (${Math.ceil(h.caffeine_sec / 60)}분)` };
  if (h.loaded && h.diarize_loaded) {
    if (h.idle_unload_sec && h.idle_sec !== null) {
      const left = Math.max(1, Math.ceil((h.idle_unload_sec - h.idle_sec) / 60));
      return { cls: 'ready', text: `준비됨 (${left}분 후 절전)` };
    }
    return { cls: 'ready', text: '준비됨' };
  }
  return { cls: 'sleep', text: '절전 중' };
}

/** 사이드바 GPU 서버 상태. 사이드바가 열려 있을 때만 폴링(깨우는 중 3초, 평시 30초). */
export default function GpuStatus({ open }: { open: boolean }) {
  const [h, setH] = useState<GpuHealth | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0); // 바로 재조회

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let next = POLL_IDLE_MS;
      try {
        const d = await api.gpuHealth();
        if (!alive) return;
        setH(d); setFailed(false);
        if (d.warming) next = POLL_WARMING_MS;
      } catch {
        if (!alive) return;
        setFailed(true);
      }
      timer = setTimeout(tick, next);
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [open, nonce]);

  async function wake() {
    await api.gpuWarmup().catch(() => {});
    setNonce((n) => n + 1);
  }

  const v = view(h, failed);
  return (
    <div className={`gpu-card ${v.cls}`}>
      <span className="gpu-dot" />
      <span className="gpu-line">{v.text}</span>
      <button className="gpu-btn" onClick={wake} disabled={v.cls === 'warming'}>깨우기</button>
    </div>
  );
}
