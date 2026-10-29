// 녹음 로컬 영속 저장(IndexedDB) + 전사 조각 전송 큐.
// 배경(2026-10-29, meeting 80): 오디오가 브라우저 메모리에만 있어 마이크가 죽거나 탭이 정리되면 통째로 사라졌다.
// 이제 전체 녹음(full, timeslice 10초)의 각 조각과 VAD 슬라이스를 받는 즉시 IndexedDB 에 append 한다.
// 전체 녹음 백업은 자동으로 지우지 않는다 — 업로드·/finish 가 성공해도 '검토 대기'로만 바꾸고, 사용자가 회의 상세의
// 백업 패널(LocalBackupPanel)에서 서버 결과(길이 등)를 확인하고 승인해야 삭제된다(파이프라인 결함 대비 원본 보존).
// VAD 슬라이스는 전송 성공 시 즉시 지운다: 전체 녹음과 같은 마이크 트랙의 사본이라 full 이 죽으면 같이 죽고,
// 전송된 조각은 서버가 /data/audio/{id}/chunks 에 따로 보관하므로 기기 사본의 복구 가치가 없다. 미전송분만 남는다.
// 앱을 다시 열면 RecoveryBanner 가 미완료 녹음과 검토 대기 건수를 알려 준다.
//
// Safari(iOS/iPadOS) 호환:
// - Blob 을 그대로 넣지 않고 ArrayBuffer 로 저장(구 Safari 의 IDB Blob 저장 버그 회피).
// - 복합 키(배열) 대신 0 패딩 문자열 키 + 접두 범위 조회(인덱스 불필요).
// - 백그라운드 복귀 후 "Connection to Indexed Database server lost" 류 오류 → 연결을 버리고 1회 재시도.
// - 사파리 사생활 보호 모드 등 IDB 자체가 안 열리면 조용히 비활성(메모리 녹음은 그대로 동작).
import { create } from 'zustand';
import { api, HttpError } from './api';
import { diag } from './diag';

const DB_NAME = 'drec-local';
const DB_VER = 1;
const META = 'meta';
const FULL = 'full';
const SLICES = 'slices';

/** 미완료 녹음 1건의 메타. 키 = 서버 meeting id. */
export interface LocalMeta {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** /finish 는 호출됐지만 원본은 아직 업로드되지 않음(조각으로 복구 등) */
  finished?: boolean;
  /** incomplete(기본) = 원본 미업로드 / uploaded_pending_review = 업로드·/finish 성공, 사용자 승인 대기(삭제 전) */
  state?: 'incomplete' | 'uploaded_pending_review';
  /** 업로드된 서버 회의 id(복구 시 새 회의로 올렸으면 id 와 다름) */
  serverId?: number;
  uploadedAt?: number;
  /** 녹음 화면이 기록한 실제 녹음 시간(ms, 일시정지·끊김 구간 제외 추정) — 길이 비교의 폴백 */
  recordedMs?: number;
}

export const isPendingReview = (m: LocalMeta) => m.state === 'uploaded_pending_review';
/** 이 서버 회의에 해당하는 로컬 백업인가 */
export const matchesMeeting = (m: LocalMeta, meetingId: number) => (m.serverId ?? m.id) === meetingId;

export interface LocalSummary extends LocalMeta {
  fullBytes: number;
  fullParts: number;
  gens: number;      // 녹음기 세대 수(마이크 재연결마다 +1)
  slices: number;    // 미전송 전사 조각 수
}

interface FullRow { mid: number; gen: number; seq: number; type: string; buf: ArrayBuffer }
interface SliceRow { mid: number; seq: number; offset: number; type: string; buf: ArrayBuffer }

// 상태(화면 표시용)
interface LocalRecState {
  pending: number;          // 전송 대기 중인 전사 조각 수
  storageError: string;     // 로컬 저장 실패(용량 부족 등) 안내 — 녹음 자체는 계속된다
  available: boolean;       // IDB 사용 가능 여부
  version: number;          // 목록이 바뀔 때마다 +1 (RecoveryBanner 재조회 트리거)
  sendFailures: number;     // 전사 조각 전송 연속 실패 횟수(성공 시 0)
  lastSendError: string;
}
export const useLocalRec = create<LocalRecState>(() => ({
  pending: 0, storageError: '', available: true, version: 0, sendFailures: 0, lastSendError: '',
}));
const bump = () => useLocalRec.setState((s) => ({ version: s.version + 1 }));

