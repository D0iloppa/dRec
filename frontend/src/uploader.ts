// 전체 녹음 업로더. 라우트가 바뀌어도(녹음 → 상세 페이지) 살아남도록 모듈 단위 zustand 스토어로 둔다.
// 흐름: 업로드(XHR, 진행률) → 서버 변환 대기 → /finish. 실패 시 재시도 또는 조각으로 복구(/finish 만 호출).
import { create } from 'zustand';
import { api } from './api';

export type UploadPhase = 'uploading' | 'converting' | 'failed' | 'done';

export interface UploadState {
  phase: UploadPhase;
  loaded: number;
  total: number;
  speed: number;        // bytes/s (지수이동평균)
  etaSec: number | null;
  error?: string;
}

interface UploaderState {
  byId: Record<number, UploadState>;
  start: (id: number, blob: Blob) => void;
  retry: (id: number) => void;
  cancel: (id: number) => void; // 전송 중인 업로드 중단 → failed 로 전이(재시도 / 조각으로 복구 선택)
  recover: (id: number) => Promise<void>;
  clear: (id: number) => void;
}

// Blob 은 재시도용으로 보관 — 직렬화 대상이 아니므로 스토어 밖에 둔다.
const blobs = new Map<number, Blob>();
const aborts = new Map<number, () => void>();
const SPEED_WINDOW_MS = 500;
const EMA = 0.3;

const extOf = (blob: Blob) => (blob.type.includes('mp4') ? 'm4a' : 'webm');

export const useUploader = create<UploaderState>((set) => {
  const patch = (id: number, p: Partial<UploadState>) =>
    set((s) => ({ byId: { ...s.byId, [id]: { ...s.byId[id], ...p } } }));

  async function run(id: number) {
    const blob = blobs.get(id);
    if (!blob) return;
    set((s) => ({
      byId: { ...s.byId, [id]: { phase: 'uploading', loaded: 0, total: blob.size, speed: 0, etaSec: null } },
    }));
    let lastT = performance.now();
    let lastLoaded = 0;
    let speed = 0;
    try {
      const up = api.uploadAudio(id, blob, `full.${extOf(blob)}`, (loaded, total) => {
        const now = performance.now();
        if (now - lastT >= SPEED_WINDOW_MS) {
          const inst = ((loaded - lastLoaded) / (now - lastT)) * 1000;
          speed = speed === 0 ? inst : EMA * inst + (1 - EMA) * speed;
          lastT = now;
          lastLoaded = loaded;
        }
        const done = loaded >= total;
        patch(id, {
          phase: done ? 'converting' : 'uploading', // 바이트 전송 후 서버가 ffmpeg 로 변환하는 구간
          loaded, total, speed,
          etaSec: !done && speed > 0 ? (total - loaded) / speed : null,
        });
      });
      aborts.set(id, up.abort);
      await up.promise;
    } catch (e) {
      patch(id, { phase: 'failed', error: e instanceof Error ? e.message : String(e) });
      return;
    } finally {
      aborts.delete(id);
    }
    await finalize(id);
  }

  async function finalize(id: number) {
    try {
      await api.finishSession(id);
      blobs.delete(id);
      patch(id, { phase: 'done', etaSec: null });
    } catch (e) {
      patch(id, { phase: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    byId: {},
    start: (id, blob) => { blobs.set(id, blob); void run(id); },
    retry: (id) => { void run(id); },
    cancel: (id) => { aborts.get(id)?.(); },
    recover: async (id) => {
      patch(id, { phase: 'converting', loaded: 0, total: 0, speed: 0, etaSec: null, error: undefined });
      blobs.delete(id);
      await finalize(id);
    },
    clear: (id) => set((s) => {
      const { [id]: _, ...rest } = s.byId;
      return { byId: rest };
    }),
  };
});

// 업로드 중 탭 닫기/새로고침 경고
const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
let warning = false;
useUploader.subscribe((s) => {
  const busy = Object.values(s.byId).some((u) => u.phase === 'uploading' || u.phase === 'converting');
  if (busy && !warning) { window.addEventListener('beforeunload', warn); warning = true; }
  else if (!busy && warning) { window.removeEventListener('beforeunload', warn); warning = false; }
});
