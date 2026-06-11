// 뱅! Phaser 씬 — 현재 차례/사거리/체력/손패/반응 프롬프트를 렌더.
// 상단에 생존자 토큰(체력 ♥·정체 배지·거리), 하단에 내 손패 클릭 행(카드→대상 지목), 반응 시 응답 버튼.
import Phaser from 'phaser';
import type { RoomState } from '@dopl/protocol';
import { avatarTexture } from '../../avatarTexture';

type Role = 'sheriff' | 'deputy' | 'outlaw' | 'renegade';
type CardCode =
  | 'bang' | 'missed' | 'beer' | 'saloon' | 'stagecoach' | 'wellsfargo'
  | 'panic' | 'catbalou' | 'gatling' | 'indians' | 'duel' | 'generalstore'
  | 'volcanic' | 'schofield' | 'remington' | 'revcarabine' | 'winchester';

const ROLE_LABEL: Record<Role, string> = { sheriff: '보안관', deputy: '부보안관', outlaw: '무법자', renegade: '배신자' };
const ROLE_ICON: Record<Role, string> = { sheriff: '⭐', deputy: '🎖️', outlaw: '🐴', renegade: '🃏' };
const ROLE_TEX: Record<Role, string> = { sheriff: 'bSheriff', deputy: 'bDeputy', outlaw: 'bOutlaw', renegade: 'bRenegade' };

const CARD_LABEL: Record<CardCode, string> = {
  bang: 'BANG!', missed: '빗나감!', beer: '맥주', saloon: '술집', stagecoach: '역마차', wellsfargo: '웰스파고',
  panic: '비상!', catbalou: '캣발루', gatling: '개틀링', indians: '인디언!', duel: '결투', generalstore: '잡화점',
  volcanic: '볼캐닉', schofield: '스코필드', remington: '레밍턴', revcarabine: '리볼빙카빈', winchester: '윈체스터',
};
// 파란(장비) 카드 = 무기, 그 외는 갈색(액션)
const BLUE: ReadonlySet<CardCode> = new Set<CardCode>(['volcanic', 'schofield', 'remington', 'revcarabine', 'winchester']);
// 대상이 필요한 카드 (클릭 → 대상 지목)
const TARGETED: ReadonlySet<CardCode> = new Set<CardCode>(['bang', 'panic', 'catbalou', 'duel']);

export class BangScene extends Phaser.Scene {
  sendAction!: (a: { kind: string; [k: string]: unknown }) => void;
  private latest: RoomState | null = null;
  private ready = false;

  private titleText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private ui!: Phaser.GameObjects.Container;

  // 손패에서 선택한(대상 지목 대기) 카드 인덱스
  private selectedCard: number | null = null;

  constructor() {
    super('bang');
  }

  preload(): void {
    const svg = (key: string, file: string, w: number, h: number) =>
      this.load.svg(key, `/games/bang/${file}`, { width: w, height: h });
    svg('bSheriff', 'sheriff.svg', 40, 40);
    svg('bDeputy', 'deputy.svg', 40, 40);
    svg('bOutlaw', 'outlaw.svg', 40, 40);
    svg('bRenegade', 'renegade.svg', 40, 40);
    svg('bCardBrown', 'card-brown.svg', 56, 78);
    svg('bCardBlue', 'card-blue.svg', 56, 78);
    svg('bCardBack', 'card-back.svg', 56, 78);
  }

