// E-ink 펜 모드 보조 모듈 — Excalidraw를 import하지 않는 순수 함수만 둔다.
// 데이터 계약: Excalidraw elements JSON. 잉크 획은 freedraw 요소로 저장하고,
// 그 외 요소(도형/텍스트 등)와 알 수 없는 필드는 절대 건드리지 않는다.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type El = Record<string, any>;

const rnd = () => Math.floor(Math.random() * 2 ** 31);

export function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 21)
    : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

/** 화면(장면) 좌표의 점들 [x,y,pressure]로 freedraw 요소를 만든다. */
export function makeFreedraw(
  pts: [number, number, number][], strokeWidth: number, strokeColor: string, pen: boolean,
): El {
  const x = pts[0][0], y = pts[0][1];
  // Excalidraw는 점 하나짜리(탭)를 [0,0],[0.0001,0.0001]로 표현한다.
  const rel: [number, number][] = pts.length > 1
    ? pts.map((p) => [p[0] - x, p[1] - y])
    : [[0, 0], [0.0001, 0.0001]];
  const xs = rel.map((p) => p[0]), ys = rel.map((p) => p[1]);
  return {
    id: newId(), type: 'freedraw', x, y,
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    angle: 0, strokeColor, backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, roundness: null,
    seed: rnd(), version: 1, versionNonce: rnd(), isDeleted: false,
    boundElements: null, updated: Date.now(), link: null, locked: false,
    // index: null — Excalidraw restore(syncInvalidIndices)가 로드 시 채워준다.
    index: null,
    points: rel,
    pressures: pen && pts.length > 1 ? pts.map((p) => p[2]) : [],
    simulatePressure: !pen,
    lastCommittedPoint: rel[rel.length - 1],
  };
}

/** 삭제/복원 — splice 대신 isDeleted 토글 + version 증가(Excalidraw 관례). 나머지 요소는 같은 참조 그대로. */
export function setDeleted(elements: El[], ids: Set<string>, deleted: boolean): El[] {
  const now = Date.now();
  return elements.map((e) =>
    ids.has(e.id) && !!e.isDeleted !== deleted
      ? { ...e, isDeleted: deleted, version: (e.version ?? 0) + 1, versionNonce: rnd(), updated: now }
      : e);
}

export const isInk = (e: El) => e.type === 'freedraw' && !e.isDeleted;

// ── 모드 저장 (localStorage 실패 대비 try/catch) ──────────
const KEY = 'drec.sketch.ink';

export function readInkMode(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('ink');
    if (q === '1') return true;
    if (q === '0') return false;
  } catch { /* noop */ }
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function writeInkMode(on: boolean) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* noop */ }
}
