// 라이어게임 Phaser 씬 — 시스템 사회자의 진행 상태를 렌더.
// 제시어 카드(시민) / 라이어 카드 / 좌석순 힌트 버블 / 공개 투표 / 라이어 단어 추측.
// 힌트·추측 텍스트 입력은 캔버스 내부 DOM input으로 처리(다른 씬의 add.dom 패턴).
import Phaser from 'phaser';
import type { RoomState } from '@dopl/protocol';
import { avatarTexture } from '../../avatarTexture';

interface LiarView {
  stage: 'reveal' | 'describe' | 'vote' | 'guess' | null;
  log: string[];
  category: string;
  myWord: string | null;
  amLiar: boolean;
  round: number;
  maxRounds: number;
  turnPlayerId: string | null;
  hints: { name: string; text: string }[];
  myVote?: string | null;
  votedCount?: number;
  aliveCount?: number;
  winner?: 'citizen' | 'liar';
  word?: string;
  liarName?: string;
  finalBoard?: { name: string; iqDelta: number; coinsDelta: number; won: boolean }[];
}

export class LiarScene extends Phaser.Scene {
  sendAction!: (a: { kind: string; target?: string; text?: string }) => void;
  private latest: RoomState | null = null;
  private ready = false;

  private stageText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private ui!: Phaser.GameObjects.Container;
  private dom: Phaser.GameObjects.DOMElement | null = null;

  constructor() {
    super('liar');
  }

  preload(): void {
    this.load.svg('liar-word', '/games/liar/word-card.svg', { width: 220, height: 120 });
    this.load.svg('liar-card', '/games/liar/liar-card.svg', { width: 220, height: 120 });
    this.load.svg('liar-badge', '/games/liar/role-badge.svg', { width: 40, height: 40 });
  }

