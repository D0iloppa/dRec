// 기기별 사용자 설정(localStorage). 지금은 '화자 분리 사용' 기본값만 — 녹음 중 종료 화면에서 회의마다 바꿀 수 있다.
import { create } from 'zustand';

const KEY = 'drec_diarize_default';

function load(): boolean {
  try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
}

interface PrefsState {
  diarize: boolean;
  setDiarize: (v: boolean) => void;
}

export const usePrefs = create<PrefsState>((set) => ({
  diarize: load(),
  setDiarize: (v) => {
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* 저장 불가 — 메모리 값만 */ }
    set({ diarize: v });
  },
}));