// ── 현재 녹음 중인 회의(배너·알림 클릭 이동에서 제외/보호) ─────────────────────
let activeId: number | null = null;
export const localRec = {
  get activeId() { return activeId; },
  setActive(id: number | null) { activeId = id; bump(); },
};

// ── IDB 기본 ────────────────────────────────────────────────────────────────
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const fullKey = (mid: number, gen: number, seq: number) => `${mid}:${pad(gen, 4)}:${pad(seq, 8)}`;
const sliceKey = (mid: number, seq: number) => `${mid}:${pad(seq, 8)}`;
const range = (mid: number) => IDBKeyRange.bound(`${mid}:`, `${mid}:￿`);

let dbp: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB_NAME, DB_VER); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FULL)) db.createObjectStore(FULL);
      if (!db.objectStoreNames.contains(SLICES)) db.createObjectStore(SLICES);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { dbp = null; };            // 사파리가 백그라운드에서 연결을 끊는 경우
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  }).then((db) => {
    if (!db) { dbp = null; useLocalRec.setState({ available: false }); }
    return db;
  });
  return dbp;
}

/** 저장 공간 회수(eviction) 대상에서 빼 달라고 요청 — 지원 브라우저만, 실패 무시. */
export function requestPersist(): void {
  try { void navigator.storage?.persist?.().catch(() => {}); } catch { /* 미지원 */ }
}

type Mode = IDBTransactionMode;
async function tx<T>(stores: string[], mode: Mode, fn: (t: IDBTransaction) => T | Promise<T>, retry = true): Promise<T> {
  const db = await openDb();
  if (!db) throw new Error('로컬 저장소(IndexedDB)를 쓸 수 없습니다');
  try {
    return await new Promise<T>((resolve, reject) => {
      let t: IDBTransaction;
      try { t = db.transaction(stores, mode); } catch (e) { return reject(e); }
      let out: T;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('IndexedDB 트랜잭션 중단'));
      Promise.resolve(fn(t)).then((v) => { out = v; }, (e) => { try { t.abort(); } catch { /* 이미 끝남 */ } reject(e); });
    });
  } catch (e) {
    // 연결 유실(InvalidStateError/UnknownError) → 새 연결로 1회 재시도. 용량 부족은 재시도해도 같으므로 그대로 던진다.
    const name = (e as DOMException | null)?.name;
    if (retry && (name === 'InvalidStateError' || name === 'UnknownError')) {
      try { db.close(); } catch { /* 무시 */ }
      dbp = null;
      return tx(stores, mode, fn, false);
    }
    throw e;
  }
}

const reqP = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function toBuf(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as ArrayBuffer);
    fr.onerror = () => rej(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}

function storageFail(e: unknown): void {
  const name = (e as DOMException | null)?.name;
  const msg = name === 'QuotaExceededError'
    ? '기기 저장 공간이 부족해 로컬 백업이 중단되었습니다. 녹음은 계속되지만 앱이 닫히면 유실될 수 있습니다.'
    : `로컬 백업 실패: ${e instanceof Error ? e.message : String(e)}`;
  if (useLocalRec.getState().storageError !== msg) useLocalRec.setState({ storageError: msg });
}

// ── 쓰기 ────────────────────────────────────────────────────────────────────

/** 녹음 시작 시 메타 생성. 실패해도 녹음은 진행(경고만). */
export async function beginLocal(id: number, title: string): Promise<void> {
  useLocalRec.setState({ storageError: '' });
  requestPersist();
  try {
    const now = Date.now();
    await tx([META], 'readwrite', (t) => { t.objectStore(META).put({ id, title, createdAt: now, updatedAt: now } satisfies LocalMeta); });
    bump();
  } catch (e) { storageFail(e); }
}

