// dRec 백엔드 API 래퍼.

export interface MeetingSummary {
  id: number;
  title: string;
  status: string;
  created_at: string;
}

export interface Segment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface SpeakerInfo {
  name?: string;
  color?: string;
}

export interface MeetingDetail extends MeetingSummary {
  transcript: string;
  named_transcript: string;
  segments: Segment[];
  speaker_meta: Record<string, SpeakerInfo>;
  minutes: string;
  has_audio: boolean;
  canvas_id: string;
  // 파이프라인 모니터 필드 (구버전 백엔드에선 undefined → 상태 기반 폴백)
  has_m4a?: boolean;
  audio_duration_sec?: number | null;
  stage?: PipelineStage | null;
  progress?: number | null; // 0..1, 전사 단계에서만
  stage_started_at?: string | null; // ISO UTC
  // 일시정지/취소 (구버전 백엔드·레거시 행에선 undefined)
  checkpoint?: { stage: PipelineStage | null; has_transcript: boolean } | null; // status === 'paused' 일 때
  pending_action?: 'pause' | 'cancel' | null; // 요청됨, 워커가 정리 중
}

// 'cancelled' 는 취소로 uploaded 로 되돌아간 행의 표시용 stage
export type PipelineStage = 'prepare' | 'transcribe' | 'diarize' | 'minutes' | 'done' | 'error' | 'cancelled';

export interface GpuHealth {
  reachable: boolean;
  configured?: boolean;
  loaded: boolean;
  diarize_loaded: boolean;
  warming: boolean;
  idle_sec: number | null;
  idle_unload_sec: number | null;
  caffeine_sec: number;
  warmup_requested_at: number | null;
}

