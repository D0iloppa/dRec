// 스플랜더 Phaser 씬 — 공개 보석 경제 보드를 렌더.
// 상단 토큰 풀 / 중앙 3티어×4장 개발카드(비용 핍·점수·보너스 절차적 렌더) / 귀족 줄 /
// 하단 내 테이블로 요약·토큰 바·액션 버튼. 카드 클릭→구매/예약 선택, 토큰 클릭→가져오기 선택.
import Phaser from 'phaser';
import type { RoomState } from '@dopl/protocol';

type Color = 'emerald' | 'sapphire' | 'ruby' | 'diamond' | 'onyx';
type Token = Color | 'gold';

const COLORS: Color[] = ['emerald', 'sapphire', 'ruby', 'diamond', 'onyx'];
const TOKENS: Token[] = ['emerald', 'sapphire', 'ruby', 'diamond', 'onyx', 'gold'];

const COLOR_HEX: Record<Token, number> = {
  emerald: 0x22c55e,
  sapphire: 0x3b82f6,
  ruby: 0xef4444,
  diamond: 0xf1f5f9,
  onyx: 0x334155,
  gold: 0xfbbf24,
};

interface Card {
  id: number;
  tier: 1 | 2 | 3;
  cost: Partial<Record<Color, number>>;
  bonus: Color;
  points: number;
}
interface Noble {
  id: number;
  requirement: Partial<Record<Color, number>>;
  points: number;
}

export class SplendorScene extends Phaser.Scene {
  sendAction!: (a: { kind: string; [k: string]: unknown }) => void;
  private latest: RoomState | null = null;
  private ready = false;

  private headerText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private ui!: Phaser.GameObjects.Container;

  // 보석3 선택 누적 (서로 다른 3색)
  private takeSel: Color[] = [];

  constructor() {
    super('splendor');
  }

  preload(): void {
    for (const t of TOKENS) this.load.svg(`gem-${t}`, `/games/splendor/gem-${t}.svg`, { width: 28, height: 28 });
    this.load.svg('card-frame', '/games/splendor/card-frame.svg', { width: 80, height: 110 });
    this.load.svg('noble', '/games/splendor/noble.svg', { width: 44, height: 44 });
  }

