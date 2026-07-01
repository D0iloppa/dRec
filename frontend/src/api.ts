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
}

// SSE 이벤트 타입
export type SseEvent =
  | { type: 'segment'; start: number; end: number; text: string; seq?: number }
  | { type: 'diarize'; segments: Segment[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

const TOKEN_KEY = 'drec_token';
let tokenInFlight: Promise<string> | null = null;

async function getToken(): Promise<string> {
  const existing = localStorage.getItem(TOKEN_KEY);
  if (existing) return existing;
  if (!tokenInFlight) {
    tokenInFlight = fetch('/api/auth/guest', { method: 'POST' })
      .then((r) => r.json())
      .then((d: { token: string; user_id: string }) => {
        localStorage.setItem(TOKEN_KEY, d.token);
        localStorage.setItem('drec_uid', d.user_id);
        return d.token;
      })
      .finally(() => { tokenInFlight = null; });
  }
  return tokenInFlight;
}

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const withAuth = (token: string): RequestInit => ({
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
  let res = await fetch(url, withAuth(await getToken()));
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    res = await fetch(url, withAuth(await getToken()));
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

  createSession: () => authedFetch('/api/sessions', { method: 'POST' }).then(json<{ id: number; canvas_id: string }>),
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
  audioUrl: (id: number) => `/api/meetings/${id}/audio?t=${localStorage.getItem(TOKEN_KEY) ?? ''}`,
};
