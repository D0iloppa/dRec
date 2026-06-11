// 원카드 Phaser 씬 — 서버 권위 상태를 렌더.
// 중앙: 버린 더미 top(크게) + 활성 무늬 + 방향 화살표 + 덱(클릭 뽑기).
// 상단 주위: 상대 손패 수(미니 부채). 하단: 내 손패(클릭 가능, 못 내는 카드는 흐리게).
// 7/조커 낼 땐 무늬 선택 4버튼 → 선택 후 해당 카드를 낸다.
import Phaser from 'phaser';
import type { RoomState } from '@dopl/protocol';
import { bgm } from '../../bgm';

type Suit = 'S' | 'H' | 'D' | 'C';
const SUIT_LABEL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_COLOR: Record<Suit, string> = { S: '#1e293b', H: '#dc2626', D: '#dc2626', C: '#1e293b' };
const SUITS: Suit[] = ['S', 'H', 'D', 'C'];

interface HandCard {
  id: string;
  rank: string;
  suit: Suit | null;
  playable: boolean;
}

export class OneCardScene extends Phaser.Scene {
  sendAction!: (a: { kind: string; cardId?: string; chosenSuit?: string }) => void;
  private latest: RoomState | null = null;
  private ready = false;

  private headText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private ui!: Phaser.GameObjects.Container;
  private pendingSuitCard: string | null = null; // 무늬 선택 대기 중인 카드 id

  constructor() {
    super('onecard');
  }

  preload(): void {
    this.load.svg('oc-frame', '/games/onecard/card-frame.svg', { width: 78, height: 108 });
    this.load.svg('oc-back', '/games/onecard/card-back.svg', { width: 78, height: 108 });
    for (const s of SUITS) this.load.svg(`oc-suit-${s}`, `/games/onecard/suit-${s}.svg`, { width: 40, height: 40 });
  }

  create(): void {
    const W = this.scale.width;
    this.headText = this.add.text(14, 10, '🃏 원카드', { fontSize: '16px', color: '#e2e8f0', fontStyle: 'bold' });
    this.timerText = this.add.text(W - 14, 10, '', { fontSize: '16px', color: '#94a3b8' }).setOrigin(1, 0);
    this.ui = this.add.container(0, 0);
    this.ready = true;
    if (this.latest) this.render();
  }

  pushState(s: RoomState): void {
    this.latest = s;
    this.pendingSuitCard = null; // 상태 갱신 시 무늬 선택 모드 해제
    if (this.ready) this.render();
  }

  update(): void {
    if (!this.latest?.timerEndsAt) {
      this.timerText?.setText('');
      return;
    }
    const left = Math.max(0, Math.ceil((this.latest.timerEndsAt - Date.now()) / 1000));
    this.timerText?.setText('⏳ ' + left);
  }

  // 카드 한 장 그리기(프레임 + 텍스트 오버레이). back=true면 뒷면.
  private drawCard(x: number, y: number, card: HandCard | null, scale = 1): Phaser.GameObjects.Container {
    const c = this.add.container(x, y);
    const w = 78 * scale;
    const h = 108 * scale;
    if (!card) {
      const back = this.textures.exists('oc-back')
        ? this.add.image(0, 0, 'oc-back').setDisplaySize(w, h)
        : (this.add.rectangle(0, 0, w, h, 0x1e3a8a).setStrokeStyle(2, 0xffffff, 0.4) as unknown as Phaser.GameObjects.Image);
      c.add(back);
      return c;
    }
    const frame = this.textures.exists('oc-frame')
      ? this.add.image(0, 0, 'oc-frame').setDisplaySize(w, h)
      : (this.add.rectangle(0, 0, w, h, 0xf8fafc).setStrokeStyle(2, 0x334155) as unknown as Phaser.GameObjects.Image);
    c.add(frame);
    const isJoker = card.rank === 'JOKER';
    const color = isJoker ? '#7c3aed' : card.suit ? SUIT_COLOR[card.suit] : '#1e293b';
    const label = isJoker ? '🃏' : card.rank;
    const suit = isJoker ? '★' : card.suit ? SUIT_LABEL[card.suit] : '';
    c.add(this.add.text(-w / 2 + 6, -h / 2 + 4, label, { fontSize: `${18 * scale}px`, color, fontStyle: 'bold' }));
    c.add(this.add.text(0, 0, suit, { fontSize: `${30 * scale}px`, color }).setOrigin(0.5));
    return c;
  }

