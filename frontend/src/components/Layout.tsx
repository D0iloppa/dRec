import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import Sidebar from './Sidebar';
import RecoveryBanner from './RecoveryBanner';
import { useMeetings } from '../store';
import { localRec } from '../localRec';

export default function Layout() {
  const toggleSidebar = useMeetings((s) => s.toggleSidebar);
  const sidebarOpen = useMeetings((s) => s.sidebarOpen);
  const setSidebar = useMeetings((s) => s.setSidebar);
  const navigate = useNavigate();

  // 알림 클릭 → 서비스워커가 페이지 이동을 요청한다. 녹음 중이면 이동하지 않는다(녹음 화면이 사라지면 녹음이 끊긴다).
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type !== 'drec:navigate' || !d.url) return;
      if (localRec.activeId !== null) {
        if (d.url !== '/') toast('녹음 중이라 이동하지 않았습니다. 녹음을 마친 뒤 확인하세요.');
        return;
      }
      navigate(d.url);
    };
    sw.addEventListener('message', onMsg);
    sw.startMessages?.();
    return () => sw.removeEventListener('message', onMsg);
  }, [navigate]);

  return (
    <div className="layout">
      <Sidebar />
      {sidebarOpen && <button className="backdrop" aria-label="닫기" onClick={() => setSidebar(false)} />}
      <div className="main">
        <div className="topbar">
          <button className="icon-btn" onClick={toggleSidebar} aria-label="메뉴">
            <Menu size={20} />
          </button>
        </div>
        <div className="content">
          <RecoveryBanner />
          <Outlet />
        </div>
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}
