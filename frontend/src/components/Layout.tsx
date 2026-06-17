import { Outlet } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { Toaster } from 'sonner';
import Sidebar from './Sidebar';
import { useMeetings } from '../store';

export default function Layout() {
  const toggleSidebar = useMeetings((s) => s.toggleSidebar);
  const sidebarOpen = useMeetings((s) => s.sidebarOpen);
  const setSidebar = useMeetings((s) => s.setSidebar);
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
          <Outlet />
        </div>
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}
