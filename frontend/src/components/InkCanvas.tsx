import { useEffect, useRef, useState } from 'react';
import { makeFreedraw, setDeleted, isInk, type El } from './inkElements';

// E-ink(Boox 등) 전용 경량 에디터. 획 중에는 React state 0회 — ref + 네이티브 포인터 리스너로
// 새 선분만 증분 렌더한다. 저장 데이터는 Excalidraw elements(freedraw)와 호환.
// 편집 대상이 아닌 요소는 읽기 전용으로 값싸게 그리고, 저장 시 원본 그대로 유지한다.

interface Props {
  initialElements: El[];
  onChange: (elements: El[]) => void;
}

type Tool = 'pen' | 'erase';
interface Hist { ids: Set<string>; kind: 'add' | 'del' }

const ERASE_R = 10; // 화면 px
const MAX_DPR = 2;

function distSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hitStroke(e: El, wx: number, wy: number, r: number) {
  const pts: [number, number][] = e.points;
  const rr = r + (e.strokeWidth ?? 2) / 2;
  if (wx < e.x - rr || wx > e.x + e.width + rr || wy < e.y - rr || wy > e.y + e.height + rr) return false;
  if (pts.length === 1) return Math.hypot(wx - e.x - pts[0][0], wy - e.y - pts[0][1]) <= rr;
  for (let i = 1; i < pts.length; i++) {
    if (distSeg(wx - e.x, wy - e.y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= rr) return true;
  }
  return false;
}

// 읽기 전용 요소 단순 렌더 (rough.js 없음)
function drawForeign(ctx: CanvasRenderingContext2D, e: El) {
  ctx.strokeStyle = e.strokeColor || '#000';
  ctx.fillStyle = e.strokeColor || '#000';
  ctx.lineWidth = e.strokeWidth || 1;
  ctx.save();
  if (e.angle) {
    ctx.translate(e.x + e.width / 2, e.y + e.height / 2);
    ctx.rotate(e.angle);
    ctx.translate(-(e.x + e.width / 2), -(e.y + e.height / 2));
  }
  ctx.beginPath();
  switch (e.type) {
    case 'rectangle': ctx.rect(e.x, e.y, e.width, e.height); ctx.stroke(); break;
    case 'ellipse':
      ctx.ellipse(e.x + e.width / 2, e.y + e.height / 2, Math.abs(e.width / 2), Math.abs(e.height / 2), 0, 0, Math.PI * 2);
      ctx.stroke(); break;
    case 'diamond':
      ctx.moveTo(e.x + e.width / 2, e.y); ctx.lineTo(e.x + e.width, e.y + e.height / 2);
      ctx.lineTo(e.x + e.width / 2, e.y + e.height); ctx.lineTo(e.x, e.y + e.height / 2);
      ctx.closePath(); ctx.stroke(); break;
    case 'line': case 'arrow': {
      const p: [number, number][] = e.points || [];
      if (p.length < 2) break;
      p.forEach(([px, py], i) => (i ? ctx.lineTo(e.x + px, e.y + py) : ctx.moveTo(e.x + px, e.y + py)));
      ctx.stroke();
      if (e.type === 'arrow') { // 끝 화살촉
        const [ax, ay] = p[p.length - 2], [bx, by] = p[p.length - 1];
        const a = Math.atan2(by - ay, bx - ax), h = 12;
        ctx.beginPath();
        ctx.moveTo(e.x + bx, e.y + by);
        ctx.lineTo(e.x + bx - h * Math.cos(a - 0.45), e.y + by - h * Math.sin(a - 0.45));
        ctx.moveTo(e.x + bx, e.y + by);
        ctx.lineTo(e.x + bx - h * Math.cos(a + 0.45), e.y + by - h * Math.sin(a + 0.45));
        ctx.stroke();
      }
      break;
    }
    case 'text': {
      const fs = e.fontSize || 20;
      ctx.font = `${fs}px sans-serif`;
      ctx.textBaseline = 'top';
      String(e.text ?? '').split('\n').forEach((ln, i) => ctx.fillText(ln, e.x, e.y + i * fs * 1.25));
      break;
    }
    default: break; // image/frame 등은 표시만 생략 (데이터는 보존)
  }
  ctx.restore();
}

export default function InkCanvas({ initialElements, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [width, setWidth] = useState(2);
  const toolRef = useRef<Tool>('pen');
  const widthRef = useRef(2);
  const elsRef = useRef<El[]>(initialElements);
  const onChangeRef = useRef(onChange);
  const undoRef = useRef<Hist[]>([]);
  const redoRef = useRef<Hist[]>([]);
  const redrawRef = useRef<() => void>(() => {});
  const commitRef = useRef<() => void>(() => {});

  toolRef.current = tool;
  widthRef.current = width;
  onChangeRef.current = onChange;

  useEffect(() => {
    const canvas = canvasRef.current!, host = hostRef.current!;
    const ctx = canvas.getContext('2d', { desynchronized: true } as CanvasRenderingContext2DSettings)!;
    let dpr = 1, cw = 0, ch = 0;
    const off = { x: 0, y: 0 };
    let raf = 0;

    function redraw() {
      raf = 0;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const e of elsRef.current) {
        if (e.isDeleted) continue;
        // 뷰포트 밖 컬링 (선/화살표 점 범위는 width/height에 포함됨)
        if (e.x + off.x > cw + 20 || e.y + off.y > ch + 20 || e.x + e.width + off.x < -20 || e.y + e.height + off.y < -20) continue;
        ctx.setTransform(dpr, 0, 0, dpr, off.x * dpr, off.y * dpr);
        if (e.type === 'freedraw') {
          ctx.strokeStyle = e.strokeColor || '#000';
          ctx.lineWidth = e.strokeWidth || 2;
          const p: [number, number][] = e.points;
          ctx.beginPath();
          p.forEach(([px, py], i) => (i ? ctx.lineTo(e.x + px, e.y + py) : ctx.moveTo(e.x + px, e.y + py)));
          if (p.length < 2 || e.width + e.height < 0.01) ctx.lineTo(e.x + 0.01, e.y + 0.01);
          ctx.stroke();
        } else drawForeign(ctx, e);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(redraw); };
    redrawRef.current = redraw;

    function resize() {
      const r = host.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      cw = Math.max(1, Math.round(r.width)); ch = Math.max(1, Math.round(r.height));
      canvas.width = cw * dpr; canvas.height = ch * dpr;
      redraw();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // 저장은 획이 끝난 뒤에만 (부모가 debounce)
    commitRef.current = () => onChangeRef.current(elsRef.current);

    // ── 포인터 상태 (전부 ref/지역변수 — React state 갱신 없음) ──
    let penId: number | null = null;     // 그리기/지우기 중인 포인터
    let panId: number | null = null;     // 팬 중인 터치
    let pan = { sx: 0, sy: 0, ox: 0, oy: 0 };
    let rect = canvas.getBoundingClientRect();
    let pts: [number, number, number][] = []; // 장면 좌표
    let isPen = false;
    const pending = new Set<string>();

    const pos = (e: PointerEvent): [number, number] => [e.clientX - rect.left, e.clientY - rect.top];

    function segment(a: [number, number], b: [number, number]) {
      ctx.strokeStyle = '#000'; ctx.lineWidth = widthRef.current;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }

    function eraseAt(sx: number, sy: number) {
      const wx = sx - off.x, wy = sy - off.y;
      for (const e of elsRef.current) {
        if (e.type === 'freedraw' && !e.isDeleted && !pending.has(e.id) && hitStroke(e, wx, wy, ERASE_R)) pending.add(e.id);
      }
    }

    function down(e: PointerEvent) {
      if (e.pointerType === 'touch') {
        if (penId !== null || panId !== null) return; // 손바닥 무시
        panId = e.pointerId; rect = canvas.getBoundingClientRect();
        pan = { sx: e.clientX, sy: e.clientY, ox: off.x, oy: off.y };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (penId !== null) return;
      panId = null; // 펜이 닿으면 진행 중 터치 팬 취소
      e.preventDefault();
      penId = e.pointerId; isPen = e.pointerType === 'pen';
      rect = canvas.getBoundingClientRect();
      canvas.setPointerCapture(e.pointerId);
      const [x, y] = pos(e);
      if (toolRef.current === 'erase') { pending.clear(); eraseAt(x, y); return; }
      pts = [[x - off.x, y - off.y, e.pressure || 0.5]];
      ctx.lineCap = 'round'; ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(x, y, widthRef.current / 2, 0, Math.PI * 2); ctx.fill(); // 탭 점
    }

    function move(e: PointerEvent) {
      if (e.pointerId === panId) {
        off.x = pan.ox + e.clientX - pan.sx; off.y = pan.oy + e.clientY - pan.sy;
        schedule(); // rAF 스로틀 전체 재그리기
        return;
      }
      if (e.pointerId !== penId) return;
      const evs = e.getCoalescedEvents?.() ?? [];
      const list = evs.length ? evs : [e];
      if (toolRef.current === 'erase') { for (const ev of list) eraseAt(...pos(ev)); return; }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const ev of list) {
        const [x, y] = pos(ev);
        const last = pts[pts.length - 1];
        const lx = last[0] + off.x, ly = last[1] + off.y;
        if (Math.hypot(x - lx, y - ly) < 1) continue; // 미세 점 솎기
        segment([lx, ly], [x, y]);
        pts.push([x - off.x, y - off.y, ev.pressure || 0.5]);
      }
    }

    function up(e: PointerEvent) {
      if (e.pointerId === panId) { panId = null; redraw(); return; }
      if (e.pointerId !== penId) return;
      penId = null;
      if (toolRef.current === 'erase') {
        if (pending.size) {
          const ids = new Set(pending); pending.clear();
          elsRef.current = setDeleted(elsRef.current, ids, true);
          undoRef.current.push({ ids, kind: 'del' }); redoRef.current = [];
          redraw(); commitRef.current();
        }
        return;
      }
      if (!pts.length) return;
      const el = makeFreedraw(pts, widthRef.current, '#000000', isPen);
      pts = [];
      elsRef.current = [...elsRef.current, el];
      undoRef.current.push({ ids: new Set([el.id]), kind: 'add' }); redoRef.current = [];
      commitRef.current();
    }

    function cancel(e: PointerEvent) {
      if (e.pointerId === panId) { panId = null; redraw(); }
      else if (e.pointerId === penId) { penId = null; pts = []; pending.clear(); redraw(); }
    }

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);
    const noMenu = (ev: Event) => ev.preventDefault();
    canvas.addEventListener('contextmenu', noMenu);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('contextmenu', noMenu);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // undo/redo: 'add'의 반대는 삭제, 'del'의 반대는 복원
  function apply(h: Hist, undo: boolean) {
    const del = undo ? h.kind === 'add' : h.kind === 'del';
    elsRef.current = setDeleted(elsRef.current, h.ids, del);
    redrawRef.current(); commitRef.current();
  }
  function undo() { const h = undoRef.current.pop(); if (h) { redoRef.current.push(h); apply(h, true); } }
  function redo() { const h = redoRef.current.pop(); if (h) { undoRef.current.push(h); apply(h, false); } }
  function clearAll() {
    const ids = new Set(elsRef.current.filter(isInk).map((e) => e.id));
    if (!ids.size) return;
    if (!window.confirm('펜 필기를 모두 지울까요? (도형·텍스트는 유지됩니다)')) return;
    elsRef.current = setDeleted(elsRef.current, ids, true);
    undoRef.current.push({ ids, kind: 'del' }); redoRef.current = [];
    redrawRef.current(); commitRef.current();
  }

  return (
    <div className="ink-wrap">
      <div className="ink-bar">
        <button className={`ink-btn${tool === 'pen' ? ' on' : ''}`} onClick={() => setTool('pen')}>펜</button>
        <button className={`ink-btn${tool === 'erase' ? ' on' : ''}`} onClick={() => setTool('erase')}>지우개</button>
        <button className={`ink-btn${width === 2 ? ' on' : ''}`} onClick={() => setWidth(2)}>가늘게</button>
        <button className={`ink-btn${width === 4 ? ' on' : ''}`} onClick={() => setWidth(4)}>굵게</button>
        <span className="ink-gap" />
        <button className="ink-btn" onClick={undo}>실행취소</button>
        <button className="ink-btn" onClick={redo}>다시실행</button>
        <button className="ink-btn" onClick={clearAll}>전체삭제</button>
      </div>
      <div className="ink-host" ref={hostRef}>
        <canvas ref={canvasRef} className="ink-canvas" />
      </div>
    </div>
  );
}