  create(): void {
    const W = this.scale.width;
    this.titleText = this.add.text(14, 10, '', { fontSize: '16px', color: '#e2e8f0', fontStyle: 'bold' });
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

  private btn(x: number, y: number, w: number, label: string, color: number, onClick: () => void) {
    const r = this.add.rectangle(x, y, w, 30, color, 0.9).setStrokeStyle(1, 0xffffff, 0.35).setInteractive({ useHandCursor: true });
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

    const myRole: Role | undefined = g.myRole;
    const myId = s.myId;
    const isMyTurn = g.turnPlayerId === myId;
    const pending = g.pending as any | null;

    // ── 헤더 ──
    let title = '🤠 뱅!';
    if (s.phase === 'playing') {
      const turnP = (s.players as any[]).find((p) => p.id === g.turnPlayerId);
      title = `🤠 ${turnP ? turnP.name : '?'}님의 차례 (${this.phaseLabel(g.turnPhase)})`;
    }
    this.titleText.setText(title);
    if (myRole) {
      this.ui.add(
        this.add
          .text(W / 2, 12, `내 정체: ${ROLE_ICON[myRole]} ${ROLE_LABEL[myRole]}`, { fontSize: '12px', color: '#fbbf24', fontStyle: 'bold' })
          .setOrigin(0.5, 0)
      );
    }

    // ── 플레이어 토큰 ──
    const players = s.players as any[];
    const cols = Math.min(7, players.length);
    const cellW = Math.min(80, (W - 16) / cols);
    const startX = W / 2 - (cols * cellW) / 2 + cellW / 2;
    const startY = 70;

    // 대상 지목 가능 여부 — 손패 선택 중이거나 반응 중
    const selectedCode: CardCode | null = this.selectedCard !== null ? (g.myHand?.[this.selectedCard] as CardCode) : null;

    players.forEach((p, i) => {
      const x = startX + (i % cols) * cellW;
      const y = startY + Math.floor(i / cols) * 110;
      const alive = p.alive !== false;
      const role: Role | undefined = p.role;
      const isTurn = p.isTurn;

      let onPick: (() => void) | null = null;
      if (s.phase === 'playing' && alive && p.id !== myId && isMyTurn && selectedCode && TARGETED.has(selectedCode)) {
        onPick = () => {
          this.sendAction({ kind: 'play', cardIndex: this.selectedCard!, target: p.id });
          this.selectedCard = null;
        };
      }

      const ring = this.add.circle(x, y, 25, 0x000000, 0);
      if (isTurn) ring.setStrokeStyle(4, 0xfacc15);
      else if (onPick) ring.setStrokeStyle(3, 0xef4444);
      this.ui.add(ring);

      const texKey = avatarTexture(this, p.avatar, () => this.render());
      let clickTarget: Phaser.GameObjects.Image | Phaser.GameObjects.Arc;
      if (texKey) {
        const img = this.add.image(x, y, texKey).setDisplaySize(36, 48);
        if (!alive) { img.setAlpha(0.4); img.setTint(0x9aa7b5); }
        this.ui.add(img);
        clickTarget = img;
      } else {
        const circ = this.add.circle(x, y, 19, 0x334155, alive ? 0.9 : 0.3);
        this.ui.add(circ);
        clickTarget = circ;
      }
      if (onPick) clickTarget.setInteractive({ useHandCursor: true }).on('pointerdown', onPick);
      if (!alive) this.ui.add(this.add.text(x, y, '💀', { fontSize: '16px' }).setOrigin(0.5));

      // 정체 배지(공개된 경우)
      if (role) {
        const badge = this.add.image(x + 16, y - 16, ROLE_TEX[role]).setDisplaySize(20, 20);
        this.ui.add(badge);
      }

      const nm = this.add
        .text(x, y + 26, p.name + (p.id === myId ? ' (나)' : ''), { fontSize: '10px', color: alive ? '#e2e8f0' : '#64748b' })
        .setOrigin(0.5);
      this.ui.add(nm);

      // 체력 ♥ + 손패 수 + 거리
      if (alive) {
        const hearts = '♥'.repeat(Math.max(0, p.life ?? 0));
        this.ui.add(this.add.text(x, y + 39, hearts, { fontSize: '11px', color: '#f87171' }).setOrigin(0.5));
        const dist = p.id === myId ? '' : (typeof p.distance === 'number' ? ` 📏${p.distance}` : '');
        this.ui.add(
          this.add.text(x, y + 52, `🂠${p.handCount ?? 0}${dist}`, { fontSize: '9px', color: '#94a3b8' }).setOrigin(0.5)
        );
        if (p.weapon) this.ui.add(this.add.text(x, y + 64, `🔫${p.range}`, { fontSize: '9px', color: '#fbbf24' }).setOrigin(0.5));
      } else if (role) {
        this.ui.add(this.add.text(x, y + 39, `${ROLE_ICON[role]}${ROLE_LABEL[role]}`, { fontSize: '9px', color: '#94a3b8' }).setOrigin(0.5));
      }
    });

    // ── 반응 프롬프트 ──
    if (pending && pending.mustRespond) {
      this.renderReaction(g, pending, W, H);
    } else {
      // ── 내 손패 + 턴 액션 ──
      this.renderHand(g, s, isMyTurn, W, H);
    }

    // ── 덱/버린 더미 + 진행 안내 ──
    this.ui.add(this.add.text(14, H - 14, `덱 ${g.deckCount ?? 0} · 버림 ${g.discardCount ?? 0}`, { fontSize: '10px', color: '#64748b' }).setOrigin(0, 1));

    // ── 종료 ──
    if (s.phase === 'ended') {
      const t = g.winnerTeam;
      const label = t === 'law' ? '⭐ 보안관 진영 승리!' : t === 'outlaw' ? '🐴 무법자 승리!' : '🃏 배신자 승리!';
      const bg = this.add.rectangle(W / 2, H / 2, W - 80, 50, 0x0f172a, 0.92).setStrokeStyle(2, 0xfacc15);
      const tx = this.add.text(W / 2, H / 2, label, { fontSize: '18px', color: '#fde68a', fontStyle: 'bold' }).setOrigin(0.5);
      this.ui.add([bg, tx]);
    }
  }

  private phaseLabel(p: string): string {
    return p === 'draw' ? '드로우' : p === 'play' ? '플레이' : p === 'discard' ? '정리' : '대기';
  }

  // 반응 응답 UI
  private renderReaction(g: any, pending: any, W: number, H: number): void {
    const kind: string = pending.kind;
    const need: CardCode | null = pending.need;
    const eligible: number[] = pending.eligible ?? [];
    let prompt = '';
    if (kind === 'bang') prompt = '🔫 BANG!을 맞았습니다 — 빗나감!을 내거나 피해를 받으세요';
    else if (kind === 'gatling') prompt = '🔫 개틀링! — 빗나감!을 내거나 피해를 받으세요';
    else if (kind === 'indians') prompt = '🏹 인디언! — BANG!을 버리거나 피해를 받으세요';
    else if (kind === 'duel') prompt = '⚔️ 결투! — BANG!으로 응수하거나 포기하세요';
    else if (kind === 'generalstore') prompt = '🏪 잡화점 — 가져갈 카드를 고르세요';
    this.ui.add(this.add.text(W / 2, H - 96, prompt, { fontSize: '13px', color: '#fde68a', fontStyle: 'bold' }).setOrigin(0.5));

    if (kind === 'generalstore') {
      const pool: CardCode[] = pending.pool ?? [];
      const cw = 60;
      const startX = W / 2 - (pool.length * cw) / 2 + cw / 2;
      pool.forEach((c, i) => {
        const x = startX + i * cw;
        this.drawCard(x, H - 50, c, () => this.sendAction({ kind: 'pick', poolIndex: i }));
      });
      return;
    }

    // 응답 가능한 카드 버튼들
    if (need && eligible.length > 0) {
      this.btn(W / 2 - 90, H - 50, 160, `${CARD_LABEL[need]} 내기`, 0x16a34a, () =>
        this.sendAction({ kind: 'respond', cardIndex: eligible[0] })
      );
    }
    this.btn(W / 2 + 90, H - 50, 130, '피해 받기', 0xdc2626, () => this.sendAction({ kind: 'takeHit' }));
  }

  // 내 손패 + 턴 단계 액션
  private renderHand(g: any, s: RoomState, isMyTurn: boolean, W: number, H: number): void {
    const hand: CardCode[] = g.myHand ?? [];

    // 턴 단계 버튼
    if (isMyTurn && s.phase === 'playing') {
      if (g.turnPhase === 'draw') {
        this.btn(W / 2, H - 96, 160, '🃏 2장 뽑기', 0x2563eb, () => this.sendAction({ kind: 'draw' }));
      } else {
        this.btn(W / 2, H - 96, 140, '턴 종료', 0x64748b, () => this.sendAction({ kind: 'endTurn' }));
        if (this.selectedCard !== null) {
          const code = hand[this.selectedCard];
          const hint = code && TARGETED.has(code) ? '대상을 클릭하세요' : '';
          if (hint) this.ui.add(this.add.text(W / 2, H - 78, hint, { fontSize: '11px', color: '#fbbf24' }).setOrigin(0.5));
        }
      }
    } else if (s.phase === 'playing') {
      this.ui.add(this.add.text(W / 2, H - 96, '다른 플레이어의 차례를 기다립니다…', { fontSize: '12px', color: '#94a3b8' }).setOrigin(0.5));
    }

    // 손패 카드 행
    const cw = Math.min(60, (W - 20) / Math.max(1, hand.length));
    const startX = W / 2 - (hand.length * cw) / 2 + cw / 2;
    hand.forEach((c, i) => {
      const x = startX + i * cw;
      const selected = this.selectedCard === i;
      this.drawCard(x, H - 42 - (selected ? 8 : 0), c, () => this.onCardClick(i, c, isMyTurn, g));
    });
  }

  // 카드 1장 그리기 (프레임 SVG + 이름 텍스트)
  private drawCard(x: number, y: number, code: CardCode, onClick: () => void): void {
    const tex = BLUE.has(code) ? 'bCardBlue' : 'bCardBrown';
    const img = this.add.image(x, y, tex).setDisplaySize(54, 75).setInteractive({ useHandCursor: true });
    img.on('pointerdown', onClick);
    const label = this.add.text(x, y, CARD_LABEL[code], { fontSize: '10px', color: '#1f2937', fontStyle: 'bold', align: 'center', wordWrap: { width: 46 } }).setOrigin(0.5);
    this.ui.add([img, label]);
  }

  private onCardClick(idx: number, code: CardCode, isMyTurn: boolean, g: any): void {
    if (!isMyTurn || g.turnPhase !== 'play') return;
    if (TARGETED.has(code)) {
      // 대상 지목 모드 토글
      this.selectedCard = this.selectedCard === idx ? null : idx;
      this.render();
      return;
    }
    // 대상 불필요 카드는 즉시 플레이
    this.sendAction({ kind: 'play', cardIndex: idx });
    this.selectedCard = null;
  }
}
