// 클라이언트 ↔ 서버 공유 프로토콜 타입 (단일 출처).
// 서버 엔진과 Phaser 씬은 이 타입으로만 대화한다.

export type GameType = string;

export type Phase = 'lobby' | 'playing' | 'ended' | string;

// 직렬화된 참가자 (게임별 공개 필드는 [key]로 확장)
export interface PlayerView {
  id: string;
  name: string;
  connected: boolean;
  isHost: boolean;
  [key: string]: unknown;
}

// 서버가 각 플레이어에게 push하는 방 상태 (viewer 시점)
export interface RoomState<G = unknown> {
  code: string;
  type: GameType;
  phase: Phase;
  hostId: string | null;
  myId: string;
  timerEndsAt: number | null;
  players: PlayerView[];
  chat: ChatMessage[];
  game: G; // 게임별 viewer 전용 데이터
}

export interface ChatMessage {
  name: string;
  text: string;
  ts: number;
  // 채팅 채널 태그 (마피아 밤 채팅 'mafia', 유령 채팅 'dead' 등). 없으면 전체 공개.
  // 가시성 판정은 엔진의 chatVisible 훅이 담당, 클라는 스타일링에만 사용.
  vis?: string;
}

// 클라이언트 → 서버 게임 행동
export interface GameAction {
  kind: string;
  [key: string]: unknown;
}

// 게임 메타 (로비 노출용)
export interface GameMeta {
  type: GameType;
  label: string;
  minPlayers: number;
  maxPlayers: number;
  category: 'party' | 'board';
}
