import { Component, ReactNode } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

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

// 이 파일만 Excalidraw를 import한다 — 펜 모드에서는 이 청크를 받지 않는다.
export default function ExcalidrawEditor({ initialData, onChange }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initialData: any; onChange: (elements: any) => void;
}) {
  return (
    <ExcalidrawBoundary>
      <Excalidraw initialData={initialData} onChange={onChange} />
    </ExcalidrawBoundary>
  );
}
