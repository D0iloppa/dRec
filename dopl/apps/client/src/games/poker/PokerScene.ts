// 포커(텍사스 홀덤) Phaser 씬 — 시스템 딜러의 진행 상태를 렌더.
// 중앙: 커뮤니티 보드 + 팟. 테이블 둘레: 플레이어(칩/베트/딜러버튼/폴드·올인). 하단: 내 홀카드 + 액션 버튼.
// 카드 프레임/뒷면/칩/슈트는 SVG 플레이스홀더로 preload, 랭크/슈트 글자는 텍스트로 얹는다.
import Phaser from 'phaser';
import type { RoomState } from '@dopl/protocol';
import { avatarTexture } from '../../avatarTexture';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['♠', '♥', '♦', '♣'];
const SUIT_RED = [false, true, true, false];

function rankStr(card: number): string {
  return RANKS[card % 13]!;
}
function suitIdx(card: number): number {
  return Math.floor(card / 13);
}

const STREET_LABEL: Record<string, string> = {
  preflop: '프리플랍',
  flop: '플랍',
  turn: '턴',
  river: '리버',
  showdown: '쇼다운',
};

export class PokerScene extends Phaser.Scene {
  sendAction!: (a: { kind: string; amount?: number }) => void;
  private latest: RoomState | null = null;
  private ready = false;

  private streetText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private ui!: Phaser.GameObjects.Container;
  private raiseAmount = 0; // 레이즈 스테퍼 현재값(목표 총액)

  constructor() {
    super('poker');
  }

  preload(): void {
    this.load.svg('pk-frame', '/games/poker/card-frame.svg', { width: 60, height: 84 });
    this.load.svg('pk-back', '/games/poker/card-back.svg', { width: 60, height: 84 });
    this.load.svg('pk-chip', '/games/poker/chip.svg', { width: 32, height: 32 });
    this.load.svg('pk-spade', '/games/poker/suit-spade.svg', { width: 24, height: 24 });
    this.load.svg('pk-heart', '/games/poker/suit-heart.svg', { width: 24, height: 24 });
    this.load.svg('pk-diamond', '/games/poker/suit-diamond.svg', { width: 24, height: 24 });
    this.load.svg('pk-club', '/games/poker/suit-club.svg', { width: 24, height: 24 });
  }

  create(): void {
    const W = this.scale.width;
    // 테이블 펠트
    this.add.ellipse(W / 2, 200, W - 60, 250, 0x15603f).setStrokeStyle(4, 0x0a2c20);
    this.streetText = this.add.text(14, 10, '', { fontSize: '16px', color: '#e2e8f0', fontStyle: 'bold' });
    this.timerText = this.add.text(W - 14, 10, '', { fontSize: '16px', color: '#94a3b8' }).setOrigin(1, 0);
    this.ui = this.add.container(0, 0);
    this.ready = true;
    if (this.latest) this.render();
  }

