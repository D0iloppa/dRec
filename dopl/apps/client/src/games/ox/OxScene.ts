// OX 퀴즈 Phaser 씬. 서버 state를 받아 렌더, O/X 탭을 action으로 전송.
// 이후 게임 씬들의 참고 템플릿.
import Phaser from 'phaser';
import type { RoomState } from '@dopl/protocol';
import { avatarTexture } from '../../avatarTexture';

export class OxScene extends Phaser.Scene {
  sendAction!: (a: { kind: string; value?: boolean }) => void;
  private latest: RoomState | null = null;
  private ready = false;
  private myChoice: boolean | null = null;
  private lastRound = -1;

  private qText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private oZone!: Phaser.GameObjects.Rectangle;
  private xZone!: Phaser.GameObjects.Rectangle;
  private tokens!: Phaser.GameObjects.Container;

  constructor() {
    super('ox');
  }

  create(): void {
    const W = this.scale.width;
    const H = this.scale.height;

    this.qText = this.add
      .text(W / 2, 26, '', { fontSize: '18px', color: '#e2e8f0', align: 'center', wordWrap: { width: W - 40 } })
      .setOrigin(0.5, 0);
    this.timerText = this.add.text(W - 12, 10, '', { fontSize: '16px', color: '#94a3b8' }).setOrigin(1, 0);

    this.oZone = this.add
      .rectangle(W * 0.27, H * 0.48, W * 0.42, H * 0.42, 0x2563eb, 0.18)
      .setStrokeStyle(2, 0x2563eb)
      .setInteractive({ useHandCursor: true });
    this.add.text(W * 0.27, H * 0.48, 'O', { fontSize: '72px', color: '#60a5fa' }).setOrigin(0.5);
    this.xZone = this.add
      .rectangle(W * 0.73, H * 0.48, W * 0.42, H * 0.42, 0xdc2626, 0.18)
      .setStrokeStyle(2, 0xdc2626)
      .setInteractive({ useHandCursor: true });
    this.add.text(W * 0.73, H * 0.48, 'X', { fontSize: '72px', color: '#f87171' }).setOrigin(0.5);
    this.oZone.on('pointerdown', () => this.choose(true));
    this.xZone.on('pointerdown', () => this.choose(false));

    this.statusText = this.add.text(W / 2, H * 0.74, '', { fontSize: '14px', color: '#cbd5e1' }).setOrigin(0.5);
    this.tokens = this.add.container(0, 0);

    this.ready = true;
    if (this.latest) this.render();
  }

  pushState(s: RoomState): void {
    this.latest = s;
    if (this.ready) this.render();
  }

  private choose(value: boolean): void {
    const g = this.latest?.game as any;
    if (!this.latest || this.latest.phase !== 'playing' || g?.stage !== 'answer' || !g?.myAlive) return;
    if (g?.myAnswer != null || this.myChoice != null) return;
    this.myChoice = value;
    this.sendAction({ kind: 'answer', value });
    this.render();
  }

  update(): void {
    if (!this.latest?.timerEndsAt) {
      this.timerText?.setText('');
      return;
    }
    const left = Math.max(0, Math.ceil((this.latest.timerEndsAt - Date.now()) / 1000));
    this.timerText?.setText('⏳ ' + left);
  }

  private render(): void {
    const s = this.latest!;
    const g = s.game as any;
    if (g.round !== this.lastRound) {
      this.myChoice = null;
      this.lastRound = g.round;
    }
    const myAns: boolean | null = g.myAnswer ?? this.myChoice;

    // 질문/정답/결과 텍스트
    if (g.stage === 'answer' && g.question) {
      this.qText.setText(`${g.question.category ? '[' + g.question.category + '] ' : ''}${g.question.text}`);
    } else if (g.stage === 'reveal' && g.reveal) {
      this.qText.setText(`정답: ${g.reveal.answer ? '⭕ O' : '❌ X'}`);
    } else if (s.phase === 'ended') {
      this.qText.setText(`🏆 생존: ${(g.winnerNames || []).join(', ') || '없음'}`);
    } else {
      this.qText.setText('');
    }

    // 존 하이라이트 (내 선택 / 정답)
    const reveal = g.stage === 'reveal' || s.phase === 'ended' ? g.reveal : null;
    this.oZone.setFillStyle(0x2563eb, reveal ? (reveal.answer ? 0.5 : 0.1) : myAns === true ? 0.45 : 0.18);
    this.xZone.setFillStyle(0xdc2626, reveal ? (!reveal.answer ? 0.5 : 0.1) : myAns === false ? 0.45 : 0.18);

    // 상태 안내
    if (s.phase === 'ended') this.statusText.setText('게임 종료');
    else if (g.stage === 'reveal') this.statusText.setText(g.reveal?.wipe ? '전원 오답! 탈락 없음' : `탈락: ${g.reveal?.eliminatedNames?.join(', ') || '없음'}`);
    else if (!g.myAlive) this.statusText.setText('탈락하여 관전 중…');
    else if (myAns != null) this.statusText.setText(`응답함 (${myAns ? 'O' : 'X'}) — 대기 중…`);
    else this.statusText.setText('O 또는 X를 선택하세요');

    // 플레이어 토큰
    this.tokens.removeAll(true);
    const players = s.players as any[];
    players.forEach((p, i) => {
      const x = 36 + (i % 8) * 66;
      const y = this.scale.height - 50 - Math.floor(i / 8) * 52;
      const alive = p.alive !== false;
      const ring = this.add.circle(x, y, 20, 0x000000, 0);
      if (g.stage === 'answer' && p.answered) ring.setStrokeStyle(3, 0xfacc15);
      this.tokens.add(ring);
      // 꾸민 캐릭터 노출 (텍스처 준비 전엔 원형 폴백)
      const texKey = avatarTexture(this, (p as any).avatar, () => this.render());
      if (texKey) {
        const img = this.add.image(x, y, texKey).setDisplaySize(28, 37);
        if (!alive) { img.setAlpha(0.35); img.setTint(0x9aa7b5); }
        this.tokens.add(img);
      } else {
        this.tokens.add(this.add.circle(x, y, 14, 0x334155, alive ? 0.9 : 0.3));
      }
      if (!alive) this.tokens.add(this.add.text(x, y, '💀', { fontSize: '14px' }).setOrigin(0.5));
      const nm = this.add
        .text(x, y + 24, p.name + (p.id === s.myId ? '(나)' : ''), { fontSize: '10px', color: '#cbd5e1' })
        .setOrigin(0.5);
      this.tokens.add(nm);
    });
  }
}