  private btn(x: number, y: number, w: number, label: string, color: number, onClick: () => void) {
    const r = this.add
      .rectangle(x, y, w, 28, color, 0.9)
      .setStrokeStyle(1, 0xffffff, 0.35)
      .setInteractive({ useHandCursor: true });
    r.on('pointerdown', onClick);
    const t = this.add.text(x, y, label, { fontSize: '13px', color: '#fff', fontStyle: 'bold' }).setOrigin(0.5);
    this.ui.add([r, t]);
  }

  private render(): void {
    const s = this.latest!;
    const g = s.game as any;
    const W = this.scale.width;
    const H = this.scale.height;
    this.ui.removeAll(true);

    if (s.phase === 'playing') bgm.play('mafiaDay');
    else if (s.phase === 'ended') bgm.stop();

    // ── 종료 화면(요약) ──
    if (s.phase === 'ended') {
      const winName = (g.players as any[])?.find((p) => p.id === g.winnerId)?.name ?? '?';
      this.headText.setText('🏁 게임 종료');
      this.ui.add(this.add.text(W / 2, H / 2, `🎉 ${winName}님 승리!`, { fontSize: '22px', color: '#fde68a', fontStyle: 'bold' }).setOrigin(0.5));
      return;
    }

    const myTurn = g.turnPlayerId === s.myId;
    this.headText.setText(myTurn ? '🃏 당신 차례!' : '🃏 원카드');

    // ── 상대들(상단 호) ──
    const opponents = (g.players as any[]).filter((p) => p.id !== s.myId);
    const oCols = Math.max(1, opponents.length);
    const oW = Math.min(120, (W - 40) / oCols);
    const oStartX = W / 2 - (oCols * oW) / 2 + oW / 2;
    opponents.forEach((p, i) => {
      const x = oStartX + i * oW;
      const y = 58;
      const ring = this.add.circle(x, y, 22, p.isCurrent ? 0xfacc15 : 0x334155, p.isCurrent ? 0.9 : 0.7);
      this.ui.add(ring);
      this.ui.add(this.add.text(x, y, `🂠${p.handCount}`, { fontSize: '13px', color: '#fff', fontStyle: 'bold' }).setOrigin(0.5));
      this.ui.add(this.add.text(x, y + 30, p.name, { fontSize: '11px', color: p.isCurrent ? '#fde68a' : '#cbd5e1' }).setOrigin(0.5));
    });

    // ── 중앙: 덱 + 버린 더미 top + 활성무늬/방향 ──
    const cy = 175;
    // 덱(드로우 파일)
    const deckC = this.drawCard(W / 2 - 60, cy, null, 0.9);
    this.ui.add(deckC);
    this.ui.add(this.add.text(W / 2 - 60, cy + 60, `덱 ${g.deckCount}`, { fontSize: '11px', color: '#94a3b8' }).setOrigin(0.5));
    if (myTurn) {
      const hit = this.add.rectangle(W / 2 - 60, cy, 72, 100, 0xffffff, 0.001).setInteractive({ useHandCursor: true });
      hit.on('pointerdown', () => this.sendAction({ kind: 'draw' }));
      this.ui.add(hit);
    }

    // 버린 더미 top
    if (g.topCard) {
      const tc: HandCard = { id: 'top', rank: g.topCard.rank, suit: g.topCard.suit, playable: false };
      this.ui.add(this.drawCard(W / 2 + 50, cy, tc, 1));
    }

    // 활성 무늬 + 방향
    const as: Suit | null = g.activeSuit;
    if (as) {
      this.ui.add(
        this.add.text(W / 2 + 50, cy + 62, `활성 ${SUIT_LABEL[as]}`, { fontSize: '13px', color: SUIT_COLOR[as] === '#dc2626' ? '#f87171' : '#e2e8f0', fontStyle: 'bold' }).setOrigin(0.5)
      );
    }
    this.ui.add(this.add.text(W / 2, cy - 70, g.direction === 1 ? '↻ 시계' : '↺ 반시계', { fontSize: '12px', color: '#94a3b8' }).setOrigin(0.5));

    // 누적 공격 배지
    if (g.pendingDraw > 0) {
      this.ui.add(this.add.rectangle(W / 2, cy - 50, 130, 24, 0xdc2626, 0.95).setStrokeStyle(1, 0xffffff, 0.4));
      this.ui.add(this.add.text(W / 2, cy - 50, `💥 누적 공격 +${g.pendingDraw}`, { fontSize: '12px', color: '#fff', fontStyle: 'bold' }).setOrigin(0.5));
    }

    // ── 무늬 선택 모드 ──
    if (this.pendingSuitCard) {
      this.ui.add(this.add.rectangle(W / 2, 240, W - 40, 30, 0x0f172a, 0.95).setStrokeStyle(1, 0x7c3aed));
      this.ui.add(this.add.text(W / 2, 240, '바꿀 무늬를 고르세요:', { fontSize: '13px', color: '#e2e8f0' }).setOrigin(0.5));
      SUITS.forEach((su, i) => {
        const bx = W / 2 - 90 + i * 60;
        this.btn(bx, 272, 50, SUIT_LABEL[su], su === 'H' || su === 'D' ? 0xdc2626 : 0x334155, () => {
          this.sendAction({ kind: 'play', cardId: this.pendingSuitCard!, chosenSuit: su });
          this.pendingSuitCard = null;
        });
      });
      this.btn(W / 2, 304, 80, '취소', 0x64748b, () => {
        this.pendingSuitCard = null;
        this.render();
      });
    }

    // ── 내 손패(하단 row) ──
    const myHand: HandCard[] = g.myHand ?? [];
    const hN = Math.max(1, myHand.length);
    const cardW = Math.min(56, (W - 24) / hN);
    const hStartX = W / 2 - ((hN - 1) * cardW) / 2;
    const handY = H - 64;
    myHand.forEach((card, i) => {
      const x = hStartX + i * cardW;
      const cc = this.drawCard(x, handY, card, 0.62);
      if (!card.playable) cc.setAlpha(0.4);
      else {
        // 클릭 영역
        const hit = this.add.rectangle(x, handY, 50, 68, 0xffffff, 0.001).setInteractive({ useHandCursor: true });
        hit.on('pointerdown', () => {
          if (card.rank === '7' || card.rank === 'JOKER') {
            this.pendingSuitCard = card.id;
            this.render();
          } else {
            this.sendAction({ kind: 'play', cardId: card.id });
          }
        });
        this.ui.add(hit);
      }
      this.ui.add(cc);
    });

    // ── 하단 안내 + 패스 버튼 ──
    let prompt = '';
    if (!myTurn) prompt = '⏳ 상대 차례를 기다립니다…';
    else if (g.pendingDraw > 0) prompt = `💥 받아치거나(같은 종류) 덱을 눌러 ${g.pendingDraw}장을 받으세요`;
    else if (myHand.some((c) => c.playable)) prompt = '낼 카드를 클릭하거나, 덱을 눌러 뽑으세요';
    else prompt = '낼 카드가 없습니다 — 덱을 눌러 뽑으세요';
    this.ui.add(this.add.text(W / 2, H - 16, prompt, { fontSize: '12px', color: '#cbd5e1' }).setOrigin(0.5));

    // 뽑은 뒤에도 못 낼 때만 패스(클라는 항상 노출, 서버가 검증)
    if (myTurn && g.pendingDraw === 0 && !myHand.some((c) => c.playable)) {
      this.btn(W - 56, H - 40, 80, '⤵️ 패스', 0x2563eb, () => this.sendAction({ kind: 'pass' }));
    }
  }
}