  pushState(s: RoomState): void {
    this.latest = s;
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

  // 카드 한 장 렌더 (앞면: 프레임 + 랭크/슈트, 뒷면: 백). 컨테이너에 추가.
  private drawCard(x: number, y: number, card: number | null, scale = 1): void {
    if (card === null || card === undefined) {
      const back = this.add.image(x, y, 'pk-back').setScale(scale);
      this.ui.add(back);
      return;
    }
    const frame = this.add.image(x, y, 'pk-frame').setScale(scale);
    this.ui.add(frame);
    const s = suitIdx(card);
    const color = SUIT_RED[s] ? '#dc2626' : '#0f172a';
    const w = 60 * scale;
    const h = 84 * scale;
    const r = this.add
      .text(x - w / 2 + 6 * scale, y - h / 2 + 4 * scale, rankStr(card), {
        fontSize: `${Math.round(16 * scale)}px`,
        color,
        fontStyle: 'bold',
      })
      .setOrigin(0, 0);
    const su = this.add
      .text(x, y + 4 * scale, SUITS[s]!, { fontSize: `${Math.round(26 * scale)}px`, color })
      .setOrigin(0.5);
    this.ui.add([r, su]);
  }

  private btn(x: number, y: number, w: number, label: string, color: number, onClick: () => void): void {
    const r = this.add
      .rectangle(x, y, w, 30, color, 0.95)
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
    this.streetText.setText(
      `♠️ ${STREET_LABEL[g.street] ?? ''} · 핸드 ${g.handNo ?? 0}/${g.maxHands ?? 0}`
    );

    // ── 중앙: 팟 + 커뮤니티 보드 ──
    this.ui.add(
      this.add.text(W / 2, 110, `팟 ${g.pot ?? 0}`, { fontSize: '15px', color: '#fde68a', fontStyle: 'bold' }).setOrigin(0.5)
    );
    const board: number[] = Array.isArray(g.board) ? g.board : [];
    const bn = 5;
    const cardW = 44;
    const startBX = W / 2 - (bn * cardW) / 2 + cardW / 2;
    for (let i = 0; i < bn; i++) {
      const x = startBX + i * cardW;
      if (i < board.length) this.drawCard(x, 168, board[i]!, 0.7);
      else {
        const ph = this.add.rectangle(x, 168, 40, 58, 0x0a2c20, 0.5).setStrokeStyle(1, 0x15603f);
        this.ui.add(ph);
      }
    }

    // ── 플레이어 좌석 (테이블 둘레) ──
    const players = s.players as any[];
    const n = players.length;
    // 나를 하단 중앙에 두도록 회전 정렬
    const myIdx = players.findIndex((p) => p.id === s.myId);
    const ordered = myIdx >= 0 ? [...players.slice(myIdx), ...players.slice(0, myIdx)] : players;

    ordered.forEach((p, k) => {
      // k=0 은 하단(나). 나머지는 위쪽 반원에 분산.
      let x: number;
      let y: number;
      if (k === 0) {
        x = W / 2;
        y = 300;
      } else {
        const frac = (k - 0.5) / (n - 1); // 0..1
        const ang = Math.PI * (1 - frac); // 왼쪽(π)→오른쪽(0) 위쪽 반원
        x = W / 2 + Math.cos(ang) * (W / 2 - 70);
        y = 235 - Math.sin(ang) * 95;
      }
      const folded = p.folded === true;
      const isToAct = p.isToAct === true;

      // 행동 차례 하이라이트 링
      const ring = this.add.circle(x, y, 25, 0x000000, 0);
      if (isToAct) ring.setStrokeStyle(3, 0xfacc15);
      else if (folded) ring.setStrokeStyle(2, 0x475569, 0.6);
      this.ui.add(ring);

      const texKey = avatarTexture(this, p.avatar, () => this.render());
      if (texKey) {
        const img = this.add.image(x, y, texKey).setDisplaySize(34, 46);
        if (folded || p.inHand === false) {
          img.setAlpha(0.4);
          img.setTint(0x9aa7b5);
        }
        this.ui.add(img);
      } else {
        this.ui.add(this.add.circle(x, y, 18, 0x334155, folded ? 0.3 : 0.9));
      }

      // 딜러 버튼
      if (p.isDealer) {
        this.ui.add(this.add.circle(x + 20, y - 18, 9, 0xf8fafc).setStrokeStyle(1, 0x0f172a));
        this.ui.add(this.add.text(x + 20, y - 18, 'D', { fontSize: '11px', color: '#0f172a', fontStyle: 'bold' }).setOrigin(0.5));
      }

      // 이름 + 칩
      const nm = p.name + (p.id === s.myId ? ' (나)' : '');
      this.ui.add(this.add.text(x, y + 28, nm, { fontSize: '11px', color: folded ? '#64748b' : '#e2e8f0' }).setOrigin(0.5));
      this.ui.add(
        this.add.text(x, y + 41, `💰 ${p.chips ?? 0}`, { fontSize: '10px', color: '#fbbf24' }).setOrigin(0.5)
      );

      // 상태/베트
      let sub = '';
      if (p.inHand === false) sub = '관전';
      else if (folded) sub = '폴드';
      else if (p.allIn) sub = '올인';
      else if ((p.bet ?? 0) > 0) sub = `베트 ${p.bet}`;
      if (sub) this.ui.add(this.add.text(x, y - 34, sub, { fontSize: '10px', color: '#93c5fd' }).setOrigin(0.5));

      // 쇼다운: 공개된 상대 홀카드를 좌석 위에 작게
      if (Array.isArray(p.hole) && p.id !== s.myId) {
        this.drawCard(x - 11, y - 56, p.hole[0]!, 0.42);
        this.drawCard(x + 11, y - 56, p.hole[1]!, 0.42);
      }
    });

    // ── 내 홀카드 (하단) ──
    const myHole: number[] | null = g.myHole ?? null;
    if (myHole && myHole.length === 2) {
      this.drawCard(W / 2 - 26, 352, myHole[0]!, 0.85);
      this.drawCard(W / 2 + 26, 352, myHole[1]!, 0.85);
    }

    // ── 쇼다운 핸드 라벨 ──
    if ((g.street === 'showdown' || s.phase === 'ended') && Array.isArray(g.revealed)) {
      const lines = (g.revealed as any[]).map((r) => `${r.name}: ${(r.cardStrs ?? []).join(' ')} — ${r.hand}`);
      const txt = lines.join('\n') + (g.winnerNames?.length ? `\n🏆 ${g.winnerNames.join(', ')}` : '');
      const bg = this.add.rectangle(W / 2, 120, W - 80, 18 + lines.length * 15, 0x0f172a, 0.92).setStrokeStyle(2, 0xfacc15);
      const t = this.add.text(W / 2, 120, txt, { fontSize: '11px', color: '#fde68a', align: 'center', fontStyle: 'bold' }).setOrigin(0.5);
      this.ui.add([bg, t]);
    }

    // ── 액션 버튼 (내 차례일 때) ──
    const myTurn = s.phase === 'playing' && g.turnPlayerId === s.myId;
    if (myTurn) {
      const toCall: number = g.currentBetToCall ?? 0;
      const myChips: number = g.myChips ?? 0;
      const minRaiseTarget = (g.currentBet ?? 0) + (g.minRaise ?? g.bigBlind ?? 20);
      // 레이즈 스테퍼 기본값 보정
      if (this.raiseAmount < minRaiseTarget) this.raiseAmount = minRaiseTarget;
      if (this.raiseAmount > (g.currentBet ?? 0) + myChips) this.raiseAmount = (g.currentBet ?? 0) + myChips;

      const by = H - 46;
      // 폴드
      this.btn(60, by, 90, '폴드', 0xdc2626, () => this.sendAction({ kind: 'fold' }));
      // 체크 / 콜
      if (toCall <= 0) this.btn(160, by, 90, '체크', 0x16a34a, () => this.sendAction({ kind: 'check' }));
      else this.btn(160, by, 110, `콜 ${Math.min(toCall, myChips)}`, 0x16a34a, () => this.sendAction({ kind: 'call' }));
      // 올인
      this.btn(W - 60, by, 90, `올인 ${myChips}`, 0x9333ea, () => this.sendAction({ kind: 'allin' }));

      // 레이즈 스테퍼 (- / 금액 / +) + 확정
      const ry = H - 14;
      const canRaise = (g.currentBet ?? 0) + myChips >= minRaiseTarget;
      if (canRaise) {
        const step = g.bigBlind ?? 20;
        this.btn(W / 2 - 130, ry, 26, '−', 0x475569, () => {
          this.raiseAmount = Math.max(minRaiseTarget, this.raiseAmount - step);
          this.render();
        });
        this.ui.add(
          this.add.text(W / 2 - 88, ry, `레이즈 → ${this.raiseAmount}`, { fontSize: '12px', color: '#e2e8f0' }).setOrigin(0, 0.5)
        );
        this.btn(W / 2 + 6, ry, 26, '+', 0x475569, () => {
          this.raiseAmount = Math.min((g.currentBet ?? 0) + myChips, this.raiseAmount + step);
          this.render();
        });
        this.btn(W / 2 + 80, ry, 90, '레이즈', 0x2563eb, () =>
          this.sendAction({ kind: 'raise', amount: this.raiseAmount })
        );
      }
      this.ui.add(
        this.add.text(W / 2, by - 24, toCall > 0 ? `콜 필요: ${toCall}` : '체크 가능', {
          fontSize: '11px',
          color: '#cbd5e1',
        }).setOrigin(0.5)
      );
    } else if (s.phase === 'ended') {
      this.ui.add(
        this.add.text(W / 2, H - 24, '🏁 게임 종료 — 최종 칩 순위로 결산되었습니다.', { fontSize: '13px', color: '#fde68a' }).setOrigin(0.5)
      );
    } else if (s.phase === 'playing') {
      const who = players.find((p) => p.id === g.turnPlayerId);
      this.ui.add(
        this.add.text(W / 2, H - 24, who ? `${who.name}님의 차례를 기다리는 중…` : '진행 중…', { fontSize: '12px', color: '#94a3b8' }).setOrigin(0.5)
      );
    }
  }
}
