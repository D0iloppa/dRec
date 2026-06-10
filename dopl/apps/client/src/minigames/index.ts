// 미니게임 레지스트리 — 혼자 플레이 + 결과 SNS 공유 트랙.
// 새 미니게임 추가 = 게임 모듈 작성 + 이 배열에 한 줄. (단일 진입점 X, 로비에서 선택)
import { wordleGame } from './wordle';

export interface MinigameCtx {
  token: string;
  refreshProfile: () => void;
}

export interface Minigame {
  id: string;
  icon: string;
  name: string;
  desc: string;
  mount: (host: HTMLElement, ctx: MinigameCtx) => void;
}

export const MINIGAMES: Minigame[] = [wordleGame as Minigame];
