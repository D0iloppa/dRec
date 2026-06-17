import { useEffect } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { Plus, Search, Trash2, Pencil, Mic } from 'lucide-react';
import { useMeetings } from '../store';
import { api } from '../api';
import { dialog } from '../ui/dialog';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function Sidebar() {
  const { items, query, sidebarOpen, setQuery, refresh, closeOnMobile } = useMeetings();
  const navigate = useNavigate();
  const params = useParams();
  const activeId = params.id ? Number(params.id) : null;

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function rename(id: number, current: string) {
    const title = await dialog.prompt('회의 제목', current);
    if (title == null || title === current) return;
    await api.renameMeeting(id, title).catch((e) => dialog.error(String(e.message || e)));
    await refresh();
  }

  async function remove(id: number) {
    if (!(await dialog.confirm('이 회의를 삭제할까요?', '되돌릴 수 없습니다.', '삭제'))) return;
    await api.deleteMeeting(id).catch((e) => dialog.error(String(e.message || e)));
    await refresh();
    if (activeId === id) navigate('/');
  }

  return (
    <aside className={`sidebar${sidebarOpen ? '' : ' closed'}`}>
      <div className="sidebar-head">
        <Mic size={18} /> dRec
      </div>

      <button className="new-btn" onClick={() => { navigate('/'); closeOnMobile(); }}>
        <Plus size={16} /> 새 녹음
      </button>

      <div className="sidebar-search" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Search size={14} color="#999" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="검색"
          style={{ border: 'none', outline: 'none', flex: 1, background: 'transparent', fontSize: 13 }}
        />
      </div>

      <nav className="meeting-list">
        {items.length === 0 && <div className="empty">{query ? '검색 결과 없음' : '회의록이 없습니다'}</div>}
        {items.map((m) => (
          <NavLink
            key={m.id}
            to={`/m/${m.id}`}
            className={({ isActive }) => `meeting-item${isActive ? ' active' : ''}`}
            onClick={closeOnMobile}
          >
            <span className="title">{m.title || '제목 없는 회의'}</span>
            <span className="date">{fmtDate(m.created_at)}</span>
            <Pencil
              size={13}
              color="#aaa"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                rename(m.id, m.title);
              }}
            />
            <Trash2
              size={13}
              color="#aaa"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                remove(m.id);
              }}
            />
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