async function patchMeta(id: number, p: Partial<LocalMeta>): Promise<void> {
  await tx([META], 'readwrite', async (t) => {
    const s = t.objectStore(META);
    const cur = await reqP(s.get(id) as IDBRequest<LocalMeta | undefined>);
    if (cur) s.put({ ...cur, ...p, updatedAt: Date.now() });
  });
}

export function setLocalTitle(id: number, title: string): void {
  patchMeta(id, { title }).catch(() => {});
}

export function setRecordedMs(id: number, recordedMs: number): void {
  patchMeta(id, { recordedMs }).catch(() => {});
}

/** 원본 업로드 + /finish 성공 → 삭제하지 않고 '검토 대기'로. 실제 삭제는 사용자 승인(purgeLocal)으로만. */
export async function markUploadedLocal(id: number, serverId: number): Promise<void> {
  try { await patchMeta(id, { state: 'uploaded_pending_review', serverId, uploadedAt: Date.now(), finished: false }); } catch { /* 무시 */ }
  bump();
}

/** 전체 녹음 조각 append. 실패는 storageError 로만 알린다(녹음 중단 없음). */
export async function appendFull(mid: number, gen: number, seq: number, blob: Blob): Promise<void> {
  try {
    const buf = await toBuf(blob);
    await tx([FULL], 'readwrite', (t) => {
      t.objectStore(FULL).put({ mid, gen, seq, type: blob.type, buf } satisfies FullRow, fullKey(mid, gen, seq));
    });
  } catch (e) { storageFail(e); }
}

async function putSlice(row: Omit<SliceRow, 'buf'>, blob: Blob): Promise<void> {
  try {
    const buf = await toBuf(blob);
    await tx([SLICES], 'readwrite', (t) => { t.objectStore(SLICES).put({ ...row, buf } satisfies SliceRow, sliceKey(row.mid, row.seq)); });
  } catch (e) { storageFail(e); }
}

function delSlice(mid: number, seq: number): void {
  tx([SLICES], 'readwrite', (t) => { t.objectStore(SLICES).delete(sliceKey(mid, seq)); }).catch(() => {});
}

/** 이 회의의 로컬 데이터 전부 삭제 — 사용자의 명시적 승인/삭제 동작에서만 호출한다(자동 호출 금지). */
export async function purgeLocal(id: number): Promise<void> {
  try {
    await tx([META, FULL, SLICES], 'readwrite', (t) => {
      t.objectStore(META).delete(id);
      t.objectStore(FULL).delete(range(id));
      t.objectStore(SLICES).delete(range(id));
    });
  } catch { /* 다음 실행 때 배너에서 다시 정리 가능 */ }
  bump();
}

/** /finish 는 됐지만 원본은 미업로드(조각으로 복구) — 원본은 남겨 두고 표시만 바꾼다.
 *  원본·미전송 조각이 하나도 없으면 지울 오디오가 없으므로 빈 메타만 정리한다. */
export async function markFinishedLocal(id: number): Promise<void> {
  try {
    const [n, sl] = await tx([FULL, SLICES], 'readonly', async (t) => [
      await reqP(t.objectStore(FULL).count(range(id))),
      await reqP(t.objectStore(SLICES).count(range(id))),
    ]);
    if (n === 0 && sl === 0) return purgeLocal(id);
    await patchMeta(id, { finished: true });
  } catch { /* 무시 */ }
  bump();
}

// ── 읽기(복구) ──────────────────────────────────────────────────────────────

