import { useState, useRef, useEffect, Component, ReactNode } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { Maximize2, Minimize2 } from 'lucide-react';
import { api } from '../api';

// Excalidraw 크래시 시 흰화면 방지
class ExcalidrawBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#888', fontSize: 13 }}>
          스케치패드 로드 실패: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}

interface Props {
  meetingId: number;
}

export function SketchpadPanel({ meetingId }: Props) {
  const [full, setFull] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [initialData, setInitialData] = useState<any>(undefined);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.getCanvas(meetingId)
      .then(({ canvas_data }) => {
        if (!canvas_data) { setInitialData(null); return; }
        try {
          const parsed = JSON.parse(canvas_data);
          // elements만 복원 — appState는 collaborators Map 역직렬화 이슈로 제외
          setInitialData({ elements: parsed.elements ?? [] });
        }
        catch { setInitialData(null); }
      })
      .catch(() => setInitialData(null));
  }, [meetingId]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function onChange(elements: any) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      api.putCanvas(meetingId, { elements }).catch(() => {});
    }, 500);
  }

  if (initialData === undefined) {
    return <div className="sketch-panel sketch-loading">불러오는 중…</div>;
  }

  return (
    <div className={`sketch-panel${full ? ' sketch-fullscreen' : ''}`}>
      <div className="sketch-toolbar">
        <button
          className="sketch-expand-btn"
          onClick={() => setFull((v) => !v)}
          aria-label={full ? '스케치패드 축소' : '스케치패드 전체화면'}
        >
          {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
      <div className="excalidraw-host">
        <ExcalidrawBoundary>
          <Excalidraw initialData={initialData} onChange={onChange} />
        </ExcalidrawBoundary>
      </div>
    </div>
  );
}
