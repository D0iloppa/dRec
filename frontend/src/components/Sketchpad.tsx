import { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { api, getStoredToken } from '../api';
import { readInkMode, writeInkMode, type El } from './inkElements';

// 두 에디터 모두 lazy — 펜 모드(e-ink)에서는 Excalidraw 청크를 받지 않는다.
const ExcalidrawEditor = lazy(() => import('./ExcalidrawEditor'));
const InkCanvas = lazy(() => import('./InkCanvas'));

declare global {
  interface Window {
    DrecInk?: { open(meetingId: number, token: string): void };
  }
}

function parseElements(data: string | null | undefined): El[] {
  try { return data ? (JSON.parse(data).elements ?? []) : []; } catch { return []; }
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

  useEffect(() => {
    setLoaded(false);
    api.getCanvas(meetingId)
      .then(({ canvas_data }) => {
        // elements만 복원 — appState는 collaborators Map 역직렬화 이슈로 제외
        elementsRef.current = parseElements(canvas_data);
      })
      .catch(() => { elementsRef.current = []; })
      .finally(() => setLoaded(true));
  }, [meetingId]);

  useEffect(() => {
    function onClosed(e: Event) {
      const id = (e as CustomEvent<{ meetingId?: number }>).detail?.meetingId;
      if (Number(id) !== meetingId) return;
      api.getCanvas(meetingId)
        .then(({ canvas_data }) => { elementsRef.current = parseElements(canvas_data); })
        .catch(() => {})
        .finally(() => {
          nativeRef.current = false;
          setNative(false);
          setRev((r) => r + 1);
        });
    }
    window.addEventListener('drec-ink-closed', onClosed);
    return () => window.removeEventListener('drec-ink-closed', onClosed);
  }, [meetingId]);

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

  function toggleInk() {
    const next = !ink;
    writeInkMode(next);
    setInk(next);
  }

  if (!loaded) {
    return <div className="sketch-panel sketch-loading">불러오는 중…</div>;
  }

  return (
    <div className={`sketch-panel${full ? ' sketch-fullscreen' : ''}`}>
      <div className="sketch-toolbar">
        <button
          className={`sketch-mode-btn${ink ? ' on' : ''}`}
          onClick={toggleInk}
          aria-pressed={ink}
          title="E-ink 태블릿용 가벼운 펜 모드"
        >
          펜 모드
        </button>
        {hasNative && (
          <button
            className="sketch-mode-btn sketch-native-btn"
            onClick={openNative}
            disabled={native}
            title="기기 네이티브 펜으로 그리기"
          >
            네이티브 펜
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
        {native ? <div className="sketch-loading-inline">펜 화면에서 편집 중…</div> : (
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