export async function listLocal(): Promise<LocalSummary[]> {
  const db = await openDb();
  if (!db) return [];
  return tx([META, FULL, SLICES], 'readonly', async (t) => {
    const metas = await reqP(t.objectStore(META).getAll() as IDBRequest<LocalMeta[]>);
    const out: LocalSummary[] = [];
    for (const m of metas) {
      const rows = await reqP(t.objectStore(FULL).getAll(range(m.id)) as IDBRequest<FullRow[]>);
      const slices = await reqP(t.objectStore(SLICES).count(range(m.id)));
      out.push({
        ...m,
        fullBytes: rows.reduce((s, r) => s + r.buf.byteLength, 0),
        fullParts: rows.length,
        gens: new Set(rows.map((r) => r.gen)).size,
        slices,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  });
}

/** 저장된 전체 녹음을 녹음기 세대별 Blob 으로(세대 = 독립된 파일 1개, 순서대로 이어 붙여 업로드). */
export async function loadFull(id: number): Promise<Blob[]> {
  const rows = await tx([FULL], 'readonly', (t) => reqP(t.objectStore(FULL).getAll(range(id)) as IDBRequest<FullRow[]>));
  const gens = new Map<number, FullRow[]>();
  for (const r of rows) (gens.get(r.gen) ?? gens.set(r.gen, []).get(r.gen)!).push(r);
  return [...gens.keys()].sort((a, b) => a - b).map((g) => {
    const parts = gens.get(g)!.sort((a, b) => a.seq - b.seq);
    return new Blob(parts.map((p) => p.buf), { type: parts[0].type || 'audio/webm' });
  }).filter((b) => b.size > 0);
}

// ── 전사 조각 전송 큐 ───────────────────────────────────────────────────────
// 순차 전송. 실패하면 IDB 에 남긴 채 지수 백오프로 재시도(온라인 복귀·화면 복귀 시 즉시). 404(회의 없음)는 포기.
// 서버 /chunk 는 seq 기준 멱등이라 응답 유실 후 재전송해도 중복 전사되지 않는다.

interface QItem { mid: number; seq: number; offset: number; blob: Blob }
const queue: QItem[] = [];
const qkeys = new Set<string>();
let running = false;
let failures = 0;
let wake: (() => void) | null = null;
const drainWaiters: (() => void)[] = [];

const setPending = () => useLocalRec.setState({ pending: queue.length });

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const h = setTimeout(() => { wake = null; res(); }, ms);
    wake = () => { clearTimeout(h); wake = null; res(); };
  });
}

/** 지금 바로 재시도(온라인 복귀·화면 복귀). */
export function kickQueue(): void {
  if (wake) wake();
  else void run();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', kickQueue);
}

function push(item: QItem): void {
  const k = sliceKey(item.mid, item.seq);
  if (qkeys.has(k)) return;
  qkeys.add(k);
  queue.push(item);
  setPending();
  void run();
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const it = queue[0];
      try {
        await api.sendChunk(it.mid, it.seq, it.offset, it.blob);
        done(it);
        if (failures) diag(it.mid, 'chunk_send_recovered', { seq: it.seq, after: failures });
        failures = 0;
        useLocalRec.setState({ sendFailures: 0, lastSendError: '' });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        diag(it.mid, 'chunk_send_fail', { seq: it.seq, size: it.blob.size, err: msg, status: e instanceof HttpError ? e.status : null });
        if (e instanceof HttpError && (e.status === 404 || e.status === 401)) {
          // 회의가 사라졌거나 로그인 만료 — 재시도해도 안 된다(401 이면 로그인 화면으로 전환됨). 로컬 사본은 남긴다.
          for (const q of queue.filter((q) => q.mid === it.mid)) drop(q);
          continue;
        }
        failures++;
        useLocalRec.setState({ sendFailures: failures, lastSendError: msg });
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
      }
    }
  } finally {
    running = false;
    while (drainWaiters.length) drainWaiters.shift()!();
  }
}

function drop(it: QItem): void {
  const i = queue.indexOf(it);
  if (i >= 0) queue.splice(i, 1);
  qkeys.delete(sliceKey(it.mid, it.seq));
  setPending();
}

function done(it: QItem): void {
  drop(it);
  delSlice(it.mid, it.seq);
}

/** VAD 슬라이스 1개: IDB 에 먼저 쓰고 전송 큐에 넣는다. */
export function enqueueSlice(mid: number, seq: number, offset: number, blob: Blob): void {
  void putSlice({ mid, seq, offset, type: blob.type }, blob);
  push({ mid, seq, offset, blob });
}