// SSE 이벤트 타입
export type SseEvent =
  | { type: 'segment'; start: number; end: number; text: string; seq?: number }
  | { type: 'diarize'; segments: Segment[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

const TOKEN_KEY = 'drec_token';
const UID_KEY = 'drec_uid';

/** 로그인 상태가 바뀌었음을 앱(App.tsx 게이트)에 알리는 이벤트. */
export const AUTH_EVENT = 'drec:auth';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** 토큰 폐기 + 로그인 화면으로 되돌리기(게이트가 이벤트를 듣는다). */
export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(UID_KEY);
  window.dispatchEvent(new Event(AUTH_EVENT));
}

function requireToken(): string {
  const token = getStoredToken();
  if (!token) {
    logout();
    throw new Error('로그인이 필요합니다');
  }
  return token;
}

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${requireToken()}` },
  });
  if (res.status === 401) {
    logout();
    throw new Error('로그인이 필요합니다');
  }
  return res;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).detail || `요청 실패 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  login: (username: string, password: string) =>
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
      .then(json<{ token: string; user_id: string }>)
      .then((d) => {
        localStorage.setItem(TOKEN_KEY, d.token);
        localStorage.setItem(UID_KEY, d.user_id);
        window.dispatchEvent(new Event(AUTH_EVENT));
        return d;
      }),

  changePassword: (oldPassword: string, newPassword: string) =>
    authedFetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    }).then(json<{ ok: boolean }>),

  listMeetings: (q = '') =>
    authedFetch(`/api/meetings${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(json<MeetingSummary[]>),
  getMeeting: (id: number) => authedFetch(`/api/meetings/${id}`).then(json<MeetingDetail>),
  renameMeeting: (id: number, title: string) =>
    authedFetch(`/api/meetings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then(json<{ id: number; title: string }>),
  deleteMeeting: (id: number) =>
    authedFetch(`/api/meetings/${id}`, { method: 'DELETE' }).then(json<{ ok: boolean }>),
  setSpeakerMeta: (id: number, meta: Record<string, SpeakerInfo>) =>
    authedFetch(`/api/meetings/${id}/speakers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta }),
    }).then(json<{ id: number; speaker_meta: Record<string, SpeakerInfo> }>),

  generateMinutes: (id: number, speakerMeta: Record<string, SpeakerInfo>) =>
    authedFetch(`/api/meetings/${id}/minutes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speaker_meta: speakerMeta }),
    }).then(json<{ id: number; status: string }>),

  regenerateMeeting: (id: number) =>
    authedFetch(`/api/meetings/${id}/regenerate`, { method: 'POST' }).then(json<{ id: number; status: string }>),

  pauseMeeting: (id: number) => authedFetch(`/api/meetings/${id}/pause`, { method: 'POST' }).then(json<{ id: number; status: string }>),
  resumeMeeting: (id: number) => authedFetch(`/api/meetings/${id}/resume`, { method: 'POST' }).then(json<{ id: number; status: string }>),
  cancelMeeting: (id: number) => authedFetch(`/api/meetings/${id}/cancel`, { method: 'POST' }).then(json<{ id: number; status: string }>),
  transcribeMeeting: (id: number) => authedFetch(`/api/meetings/${id}/transcribe`, { method: 'POST' }).then(json<{ id: number; status: string }>),

  pushPublicKey: () => authedFetch('/api/push/vapid-public-key').then(json<{ public_key: string }>),
  pushSubscribe: (sub: PushSubscriptionJSON) =>
    authedFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }),
    }).then(json<{ ok: boolean }>),
  pushUnsubscribe: (endpoint: string) =>
    authedFetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }).then(json<{ ok: boolean }>),
  pushTest: () => authedFetch('/api/push/test', { method: 'POST' }).then(json<{ sent: number }>),

  gpuHealth: () => authedFetch('/api/gpu/health').then(json<GpuHealth>),
  gpuWarmup: () => authedFetch('/api/gpu/warmup', { method: 'POST' }).then(json<{ requested: boolean }>),
  gpuCaffeine: (ttlSec = 900) =>
    authedFetch('/api/gpu/caffeine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_sec: ttlSec }),
    }).then(json<{ reachable: boolean; caffeine_sec: number }>),

  /** title 을 주면 그 제목으로, 비우면 서버가 'YYYY-MM-DD n번째 회의' 를 부여한다. */
  createSession: (title?: string) => {
    const fd = new FormData();
    if (title?.trim()) fd.append('title', title.trim());
    return authedFetch('/api/sessions', { method: 'POST', body: fd }).then(json<{ id: number; canvas_id: string; title: string }>);
  },
  sendChunk: (id: number, seq: number, timeOffset: number, blob: Blob) => {
    const fd = new FormData();
    fd.append('seq', String(seq));
    fd.append('time_offset', String(timeOffset));
    fd.append('audio', blob, `chunk-${seq}.webm`);
    return authedFetch(`/api/sessions/${id}/chunk`, { method: 'POST', body: fd }).then(
      json<{ ok: boolean }>,
    );
  },
  finishSession: (id: number) =>
    authedFetch(`/api/sessions/${id}/finish`, { method: 'POST' }).then(
      json<{ id: number; status: string }>,
    ),

  getCanvas: (id: number) =>
    authedFetch(`/api/meetings/${id}/canvas`).then(json<{ canvas_data: string }>),
  putCanvas: (id: number, data: object) =>
    authedFetch(`/api/meetings/${id}/canvas`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(json<{ ok: boolean }>),

  // SSE: EventSource는 헤더 불가 → 토큰을 쿼리로 전달
  eventsUrl: (id: number) => `/api/sessions/${id}/events?t=${localStorage.getItem(TOKEN_KEY) ?? ''}`,
  audioUrl: (id: number, format?: 'm4a' | 'webm') =>
    `/api/meetings/${id}/audio?t=${localStorage.getItem(TOKEN_KEY) ?? ''}${format ? `&format=${format}` : ''}`,

  /** 전체 녹음 업로드(XHR: fetch 는 업로드 진행률을 못 준다). */
  uploadAudio: (id: number, blob: Blob, filename: string, onProgress: (loaded: number, total: number) => void) => {
    const xhr = new XMLHttpRequest();
    const promise = new Promise<void>((resolve, reject) => {
      xhr.open('POST', `/api/sessions/${id}/audio`);
      xhr.setRequestHeader('Authorization', `Bearer ${requireToken()}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        if (xhr.status === 401) { logout(); return reject(new Error('로그인이 필요합니다')); }
        let detail = '';
        try { detail = JSON.parse(xhr.responseText).detail; } catch { /* 본문이 JSON 아님 */ }
        reject(new Error(detail || `업로드 실패 (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('네트워크 오류로 업로드가 중단되었습니다'));
      xhr.ontimeout = () => reject(new Error('업로드 시간이 초과되었습니다'));
      xhr.onabort = () => reject(new Error('업로드가 취소되었습니다'));
      const fd = new FormData();
      fd.append('audio', blob, filename);
      xhr.send(fd);
    });
    return { promise, abort: () => xhr.abort() };
  },
};
