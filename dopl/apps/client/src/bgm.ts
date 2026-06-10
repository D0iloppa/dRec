// 배경음악 매니저 — 트랙 메타는 DB(bgm_track)를 /meta/bgm으로 로드해 key로 연결 (하드코딩 금지).
//   key 예: main(로그인) / lobby / shop / dress / quiz / mafiaDay / mafiaNight / bang(예정)
// 씬은 bgm.play('<key>')만 호출하면 되고, 메타 로드 전에 호출되면 로드 완료 시 자동 재생된다.
// 쥬크박스: bgm.playList(keys)로 선택 곡 순차 재생(반복).
// 브라우저 자동재생 정책: 차단되면 첫 사용자 제스처(클릭/키)에 재생을 재시도한다.
// on/off 설정은 localStorage('dopl-bgm')에 보존.
export interface BgmMeta {
  key: string;
  title: string;
  desc: string;
  file: string;
}

const audio = new Audio();
audio.loop = true;
audio.volume = 0.35;
audio.preload = 'auto';

let META: BgmMeta[] = [];
let currentKey: string | null = null;
let queue: string[] = [];
let qi = 0;
let enabled = localStorage.getItem('dopl-bgm') !== 'off';
let wantPlaying = false;

function fileOf(key: string): string | null {
  return META.find((t) => t.key === key)?.file ?? null;
}

function setSrcFor(key: string): boolean {
  const f = fileOf(key);
  if (!f) return false; // 메타 미로드/없는 키 — 로드 후 재시도
  const src = '/bgm/' + f;
  if (!audio.src.endsWith(src)) audio.src = src;
  return true;
}

function tryPlay() {
  if (!enabled || !wantPlaying || !audio.src) return;
  void audio.play().catch(() => {
    /* 자동재생 차단 — 아래 제스처 리스너가 재시도 */
  });
}

// 부팅 시 1회 호출 (App). 로드 전 요청된 트랙(pending)은 로드 직후 연결.
export async function loadBgmMeta(): Promise<void> {
  try {
    const res = await fetch('/meta/bgm');
    const data = await res.json();
    META = data.tracks ?? [];
    if (currentKey && wantPlaying && setSrcFor(currentKey)) tryPlay();
  } catch {
    /* 메타 로드 실패 시 무음 — 다음 새로고침에서 재시도 */
  }
}

// 플레이리스트 순차 재생 (loop=false일 때 곡 끝나면 다음 곡, 끝나면 처음부터)
audio.addEventListener('ended', () => {
  if (!queue.length) return;
  qi = (qi + 1) % queue.length;
  currentKey = queue[qi]!;
  if (setSrcFor(currentKey)) tryPlay();
});

window.addEventListener('pointerdown', tryPlay);
window.addEventListener('keydown', tryPlay);

// QA/디버그용 핸들 (재생 상태 점검)
(window as unknown as Record<string, unknown>).__doplBgm = audio;

export const bgm = {
  // 단일 트랙 루프 재생 (씬 자동 BGM·쥬크박스 단곡)
  play(key: string): void {
    queue = [];
    audio.loop = true;
    currentKey = key;
    wantPlaying = true;
    if (setSrcFor(key)) tryPlay();
  },
  // 선택 곡들 순차 재생 (쥬크박스)
  playList(keys: string[]): void {
    if (!keys.length) return;
    queue = [...keys];
    qi = 0;
    audio.loop = false;
    currentKey = keys[0]!;
    wantPlaying = true;
    if (setSrcFor(currentKey)) tryPlay();
  },
  stop(): void {
    wantPlaying = false;
    queue = [];
    audio.pause();
  },
  list(): BgmMeta[] {
    return META;
  },
  current(): string | null {
    return currentKey;
  },
  enabled(): boolean {
    return enabled;
  },
  toggle(): boolean {
    enabled = !enabled;
    localStorage.setItem('dopl-bgm', enabled ? 'on' : 'off');
    if (enabled) tryPlay();
    else audio.pause();
    return enabled;
  },
};
