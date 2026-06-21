'use strict';

// dRec REST API 클라이언트 — dobis 가 호스트에서 spawn 하는 stdio MCP 가 게이트웨이 너머
// drec.doil.me 백엔드를 호출한다. dRec 의 모든 /api/* 는 게스트(uuid)+JWT(만료 없음) 인증이라,
// dobis 전용 고정 신원을 1회 발급해 토큰 파일에 보관하고 재사용한다(회의 이력 유지).

const fs = require('fs');
const path = require('path');

const API_URL = (process.env.DREC_API_URL || 'https://drec.doil.me').replace(/\/+$/, '');
const TOKEN_FILE = process.env.DREC_TOKEN_FILE || path.join(__dirname, '.drec_token.json');

let _token = process.env.DREC_TOKEN || null;

function loadToken() {
  if (_token) return _token;
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (data && data.token) _token = data.token;
  } catch (_) { /* 파일 없음 → 아래에서 발급 */ }
  return _token;
}

async function ensureToken() {
  if (loadToken()) return _token;
  const res = await fetch(`${API_URL}/api/auth/guest`, { method: 'POST' });
  if (!res.ok) throw new Error(`auth/guest ${res.status}: ${await res.text()}`);
  const data = await res.json();
  _token = data.token;
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: data.token, user_id: data.user_id }, null, 2));
  } catch (_) { /* 쓰기 실패해도 이번 세션 토큰은 메모리에 있음 */ }
  return _token;
}

// pathname: '/api/...'. json → JSON 바디, form → FormData(자체 content-type), query → 쿼리스트링.
async function api(pathname, { method = 'GET', json, form, query } = {}) {
  const token = await ensureToken();
  let url = `${API_URL}${pathname}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // FormData 가 boundary 포함 content-type 을 직접 설정
  }
  const res = await fetch(url, { method, headers, body });
  if (!res.ok) throw new Error(`dRec ${method} ${pathname} → ${res.status}: ${await res.text()}`);
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// 호스트 파일 경로 → multipart FormData(필드명 field, 추가 폼 필드 extra).
function fileForm(filePath, field = 'audio', extra = {}) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append(field, new Blob([buf]), path.basename(filePath));
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
  return fd;
}

module.exports = { api, fileForm, API_URL };
