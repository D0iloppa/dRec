// 로그인 화면. 계정은 서버 관리자가 CLI 로만 생성한다(회원가입 없음).
import { useState } from 'react';
import { api } from '../api';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.login(username, password); // 성공 시 토큰 저장 + AUTH_EVENT → 앱 렌더
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg === 'invalid credentials' ? '아이디 또는 비밀번호가 올바르지 않습니다' : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-box" onSubmit={submit}>
        <h1>dRec</h1>
        <input
          className="login-input"
          placeholder="아이디"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="login-input"
          type="password"
          placeholder="비밀번호"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="login-btn" type="submit" disabled={busy || !username || !password}>
          {busy ? '로그인 중…' : '로그인'}
        </button>
        {error && <div className="login-err">{error}</div>}
      </form>
    </div>
  );
}