  create(): void {
    const W = this.scale.width;
    this.headerText = this.add.text(12, 8, '', { fontSize: '15px', color: '#e2e8f0', fontStyle: 'bold' });
    this.timerText = this.add.text(W - 12, 8, '', { fontSize: '15px', color: '#94a3b8' }).setOrigin(1, 0);
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

  // ── 작은 헬퍼 ───────────────────────────────────────────────
  private btn(x: number, y: number, w: number, label: string, color: number, onClick: () => void): void {
    const r = this.add
      .rectangle(x, y, w, 26, color, 0.92)
      .setStrokeStyle(1, 0xffffff, 0.35)
      .setInteractive({ useHandCursor: true });
    r.on('pointerdown', onClick);
    const t = this.add.text(x, y, label, { fontSize: '12px', color: '#fff', fontStyle: 'bold' }).setOrigin(0.5);
    this.ui.add([r, t]);
  }

  // 비용 핍을 작은 색 원으로 절차적 렌더 (카드 하단 왼쪽부터)
  private drawCost(cost: Partial<Record<Color, number>>, x: number, y: number): void {
    let i = 0;
    for (const c of COLORS) {
      const n = cost[c] ?? 0;
      if (n <= 0) continue;
      const cx = x + 9;
      const cy = y + i * 16;
      this.ui.add(this.add.circle(cx, cy, 6, COLOR_HEX[c]).setStrokeStyle(1, 0x000000, 0.4));
      this.ui.add(this.add.text(cx + 11, cy, String(n), { fontSize: '11px', color: '#e2e8f0' }).setOrigin(0, 0.5));
      i++;
    }
  }

  private render(): void {
    const s = this.latest!;
    const g = s.game as any;
    const W = this.scale.width;
    const H = this.scale.height;
    this.ui.removeAll(true);

    const isMyTurn: boolean = !!g.isMyTurn;
    const mustDiscard: boolean = !!g.mustDiscard;
    const turnName = (g.players as any[])?.find((p) => p.id === g.turnPlayerId)?.name ?? '';
    this.headerText.setText(
      s.phase === 'ended'
        ? '🏁 게임 종료'
        : `💎 ${turnName}님 차례${isMyTurn ? ' (나)' : ''} · R${g.round ?? 1}${g.endTriggered ? ' · 마지막 라운드!' : ''}`
    );

    // ── 토큰 풀 (상단) ──
    const pool = (g.tokenPool ?? {}) as Record<Token, number>;
    const poolY = 34;
    const poolStartX = W / 2 - (TOKENS.length * 44) / 2 + 22;
    TOKENS.forEach((t, i) => {
      const x = poolStartX + i * 44;
      const sel = this.takeSel.includes(t as Color);
      if (sel) this.ui.add(this.add.circle(x, poolY, 17, 0xfacc15, 0.3).setStrokeStyle(2, 0xfacc15));
      const img = this.add.image(x, poolY, `gem-${t}`).setDisplaySize(26, 26);
      // 보석 가져오기 선택(내 턴, 토큰 색만, 반납중 아님)
      if (isMyTurn && !mustDiscard && s.phase === 'playing' && t !== 'gold') {
        img.setInteractive({ useHandCursor: true }).on('pointerdown', () => this.onTokenClick(t as Color, pool[t] ?? 0));
      }
      this.ui.add(img);
      this.ui.add(
        this.add.text(x, poolY + 16, String(pool[t] ?? 0), { fontSize: '11px', color: '#cbd5e1' }).setOrigin(0.5)
      );
    });

    // ── 귀족 줄 (토큰 아래) ──
    const nobles = (g.nobles ?? []) as Noble[];
    const nobleStartX = W / 2 - (nobles.length * 50) / 2 + 25;
    nobles.forEach((nb, i) => {
      const x = nobleStartX + i * 50;
      const y = 76;
      this.ui.add(this.add.image(x, y, 'noble').setDisplaySize(40, 40));
      // 요구 핍 (귀족 우측 작게)
      let j = 0;
      for (const c of COLORS) {
        const n = nb.requirement[c] ?? 0;
        if (n <= 0) continue;
        this.ui.add(this.add.circle(x + 24, y - 14 + j * 12, 4, COLOR_HEX[c]));
        this.ui.add(
          this.add.text(x + 30, y - 14 + j * 12, String(n), { fontSize: '9px', color: '#e9d5ff' }).setOrigin(0, 0.5)
        );
        j++;
      }
    });

    // ── 3티어 × 4장 개발카드 ──
    const tiers = [g.tiers?.tier3, g.tiers?.tier2, g.tiers?.tier1] as (Card | null)[][]; // 위→아래 = T3,T2,T1
    const cardW = 64;
    const cardH = 86;
    const gridX = W / 2 - (4 * (cardW + 6)) / 2 + (cardW + 6) / 2;
    const gridY = 116;
    tiers.forEach((row, ti) => {
      const tierNo = (3 - ti) as 1 | 2 | 3;
      const y = gridY + ti * (cardH - 2);
      this.ui.add(this.add.text(8, y, `T${tierNo}`, { fontSize: '11px', color: '#64748b' }).setOrigin(0, 0.5));
      (row ?? []).forEach((c, ci) => {
        const x = gridX + ci * (cardW + 6);
        if (!c) {
          this.ui.add(this.add.rectangle(x, y, cardW, cardH, 0x1e293b, 0.4).setStrokeStyle(1, 0x334155));
          return;
        }
        const frame = this.add.image(x, y, 'card-frame').setDisplaySize(cardW, cardH);
        this.ui.add(frame);
        // 보너스 색 점 + 점수 (상단)
        this.ui.add(this.add.circle(x - cardW / 2 + 14, y - cardH / 2 + 13, 7, COLOR_HEX[c.bonus]).setStrokeStyle(1, 0x000));
        if (c.points > 0)
          this.ui.add(
            this.add
              .text(x + cardW / 2 - 12, y - cardH / 2 + 13, String(c.points), {
                fontSize: '15px',
                color: '#fde68a',
                fontStyle: 'bold',
              })
              .setOrigin(0.5)
          );
        // 비용 핍 (하단 왼쪽)
        this.drawCost(c.cost, x - cardW / 2 + 6, y - cardH / 2 + 36);
        if (isMyTurn && !mustDiscard && s.phase === 'playing')
          frame.setInteractive({ useHandCursor: true }).on('pointerdown', () => this.onCardClick(c, false));
      });
    });

    // ── 내 테이블로 요약 + 토큰 바 (하단) ──
    const me = (g.players as any[])?.find((p) => p.id === s.myId);
    const barY = H - 64;
    if (me) {
      let x = 12;
      // 보너스(보유 카드 색별) + 토큰 개수
      for (const c of COLORS) {
        const bonus = me.bonuses?.[c] ?? 0;
        const tok = me.tokens?.[c] ?? 0;
        this.ui.add(this.add.circle(x + 8, barY, 7, COLOR_HEX[c]).setStrokeStyle(1, 0x000));
        this.ui.add(
          this.add
            .text(x + 8, barY + 14, `${tok}/+${bonus}`, { fontSize: '10px', color: '#cbd5e1' })
            .setOrigin(0.5)
        );
        x += 46;
      }
      const gold = me.tokens?.gold ?? 0;
      this.ui.add(this.add.image(x + 8, barY, 'gem-gold').setDisplaySize(18, 18));
      this.ui.add(this.add.text(x + 8, barY + 14, String(gold), { fontSize: '10px', color: '#fde68a' }).setOrigin(0.5));
      this.ui.add(
        this.add
          .text(W - 12, barY - 4, `🏆 ${me.prestige}점 · 예약 ${me.reservedCount}/3`, {
            fontSize: '12px',
            color: '#e2e8f0',
            fontStyle: 'bold',
          })
          .setOrigin(1, 0.5)
      );
    }

    // ── 내 예약 카드(소유자만 내용) — 클릭 시 구매 ──
    const myReserved = (g.myReserved ?? []) as Card[];
    myReserved.forEach((c, i) => {
      const x = W - 28 - i * 30;
      const y = barY - 30;
      const r = this.add
        .rectangle(x, y, 24, 30, COLOR_HEX[c.bonus], 0.85)
        .setStrokeStyle(1, 0xfacc15)
        .setInteractive({ useHandCursor: true });
      if (isMyTurn && !mustDiscard) r.on('pointerdown', () => this.onCardClick(c, true));
      this.ui.add(r);
      if (c.points > 0)
        this.ui.add(this.add.text(x, y, String(c.points), { fontSize: '10px', color: '#fff' }).setOrigin(0.5));
    });

    // ── 액션 버튼 / 안내 (하단) ──
    if (s.phase === 'ended') {
      const wn = (g.players as any[])?.find((p) => p.id === g.winnerId)?.name ?? '';
      this.ui.add(
        this.add
          .text(W / 2, H - 16, `🏆 ${wn}님 승리!`, { fontSize: '15px', color: '#fde68a', fontStyle: 'bold' })
          .setOrigin(0.5)
      );
      return;
    }

    if (!isMyTurn) {
      this.ui.add(
        this.add
          .text(W / 2, H - 14, `${turnName}님의 차례를 기다리는 중…`, { fontSize: '12px', color: '#94a3b8' })
          .setOrigin(0.5)
      );
      return;
    }

    if (mustDiscard) {
      this.ui.add(
        this.add
          .text(W / 2, H - 30, '보석이 10개를 넘었습니다 — 반납할 보석을 클릭하세요', {
            fontSize: '12px',
            color: '#fca5a5',
          })
          .setOrigin(0.5)
      );
      // 반납 버튼(보유 색)
      let bx = W / 2 - (TOKENS.length * 40) / 2 + 20;
      for (const t of TOKENS) {
        const have = me?.tokens?.[t] ?? 0;
        if (have > 0) this.btn(bx, H - 12, 36, t === 'gold' ? '금' : t[0]!.toUpperCase(), 0x64748b, () => this.sendAction({ kind: 'discard', color: t }));
        bx += 40;
      }
      return;
    }

    // 보석3 확정 버튼 (3색 선택 시)
    if (this.takeSel.length > 0) {
      this.btn(W / 2 - 70, H - 12, 120, `보석 ${this.takeSel.length}개 가져오기`, 0x16a34a, () => {
        this.sendAction({ kind: 'takeThree', colors: [...this.takeSel] });
        this.takeSel = [];
      });
      this.btn(W / 2 + 60, H - 12, 60, '취소', 0x64748b, () => {
        this.takeSel = [];
        this.render();
      });
    } else {
      this.ui.add(
        this.add
          .text(W / 2, H - 14, '보석을 클릭(서로 다른 3색) / 같은색은 더블클릭(2개) / 카드 클릭→구매·예약', {
            fontSize: '11px',
            color: '#cbd5e1',
          })
          .setOrigin(0.5)
      );
    }
  }

  // ── 인터랙션 ────────────────────────────────────────────────
  private lastTokenClick = { color: '' as Color | '', ts: 0 };

  private onTokenClick(color: Color, available: number): void {
    // 더블클릭(같은 색 두 번 빠르게) = 같은색 2개 시도
    const now = Date.now();
    if (this.lastTokenClick.color === color && now - this.lastTokenClick.ts < 400) {
      this.lastTokenClick = { color: '', ts: 0 };
      this.takeSel = [];
      this.sendAction({ kind: 'takeTwo', color });
      return;
    }
    this.lastTokenClick = { color, ts: now };

    if (available <= 0) return;
    if (this.takeSel.includes(color)) {
      this.takeSel = this.takeSel.filter((c) => c !== color);
    } else if (this.takeSel.length < 3) {
      this.takeSel.push(color);
    }
    if (this.takeSel.length === 3) {
      this.sendAction({ kind: 'takeThree', colors: [...this.takeSel] });
      this.takeSel = [];
      return;
    }
    this.render();
  }

  // 카드 클릭 → 구매/예약 선택 미니 메뉴
  private onCardClick(c: Card, reserved: boolean): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const menu = this.add.container(0, 0);
    const bg = this.add.rectangle(W / 2, H / 2, 220, 110, 0x0f172a, 0.96).setStrokeStyle(2, 0x64748b);
    menu.add(bg);
    menu.add(
      this.add
        .text(W / 2, H / 2 - 36, `${c.bonus} · ${c.points}점`, { fontSize: '13px', color: '#e2e8f0', fontStyle: 'bold' })
        .setOrigin(0.5)
    );
    const mk = (dx: number, label: string, color: number, onClick: () => void) => {
      const r = this.add
        .rectangle(W / 2 + dx, H / 2 + 4, 90, 28, color, 0.95)
        .setStrokeStyle(1, 0xffffff, 0.3)
        .setInteractive({ useHandCursor: true });
      r.on('pointerdown', () => {
        menu.destroy(true);
        onClick();
      });
      menu.add(r);
      menu.add(this.add.text(W / 2 + dx, H / 2 + 4, label, { fontSize: '13px', color: '#fff', fontStyle: 'bold' }).setOrigin(0.5));
    };
    mk(-50, '💰 구매', 0x16a34a, () => this.sendAction({ kind: 'buy', cardId: c.id }));
    if (!reserved) mk(50, '📌 예약', 0x2563eb, () => this.sendAction({ kind: 'reserve', tier: c.tier, cardId: c.id }));
    // 닫기
    const close = this.add
      .text(W / 2 + 100, H / 2 - 48, '✕', { fontSize: '14px', color: '#94a3b8' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    close.on('pointerdown', () => menu.destroy(true));
    menu.add(close);
  }
}
