// 전체 녹음 업로더. 라우트가 바뀌어도(녹음 → 상세 페이지) 살아남도록 모듈 단위 zustand 스토어로 둔다.
// 흐름: 업로드(XHR, 진행률) → 서버 변환 대기 → /finish. 실패 시 재시도 또는 조각으로 복구(/finish 만 호출).
// 로컬 백업(IndexedDB, localRec.ts)은 자동으로 지우지 않는다 — 성공하면 '검토 대기'로 바꾸고, 삭제는 사용자 승인으로만.
import { create } from 'zustand';
import { api } from './api';
import { flushSlices, markFinishedLocal, markUploadedLocal } from './localRec';

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
  /** blobs: 녹음기 세대별 원본(보통 1개, 마이크 재연결 시 여러 개). localId: 로컬 백업 키가 다를 때(복구 시 새 회의로 올린 경우) */
  start: (id: number, blobs: Blob | Blob[], opts?: { localId?: number }) => void;
  retry: (id: number) => void;
  cancel: (id: number) => void; // 전송 중인 업로드 중단 → failed 로 전이(재시도 / 조각으로 복구 선택)
  recover: (id: number) => Promise<void>;
  clear: (id: number) => void;
}

// Blob 은 재시도용으로 보관 — 직렬화 대상이 아니므로 스토어 밖에 둔다.
const blobs = new Map<number, Blob[]>();
const localIds = new Map<number, number>();
const aborts = new Map<number, () => void>();
const SPEED_WINDOW_MS = 500;
const EMA = 0.3;

export const useUploader = create<UploaderState>((set) => {
  const patch = (id: number, p: Partial<UploadState>) =>
    set((s) => ({ byId: { ...s.byId, [id]: { ...s.byId[id], ...p } } }));

  async function run(id: number) {
    const list = blobs.get(id);
    if (!list?.length) return;
    const size = list.reduce((n, b) => n + b.size, 0);
    set((s) => ({
      byId: { ...s.byId, [id]: { phase: 'uploading', loaded: 0, total: size, speed: 0, etaSec: null } },
    }));
    let lastT = performance.now();
    let lastLoaded = 0;
    let speed = 0;
    try {
      const up = api.uploadAudio(id, list, (loaded, total) => {
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
    await finalize(id, true);
  }

  async function finalize(id: number, uploaded: boolean) {
    try {
      await api.finishSession(id);
      blobs.delete(id);
      const localId = localIds.get(id) ?? id;
      localIds.delete(id);
      // 원본까지 올라갔으면 '검토 대기'(사용자가 결과 확인 후 승인해야 삭제), 조각으로만 복구했으면 미완료로 남긴다
      void (uploaded ? markUploadedLocal(localId, id) : markFinishedLocal(localId));
      patch(id, { phase: 'done', etaSec: null });
    } catch (e) {
      patch(id, { phase: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    byId: {},
    start: (id, b, opts) => {
      blobs.set(id, Array.isArray(b) ? b : [b]);
      if (opts?.localId !== undefined) localIds.set(id, opts.localId);
      void run(id);
    },
    retry: (id) => { void run(id); },
    cancel: (id) => { aborts.get(id)?.(); },
    recover: async (id) => {
      patch(id, { phase: 'converting', loaded: 0, total: 0, speed: 0, etaSec: null, error: undefined });
      blobs.delete(id);
      // 조각으로 복구 = 서버 전사 조각에 의존 → 아직 못 보낸 조각부터 마저 보낸다(최대 20초)
      await flushSlices(localIds.get(id) ?? id);
      await finalize(id, false);
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