/** IDB 에 남아 있는 미전송 슬라이스를 큐에 다시 싣고, 이 회의분이 다 나가거나 timeoutMs 가 지나면 반환. */
export async function flushSlices(mid: number, timeoutMs = 20_000): Promise<void> {
  try {
    const rows = await tx([SLICES], 'readonly', (t) => reqP(t.objectStore(SLICES).getAll(range(mid)) as IDBRequest<SliceRow[]>));
    for (const r of rows.sort((a, b) => a.seq - b.seq)) push({ mid, seq: r.seq, offset: r.offset, blob: new Blob([r.buf], { type: r.type || 'audio/webm' }) });
  } catch { /* IDB 불가 — 메모리 큐만 */ }
  const deadline = Date.now() + timeoutMs;
  while (queue.some((q) => q.mid === mid) && Date.now() < deadline) {
    kickQueue();
    await Promise.race([
      new Promise<void>((r) => drainWaiters.push(r)),
      new Promise<void>((r) => setTimeout(r, 1000)),
    ]);
  }
}

const fileName = (id: number, b: Blob, i: number, n: number) =>
  `drec-${id}${n > 1 ? `-${i + 1}` : ''}.${b.type.includes('mp4') ? 'm4a' : 'webm'}`;

/** 다운로드 링크로 저장(데스크톱·안드로이드). */
export function downloadBlobs(id: number, blobs: Blob[]): void {
  blobs.forEach((b, i) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = fileName(id, b, i, blobs.length);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  });
}

/** 파일로 저장: 공유 시트(iOS/iPadOS → "파일에 저장")가 되면 그걸, 아니면 다운로드.
 *  공유는 사용자 제스처 안에서만 열리므로 Blob 을 미리 읽어 둔 뒤 호출해야 한다.
 *  반환: 'shared' | 'downloaded' | 'cancelled' | 'gesture'(제스처 만료 — 한 번 더 탭 필요) */
export async function saveBlobs(id: number, blobs: Blob[]): Promise<'shared' | 'downloaded' | 'cancelled' | 'gesture'> {
  const files = blobs.map((b, i) => new File([b], fileName(id, b, i, blobs.length), { type: b.type || 'audio/webm' }));
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  const mobile = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (mobile && typeof nav.share === 'function' && nav.canShare?.({ files })) {
    try {
      await nav.share({ files, title: `dRec 녹음 #${id}` });
      return 'shared';
    } catch (e) {
      const name = (e as DOMException | null)?.name;
      if (name === 'AbortError') return 'cancelled';
      if (name === 'NotAllowedError') return 'gesture';
      // 그 외 실패 → 다운로드로 폴백
    }
  }
  downloadBlobs(id, blobs);
  return 'downloaded';
}

/** 오디오 길이(초). MediaRecorder 산출물은 duration 이 Infinity 인 경우가 많아 끝으로 시크해 구한다. 실패 시 null. */
export function probeDuration(blob: Blob, timeoutMs = 8000): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    let done = false;
    const end = (v: number | null) => {
      if (done) return;
      done = true;
      a.removeAttribute('src');
      try { a.load(); } catch { /* 무시 */ }
      URL.revokeObjectURL(url);
      resolve(v != null && Number.isFinite(v) && v > 0 ? v : null);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (Number.isFinite(a.duration)) return end(a.duration);
      a.ontimeupdate = () => { if (Number.isFinite(a.duration)) end(a.duration); };
      a.currentTime = 1e7; // 끝으로 시크 → 브라우저가 실제 길이를 계산
    };
    a.ondurationchange = () => { if (Number.isFinite(a.duration) && a.duration > 0 && a.currentTime > 0) end(a.duration); };
    a.onerror = () => end(null);
    setTimeout(() => end(null), timeoutMs);
    a.src = url;
  });
}

// ── 저장 공간 ───────────────────────────────────────────────────────────────

export interface StorageEstimateInfo { usage: number; quota: number; low: boolean }
const LOW_FREE_BYTES = 500 * 1024 * 1024;

/** navigator.storage.estimate() — 미지원이면 null. 여유 500MB 미만 또는 85% 이상 사용이면 low. */
export async function estimateStorage(): Promise<StorageEstimateInfo | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e || !e.quota) return null;
    const usage = e.usage ?? 0;
    const quota = e.quota;
    return { usage, quota, low: quota - usage < LOW_FREE_BYTES || usage / quota > 0.85 };
  } catch { return null; }
}
