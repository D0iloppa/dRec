import { lazy, Suspense } from 'react';

// 스케치패드(Excalidraw ≈ 1.6MB)는 탭을 열 때만 받는다 — 초기(entry) 번들에서 제외.
const load = () => import('./Sketchpad').then((m) => ({ default: m.SketchpadPanel }));
const Lazy = lazy(load);

/** 탭 hover/터치 시 미리 요청(이미 받았으면 no-op). */
export const prefetchSketchpad = () => { void load(); };

export function Sketch({ meetingId }: { meetingId: number }) {
  return (
    <Suspense fallback={<div className="sketch-panel sketch-loading">불러오는 중…</div>}>
      <Lazy meetingId={meetingId} />
    </Suspense>
  );
}
