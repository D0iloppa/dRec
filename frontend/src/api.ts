// dRec 백엔드 API 래퍼. 모든 경로는 동일 오리진의 /api/* (게이트웨이가 drec 로 프록시).

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
  segments: Segment[];
  speaker_meta: Record<string, SpeakerInfo>;
  minutes: string;
  has_audio: boolean;
}

// ── 인증: 최초 진입 시 게스트(uuid) 자동 발급 → 이후 모든 요청에 Bearer 부착 ──
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
    localStorage.removeItem(TOKEN_KEY); // 토큰 만료/무효 → 재발급 후 1회 재시도
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

  createSession: () => authedFetch('/api/sessions', { method: 'POST' }).then(json<{ id: number }>),
  sendChunk: (id: number, seq: number, blob: Blob) => {
    const fd = new FormData();
    fd.append('seq', String(seq));
    fd.append('audio', blob, `chunk-${seq}.webm`);
    return authedFetch(`/api/sessions/${id}/chunk`, { method: 'POST', body: fd }).then(
      json<{ seq: number; text: string }>,
    );
  },
  uploadSessionAudio: (id: number, blob: Blob) => {
    const fd = new FormData();
    fd.append('audio', blob, 'full.webm');
    return authedFetch(`/api/sessions/${id}/audio`, { method: 'POST', body: fd }).then(json<{ ok: boolean }>);
  },
  finishSession: (id: number) =>
    authedFetch(`/api/sessions/${id}/finish`, { method: 'POST' }).then(
      json<{ id: number; transcript: string; minutes: string }>,
    ),

  // <audio> 태그는 헤더를 못 실으므로 토큰을 쿼리로 전달.
  audioUrl: (id: number) => `/api/meetings/${id}/audio?t=${localStorage.getItem(TOKEN_KEY) ?? ''}`,
};
