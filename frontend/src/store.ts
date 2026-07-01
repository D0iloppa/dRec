// 사이드바 회의 목록 상태(zustand). 녹음 완료·이름변경·삭제 후 refresh 로 갱신.
import { create } from 'zustand';
import { api, MeetingSummary } from './api';

interface MeetingsState {
  items: MeetingSummary[];
  query: string;
  sidebarOpen: boolean;
  setQuery: (q: string) => void;
  toggleSidebar: () => void;
  setSidebar: (open: boolean) => void;
  closeOnMobile: () => void;
  refresh: () => Promise<void>;
}

export const useMeetings = create<MeetingsState>((set, get) => ({
  items: [],
  query: '',
  sidebarOpen: false,
  setQuery: (q) => {
    set({ query: q });
    get().refresh();
  },
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebar: (open) => set({ sidebarOpen: open }),
  closeOnMobile: () => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) set({ sidebarOpen: false });
  },
  refresh: async () => {
    const items = await api.listMeetings(get().query).catch(() => []);
    set({ items });
  },
}));
