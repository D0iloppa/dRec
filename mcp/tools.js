'use strict';

// dRec 회의 녹취/정리 파이프라인을 dobis 에 노출하는 MCP 도구.
// 각 도구는 { name, description, inputSchema, handler } — handler 반환값(문자열)이 도구 결과.

const { api, fileForm } = require('./client.js');
const { startJob, getJob } = require('./jobs.js');

const dump = (v) => JSON.stringify(v, null, 2);

const tools = [
  // ── 조회 ───────────────────────────────────────────────────────────
  {
    name: 'list_meetings',
    description: '회의 목록(최신순 50건). q 로 제목·회의록·전사 내용 검색.',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: '검색어(선택)' } },
    },
    handler: async ({ q = '' } = {}) =>
      dump(await api('/api/meetings', { query: q && q.trim() ? { q } : undefined })),
  },
  {
    name: 'get_meeting',
    description: '회의 상세 — 전사(transcript), 화자분리 구간(segments), 화자 메타(speaker_meta), 회의록(minutes).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: '회의 id' } },
      required: ['id'],
    },
    handler: async ({ id }) => dump(await api(`/api/meetings/${id}`)),
  },

  // ── 녹취 → 회의록(원샷) ─────────────────────────────────────────────
  {
    name: 'process_audio',
    description:
      '오디오 파일 경로를 업로드 → 전사(STT)+화자분리+회의록 생성. 수 분 소요라 **비동기**: 즉시 job_id 반환하고 백그라운드 처리. 결과는 job_status(job_id) 로 폴링(status=done 이면 result 에 id/transcript/minutes).',
    inputSchema: {
      type: 'object',
      properties: { file_path: { type: 'string', description: '호스트의 오디오 파일 절대경로' } },
      required: ['file_path'],
    },
    handler: async ({ file_path }) => {
      const form = fileForm(file_path); // 파일 읽기는 동기적으로 먼저(잘못된 경로 즉시 에러)
      const job_id = startJob('process_audio', () => api('/api/process', { method: 'POST', form }));
      return dump({ job_id, status: 'started', note: 'job_status(job_id) 로 결과를 폴링하세요' });
    },
  },
  {
    name: 'job_status',
    description: '비동기 잡(process_audio/finish_session)의 상태 조회. status: running|done|error. done 이면 result 에 결과.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'process_audio/finish_session 이 반환한 job_id' } },
      required: ['job_id'],
    },
    handler: async ({ job_id }) => dump(getJob(job_id)),
  },

  // ── 라이브 세션 ─────────────────────────────────────────────────────
  {
    name: 'create_session',
    description: '라이브 녹음 세션 생성 → 회의 id 반환.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: '회의 제목(선택)' } },
    },
    handler: async ({ title = '' } = {}) => {
      const fd = new FormData();
      fd.append('title', title);
      return dump(await api('/api/sessions', { method: 'POST', form: fd }));
    },
  },
  {
    name: 'add_chunk',
    description: '세션에 미리보기 오디오 조각 1개 업로드 → 즉시 전사 텍스트 반환(미리보기 전용, 저장 안 됨).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '회의 id' },
        seq: { type: 'integer', description: '조각 순번' },
        file_path: { type: 'string', description: '오디오 조각 파일 절대경로' },
      },
      required: ['id', 'seq', 'file_path'],
    },
    handler: async ({ id, seq, file_path }) =>
      dump(await api(`/api/sessions/${id}/chunk`, { method: 'POST', form: fileForm(file_path, 'audio', { seq }) })),
  },
  {
    name: 'upload_audio',
    description: '세션 종료 전 연속 단일 녹음 전체를 업로드(재생/화자분리용).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '회의 id' },
        file_path: { type: 'string', description: '전체 녹음 파일 절대경로' },
      },
      required: ['id', 'file_path'],
    },
    handler: async ({ id, file_path }) =>
      dump(await api(`/api/sessions/${id}/audio`, { method: 'POST', form: fileForm(file_path) })),
  },
  {
    name: 'finish_session',
    description: '세션 종료 → 화자분리 전사+회의록 생성+저장. 수 분 소요라 **비동기**: 즉시 job_id 반환. 결과는 job_status(job_id) 로 폴링.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: '회의 id' } },
      required: ['id'],
    },
    handler: async ({ id }) => {
      const job_id = startJob('finish_session', () => api(`/api/sessions/${id}/finish`, { method: 'POST' }));
      return dump({ job_id, status: 'started', note: 'job_status(job_id) 로 결과를 폴링하세요' });
    },
  },

  // ── 관리 ────────────────────────────────────────────────────────────
  {
    name: 'rename_meeting',
    description: '회의 제목 변경.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '회의 id' },
        title: { type: 'string', description: '새 제목' },
      },
      required: ['id', 'title'],
    },
    handler: async ({ id, title }) => dump(await api(`/api/meetings/${id}`, { method: 'PATCH', json: { title } })),
  },
  {
    name: 'set_speakers',
    description: '화자 메타데이터 설정. meta 예: {"화자 A": {"name": "김부장", "color": "#e03e3e"}}',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '회의 id' },
        meta: { type: 'object', description: '화자 라벨 → {name, color} 매핑' },
      },
      required: ['id', 'meta'],
    },
    handler: async ({ id, meta }) =>
      dump(await api(`/api/meetings/${id}/speakers`, { method: 'PATCH', json: { meta } })),
  },
  {
    name: 'delete_meeting',
    description: '회의 삭제(오디오 포함 영구 삭제).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: '회의 id' } },
      required: ['id'],
    },
    handler: async ({ id }) => dump(await api(`/api/meetings/${id}`, { method: 'DELETE' })),
  },
];

module.exports = { tools };