  create(): void {
    const W = this.scale.width;
    this.stageText = this.add.text(14, 10, '', { fontSize: '17px', color: '#e2e8f0', fontStyle: 'bold' });
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

  private stageLabel(g: LiarView): string {
    switch (g.stage) {
      case 'reveal': return '🃏 카드 공개 — 당신의 단어를 확인하세요';
      case 'describe': return `🗣 힌트 (${g.round}/${g.maxRounds}라운드)`;
      case 'vote': return '🗳 투표 — 라이어를 찾아라';
      case 'guess': return '🎯 라이어의 마지막 기회';
      default: return '';
    }
  }

  private btn(x: number, y: number, w: number, label: string, color: number, onClick: () => void) {
    const r = this.add
      .rectangle(x, y, w, 30, color, 0.9)
      .setStrokeStyle(1, 0xffffff, 0.35)
      .setInteractive({ useHandCursor: true });
    r.on('pointerdown', onClick);
    const t = this.add.text(x, y, label, { fontSize: '13px', color: '#fff', fontStyle: 'bold' }).setOrigin(0.5);
    this.ui.add([r, t]);
  }

  // 캔버스 내부 텍스트 입력 + 제출 버튼 (힌트/추측 공용)
  private textInput(y: number, placeholder: string, btnLabel: string, kind: 'hint' | 'guess'): void {
    const W = this.scale.width;
    const html =
      `<div style="display:flex;gap:6px;align-items:center;">` +
      `<input type="text" maxlength="60" placeholder="${placeholder}" ` +
      `style="width:300px;padding:7px 10px;border-radius:8px;border:1px solid #475569;` +
      `background:#1e293b;color:#e2e8f0;font-size:14px;outline:none;"/>` +
      `<button style="padding:7px 14px;border-radius:8px;border:none;cursor:pointer;` +
      `background:#7c3aed;color:#fff;font-weight:bold;font-size:13px;">${btnLabel}</button>` +
      `</div>`;
    this.dom = this.add.dom(W / 2, y).createFromHTML(html);
    const el = this.dom.node as HTMLElement;
    const input = el.querySelector('input') as HTMLInputElement;
    const button = el.querySelector('button') as HTMLButtonElement;
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      this.sendAction({ kind, text });
      input.value = '';
    };
    button.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') submit();
    });
    setTimeout(() => input.focus(), 50);
  }

  private render(): void {
    const s = this.latest!;
    const g = s.game as unknown as LiarView;
    const W = this.scale.width;
    const H = this.scale.height;
    this.ui.removeAll(true);
    if (this.dom) {
      this.dom.destroy();
      this.dom = null;
    }
    this.stageText.setText(this.stageLabel(g));

    // ── 카테고리 배너 (전원 공개) ──
    this.ui.add(this.add.rectangle(W / 2, 42, W - 24, 26, 0x334155, 0.7).setStrokeStyle(1, 0x64748b));
    this.ui.add(
      this.add.text(W / 2, 42, `카테고리 「${g.category}」`, { fontSize: '14px', color: '#fde68a', fontStyle: 'bold' }).setOrigin(0.5)
    );

    // ── 당신의 카드 ──
    if (s.phase === 'playing') {
      const cardKey = g.amLiar ? 'liar-card' : 'liar-word';
      if (this.textures.exists(cardKey)) {
        this.ui.add(this.add.image(W / 2, 96, cardKey).setDisplaySize(200, 100));
      } else {
        this.ui.add(this.add.rectangle(W / 2, 96, 200, 100, g.amLiar ? 0x7f1d1d : 0x1e3a5f, 0.85).setStrokeStyle(2, 0xfacc15));
      }
      const cardText = g.amLiar ? '🤥 당신은 라이어!\n단어를 모릅니다' : `🤫 제시어\n「${g.myWord}」`;
      this.ui.add(
        this.add.text(W / 2, 96, cardText, { fontSize: '15px', color: '#fff', align: 'center', fontStyle: 'bold' }).setOrigin(0.5)
      );
    }

    // ── 플레이어 토큰 ──
    const players = s.players as Array<Record<string, unknown>>;
    const cols = Math.min(4, players.length);
    const cellW = Math.min(130, (W - 20) / cols);
    const startX = W / 2 - (cols * cellW) / 2 + cellW / 2;
    const startY = 178;
    const myVote = g.myVote ?? null;

    players.forEach((p, i) => {
      const x = startX + (i % cols) * cellW;
      const y = startY + Math.floor(i / cols) * 84;
      const pid = p.id as string;

      // 투표 단계 → 다른 사람 클릭으로 투표
      let onPick: (() => void) | null = null;
      if (s.phase === 'playing' && g.stage === 'vote' && pid !== s.myId) {
        onPick = () => this.sendAction({ kind: 'vote', target: pid });
      }

      const ring = this.add.circle(x, y, 25, 0x000000, 0);
      if (myVote === pid) ring.setStrokeStyle(4, 0xfacc15);
      else if (g.turnPlayerId === pid) ring.setStrokeStyle(3, 0x7c3aed); // 현재 힌트 차례
      else if (onPick) ring.setStrokeStyle(2, 0xffffff, 0.5);
      this.ui.add(ring);

      const texKey = avatarTexture(this, p.avatar as Parameters<typeof avatarTexture>[1], () => this.render());
      let clickTarget: Phaser.GameObjects.Image | Phaser.GameObjects.Arc;
      if (texKey) {
        const img = this.add.image(x, y, texKey).setDisplaySize(36, 48);
        this.ui.add(img);
        clickTarget = img;
      } else {
        const circ = this.add.circle(x, y, 19, 0x334155, 0.9);
        this.ui.add(circ);
        clickTarget = circ;
      }
      if (onPick) clickTarget.setInteractive({ useHandCursor: true }).on('pointerdown', onPick);

      // 종료 후 역할 배지
      if (s.phase === 'ended' && p.role === 'liar' && this.textures.exists('liar-badge')) {
        this.ui.add(this.add.image(x + 16, y - 16, 'liar-badge').setDisplaySize(22, 22));
      }

      const nm = this.add
        .text(x, y + 30, (p.name as string) + (pid === s.myId ? ' (나)' : ''), { fontSize: '11px', color: '#e2e8f0' })
        .setOrigin(0.5);
      this.ui.add(nm);

      // 상태 줄
      let sub = '';
      if (s.phase === 'ended' && p.role) sub = p.role === 'liar' ? '🤥 라이어' : '🙂 시민';
      else if (g.stage === 'vote' && (p.voteCount as number) > 0) sub = `🗳 ${p.voteCount}표`;
      else if (g.stage === 'vote' && p.voted) sub = '✓ 투표함';
      else if (g.stage === 'describe' && g.turnPlayerId === pid) sub = '🎤 발언 중';
      else if (g.stage === 'describe' && p.hasHinted) sub = '💬';
      if (sub) this.ui.add(this.add.text(x, y + 44, sub, { fontSize: '10px', color: '#fbbf24' }).setOrigin(0.5));
    });

    // ── 힌트 목록 (최근 6개) ──
    if (g.hints.length) {
      const recent = g.hints.slice(-6).map((h) => `${h.name}: ${h.text}`).join('   ·   ');
      this.ui.add(
        this.add
          .text(W / 2, H - 88, recent, { fontSize: '11px', color: '#cbd5e1', wordWrap: { width: W - 30 }, align: 'center' })
          .setOrigin(0.5)
      );
    }

    // ── 하단 안내 + 입력 ──
    if (s.phase === 'ended') {
      const win = g.winner === 'liar' ? '🤥 라이어 승리!' : '🎉 시민 승리!';
      this.ui.add(
        this.add
          .text(W / 2, H - 36, `${win}  ·  제시어: 「${g.word}」  ·  라이어: ${g.liarName}`, {
            fontSize: '14px', color: '#fde68a', fontStyle: 'bold',
          })
          .setOrigin(0.5)
      );
      return;
    }

    const isMyTurn = g.stage === 'describe' && g.turnPlayerId === s.myId;
    if (isMyTurn) {
      this.textInput(H - 34, '단어를 직접 말하지 말고 힌트만!', '힌트 제출', 'hint');
    } else if (g.stage === 'guess' && g.amLiar) {
      this.textInput(H - 34, '제시어를 맞혀보세요 — 정답이면 대역전!', '추측 제출', 'guess');
    } else {
      let prompt = '';
      switch (g.stage) {
        case 'reveal': prompt = '카드를 확인하세요… 곧 힌트 차례가 시작됩니다.'; break;
        case 'describe': prompt = `${g.turnPlayerId ? '다른 플레이어가 힌트 중…' : ''} (대기)`; break;
        case 'vote': prompt = myVote ? `투표 완료 (${g.votedCount}/${g.aliveCount})` : '라이어로 의심되는 사람을 클릭하세요'; break;
        case 'guess': prompt = '라이어가 제시어를 추측하는 중…'; break;
      }
      this.ui.add(this.add.text(W / 2, H - 34, prompt, { fontSize: '13px', color: '#cbd5e1' }).setOrigin(0.5));
    }
  }
}
