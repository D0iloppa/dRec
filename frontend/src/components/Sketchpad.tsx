import { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { api, getStoredToken } from '../api';
import { readInkMode, writeInkMode, type El } from './inkElements';

// 두 에디터 모두 lazy — 펜 모드(e-ink)에서는 Excalidraw 청크를 받지 않는다.
const ExcalidrawEditor = lazy(() => import('./ExcalidrawEditor'));
const InkCanvas = lazy(() => import('./InkCanvas'));

declare global {
  interface Window {
    DrecInk?: {
      open(meetingId: number, token: string): void;
      openInline?(meetingId: number, token: string, x: number, y: number, w: number, h: number): void;
      updateRect?(x: number, y: number, w: number, h: number): void;
      close?(): void;
    };
  }
}

function parseElements(data: string | null | undefined): El[] {
  try { return data ? (JSON.parse(data).elements ?? []) : []; } catch { return []; }
}

type Rect = [number, number, number, number];

// 패널 rect(CSS px)를 뷰포트로 clip
function measure(el: HTMLElement | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const x = Math.max(0, r.left), y = Math.max(0, r.top);
  const w = Math.min(window.innerWidth, r.right) - x;
  const h = Math.min(window.innerHeight, r.bottom) - y;
  if (w < 1 || h < 1) return null;
  return [x, y, w, h];
}

// 패널 조상 중 스크롤 컨테이너의 overflow를 잠그고 복원 함수를 돌려준다
function lockScroll(el: HTMLElement | null): () => void {
  const saved: [HTMLElement, string][] = [];
  const targets: HTMLElement[] = [document.documentElement, document.body];
  for (let n = el?.parentElement; n; n = n.parentElement) targets.push(n);
  for (const t of targets) {
    const o = getComputedStyle(t).overflowY;
    if (o === 'auto' || o === 'scroll' || t === document.body || t === document.documentElement) {
      saved.push([t, t.style.overflow]);
      t.style.overflow = 'hidden';
    }
  }
  return () => saved.forEach(([t, v]) => { t.style.overflow = v; });
}

interface Props {
  meetingId: number;
}

export function SketchpadPanel({ meetingId }: Props) {
  const [full, setFull] = useState(false);
  const [ink, setInk] = useState(readInkMode);
  const [loaded, setLoaded] = useState(false);
  // 두 에디터가 공유하는 최신 elements (모드 전환 시 이어받음)
  const elementsRef = useRef<El[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 네이티브 펜 오버레이 편집 중: 에디터를 내리고 autosave를 막는다
  const [native, setNative] = useState(false);
  const nativeRef = useRef(false);
  const [rev, setRev] = useState(0);
  const hasNative = typeof window !== 'undefined' && !!window.DrecInk;
  const hasInline = hasNative && typeof window.DrecInk?.openInline === 'function';
  const panelRef = useRef<HTMLDivElement>(null);
  const [inline, setInline] = useState(false);
  const inlineRef = useRef(false);
  const loadedRef = useRef(false);
  const autoDoneRef = useRef(false); // 회의 마운트당 자동 오픈 1회
  const unlockRef = useRef<(() => void) | null>(null);
  const rectRef = useRef<Rect | null>(null);

  useEffect(() => {
    autoDoneRef.current = false;
    loadedRef.current = false;
    setLoaded(false);
    api.getCanvas(meetingId)
      .then(({ canvas_data }) => {
        // elements만 복원 — appState는 collaborators Map 역직렬화 이슈로 제외
        elementsRef.current = parseElements(canvas_data);
      })
      .catch(() => { elementsRef.current = []; })
      .finally(() => { loadedRef.current = true; setLoaded(true); });
  }, [meetingId]);

  useEffect(() => {
    function onClosed(e: Event) {
      const id = (e as CustomEvent<{ meetingId?: number }>).detail?.meetingId;
      if (Number(id) !== meetingId) return;
      api.getCanvas(meetingId)
        .then(({ canvas_data }) => { elementsRef.current = parseElements(canvas_data); })
        .catch(() => {})
        .finally(() => {
          unlockRef.current?.(); unlockRef.current = null;
          inlineRef.current = false; rectRef.current = null;
          setInline(false);
          nativeRef.current = false;
          setNative(false);
          setRev((r) => r + 1);
        });
    }
    window.addEventListener('drec-ink-closed', onClosed);
    return () => window.removeEventListener('drec-ink-closed', onClosed);
  }, [meetingId]);

  // 언마운트·회의 변경 시 열려 있는 네이티브 펜 닫기 + 스크롤 잠금 해제
  useEffect(() => () => {
    unlockRef.current?.(); unlockRef.current = null;
    if (nativeRef.current) {
      nativeRef.current = false; inlineRef.current = false; rectRef.current = null;
      try { if (typeof window.DrecInk?.close === 'function') window.DrecInk.close(); } catch { /* noop */ }
    }
  }, [meetingId]);

  // 인라인 중 rect 동기화
  useEffect(() => {
    if (!inline) return;
    function sync() {
      const r = measure(panelRef.current), p = rectRef.current;
      if (!r || !p || !inlineRef.current) return;
      if (r.every((v, i) => Math.abs(v - p[i]) < 1)) return;
      rectRef.current = r;
      try { window.DrecInk?.updateRect?.(...r); } catch { /* noop */ }
    }
    const t = setInterval(sync, 1000);
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    return () => {
      clearInterval(t);
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, [inline]);

  // 저장 flush 후 인라인 오픈. 이미 native면 무시.
  async function openInline() {
    const bridge = window.DrecInk;
    const token = getStoredToken();
    if (!bridge?.openInline || !token || nativeRef.current) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      try { await api.putCanvas(meetingId, { elements: elementsRef.current }); }
      catch { return; }
    }
    if (nativeRef.current) return;
    nativeRef.current = true;
    inlineRef.current = true;
    setNative(true);
    setInline(true);
    // 에디터 언마운트 후 레이아웃 확정을 기다려 측정
    requestAnimationFrame(() => {
      if (!inlineRef.current) return;
      panelRef.current?.scrollIntoView({ block: 'nearest' });
      unlockRef.current = lockScroll(panelRef.current);
      const r = measure(panelRef.current);
      if (!r) { // 측정 불가: 열지 않고 복구
        unlockRef.current?.(); unlockRef.current = null;
        inlineRef.current = false; nativeRef.current = false;
        setInline(false); setNative(false);
        return;
      }
      rectRef.current = r;
      bridge.openInline!(meetingId, token, ...r);
    });
  }

  useEffect(() => {
    if (loaded && loadedRef.current && hasInline && !autoDoneRef.current) {
      autoDoneRef.current = true;
      void openInline();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, meetingId]);

  async function openNative() {
    const bridge = window.DrecInk;
    const token = getStoredToken();
    if (!bridge || !token) return;
    // 대기 중인 디바운스 저장을 즉시 반영한 뒤에만 넘긴다
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      try { await api.putCanvas(meetingId, { elements: elementsRef.current }); }
      catch { return; } // 저장 실패 시 넘기지 않음(데이터 유실 방지)
    }
    nativeRef.current = true;
    setNative(true); // 에디터 언마운트
    bridge.open(meetingId, token);
  }

  function onChange(elements: El[]) {
    if (nativeRef.current) return;
    elementsRef.current = elements;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      api.putCanvas(meetingId, { elements }).catch(() => {});
    }, 500);
  }

  function setMode(next: boolean) {
    if (next === ink) return;
    writeInkMode(next);
    setInk(next);
  }

  if (!loaded) {
    return <div className="sketch-panel sketch-loading">불러오는 중…</div>;
  }

  return (
    <div ref={panelRef} className={`sketch-panel${full ? ' sketch-fullscreen' : ''}`}>
      <div className="sketch-toolbar">
        <div className="sketch-mode-seg" role="group" aria-label="편집 방식">
          <button
            className={`sketch-seg-btn${ink ? ' on' : ''}`}
            onClick={() => setMode(true)}
            aria-pressed={ink}
            title="가벼운 캔버스 (e-ink용)"
          >
            간단 그리기
          </button>
          <button
            className={`sketch-seg-btn${!ink ? ' on' : ''}`}
            onClick={() => setMode(false)}
            aria-pressed={!ink}
            title="Excalidraw 편집기"
          >
            도형 편집
          </button>
        </div>
        {hasInline && (
          <button
            className="sketch-mode-btn sketch-native-btn"
            onClick={openInline}
            disabled={native}
            title="이 패널 위에서 네이티브 펜으로 그리기"
          >
            여기서 필기
          </button>
        )}
        {hasNative && (
          <button
            className="sketch-mode-btn sketch-native-btn"
            onClick={openNative}
            disabled={native}
            title="기기 네이티브 펜으로 그리기"
          >
            크게 필기
          </button>
        )}
        <button
          className="sketch-expand-btn"
          onClick={() => setFull((v) => !v)}
          aria-label={full ? '스케치패드 축소' : '스케치패드 전체화면'}
        >
          {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
      <div className="excalidraw-host">
        {native ? (inline ? <div className="sketch-inline-placeholder" /> : <div className="sketch-loading-inline">필기 중…</div>) : (
        <Suspense fallback={<div className="sketch-loading-inline">불러오는 중…</div>}>
          {ink
            ? <InkCanvas key={`ink${rev}`} initialElements={elementsRef.current} onChange={onChange} />
            : <ExcalidrawEditor key={`ex${rev}`} initialData={{ elements: elementsRef.current }} onChange={onChange} />}
        </Suspense>
        )}
      </div>
    </div>
  );
}
