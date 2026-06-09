import { useState, type FormEvent } from 'react';
import * as api from '../api';

const PROVIDERS = [
  { id: 'google', label: 'Google', cls: 'oauth-google', icon: 'G' },
  { id: 'kakao', label: '카카오', cls: 'oauth-kakao', icon: 'K' },
  { id: 'naver', label: '네이버', cls: 'oauth-naver', icon: 'N' },
];

function OAuthButtons() {
  return (
    <div className="oauth-row">
      <div className="oauth-divider"><span>소셜 계정으로 시작</span></div>
      {PROVIDERS.map((p) => (
        <a key={p.id} className={`oauth-btn ${p.cls}`} href={`/auth/oauth/${p.id}/start`}>
          <span className="oauth-ico">{p.icon}</span>
          {p.label}로 계속하기
        </a>
      ))}
    </div>
  );
}

export default function Auth({ onAuth }: { onAuth: (token: string) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [nickname, setNickname] = useState('');
  const [err, setErr] = useState('');

  const reset = () => { setErr(''); setPassword(''); setPassword2(''); };
  const go = (m: 'login' | 'signup') => { setMode(m); reset(); };

  const doLogin = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const r = await api.login(username, password);
      onAuth(r.token);
    } catch (ex) { setErr((ex as Error).message); }
  };

  const doSignup = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (password.length < 4) return setErr('비밀번호는 4자 이상이어야 합니다.');
    if (password !== password2) return setErr('비밀번호가 일치하지 않습니다.');
    if (nickname && nickname.length > 20) return setErr('닉네임은 20자 이하여야 합니다.');
    try {
      const r = await api.signup(username, password, nickname || undefined);
      onAuth(r.token);
    } catch (ex) { setErr((ex as Error).message); }
  };

  return (
    <main className="auth-screen">
      <div className="clouds">
        <span className="cloud c1" /><span className="cloud c2" /><span className="cloud c3" /><span className="cloud c4" />
      </div>

      <div className="auth-inner">
        <div className="logo3d">DOPL</div>
        <div className="logo-sub">doil&nbsp;playground</div>

        {err && <div className="auth-error">{err}</div>}

        {mode === 'login' ? (
          <>
            <form className="login-panel" onSubmit={doLogin}>
              <div className="panel-fields">
                <label className="field"><span className="field-ico">🆔</span>
                  <input placeholder="아이디" value={username} onChange={(e) => setUsername(e.target.value)} />
                </label>
                <label className="field"><span className="field-ico">🔒</span>
                  <input type="password" placeholder="비밀번호" value={password} onChange={(e) => setPassword(e.target.value)} />
                </label>
              </div>
              <button className="go-btn" type="submit" aria-label="로그인">▶</button>
            </form>
            <OAuthButtons />
            <div className="auth-links">
              계정이 없으신가요? <span onClick={() => go('signup')}>회원가입</span>
            </div>
          </>
        ) : (
          <>
            <form className="signup-card" onSubmit={doSignup}>
              <h2>🎮 회원가입</h2>
              <label className="field"><span className="field-ico">🆔</span>
                <input placeholder="아이디" value={username} onChange={(e) => setUsername(e.target.value)} />
              </label>
              <label className="field"><span className="field-ico">🔒</span>
                <input type="password" placeholder="비밀번호 (4자 이상)" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <label className="field"><span className="field-ico">✅</span>
                <input type="password" placeholder="비밀번호 확인" value={password2} onChange={(e) => setPassword2(e.target.value)} />
              </label>
              <label className="field"><span className="field-ico">🙂</span>
                <input placeholder="닉네임 (게임 표시명, 선택)" value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} />
              </label>
              <button className="signup-btn" type="submit">가입하기</button>
            </form>
            <OAuthButtons />
            <div className="auth-links">
              이미 계정이 있으신가요? <span onClick={() => go('login')}>로그인</span>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
