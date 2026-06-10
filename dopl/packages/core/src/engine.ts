// 게임 엔진 베이스 + 게임 패키지 계약.
import type { GameAction, GameMeta, PlayerView } from '@dopl/protocol';
import type { Room } from './Room.js';

export type { GameMeta };

// 게임 종료 시 플랫폼이 적용할 결과(엔진이 계산, server가 DB 반영).
export interface GameResult {
  userId: number | null;
  iqDelta: number;
  coinsDelta: number;
  won: boolean;
}

// 게임 엔진 베이스. 서버 권위로 상태 보유/판정. Phaser를 모르고 protocol 타입으로만 입출력.
export abstract class GameEngine {
  abstract start(requesterId: string): void | Promise<void>;
  abstract onAction(playerId: string, action: GameAction): void | Promise<void>;

  // 채팅을 게임 입력으로 가로채는 훅(스피드퀴즈 등). 구현 시 채팅 기록까지 엔진이 담당한다.
  // 미구현(undefined)이면 서버가 일반 채팅으로 처리.
  onChat?(playerId: string, text: string): void;

  playerView(_player: PlayerView, _viewerId: string): Record<string, unknown> {
    return {};
  }
  viewFor(_viewerId: string): unknown {
    return {};
  }
  // phase가 'ended'가 된 뒤 server가 호출. 적립할 결과 목록. 기본 빈 배열.
  results(): GameResult[] {
    return [];
  }
}

// 각 게임 패키지가 export하는 표준 형태
export interface GamePackage {
  meta: GameMeta;
  createEngine: (room: Room) => GameEngine;
}
