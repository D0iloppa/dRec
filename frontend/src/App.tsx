import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Record from './pages/Record';
import MeetingView from './pages/MeetingView';
import Login from './pages/Login';
import { AUTH_EVENT, getStoredToken } from './api';

export default function App() {
  // 토큰이 없으면 로그인 화면. 로그인/로그아웃(401)은 AUTH_EVENT 로 전달된다.
  const [token, setToken] = useState<string | null>(getStoredToken());
  useEffect(() => {
    const onAuth = () => setToken(getStoredToken());
    window.addEventListener(AUTH_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_EVENT, onAuth);
  }, []);

  if (!token) return <Login />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Record />} />
        <Route path="/m/:id" element={<MeetingView />} />
      </Route>
    </Routes>
  );
}
