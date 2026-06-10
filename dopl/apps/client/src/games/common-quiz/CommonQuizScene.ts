// 상식퀴즈(4지선다) Phaser 씬. 보기 4개 버튼, 서바이벌.
import Phaser from 'phaser';
import type { RoomState } from '@dopl/protocol';
import { avatarTexture } from '../../avatarTexture';

export class CommonQuizScene extends Phaser.Scene {
  sendAction!: (a: { kind: string; index?: number }) => void;
  private latest: RoomState | null = null;
  private ready = false;
  private myPick: number | null = null;
  private lastRound = -1;

  private qText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private optionGroup!: Phaser.GameObjects.Container;
  private tokens!: Phaser.GameObjects.Container;

  constructor() {
    super('common-quiz');
  }

  create(): void {
    const W = this.scale.width;
    this.qText = this.add
      .text(W / 2, 24, '', { fontSize: '18px', color: '#e2e8f0', align: 'center', wordWrap: { width: W - 40 } })
      .setOrigin(0.5, 0);
    this.timerText = this.add.text(W - 12, 10, '', { fontSize: '16px', color: '#94a3b8' }).setOrigin(1, 0);
    this.statusText = this.add.text(W / 2, this.scale.height * 0.72, '', { fontSize: '14px', color: '#cbd5e1' }).setOrigin(0.5);
    this.optionGroup = this.add.container(0, 0);
    this.tokens = this.add.container(0, 0);
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

  private pick(index: number): void {
    const g = this.latest?.game as any;
    if (!this.latest || this.latest.phase !== 'playing' || g?.stage !== 'answer' || !g?.myAlive) return;
    if (g?.myAnswer != null || this.myPick != null) return;
    this.myPick = index;
    this.sendAction({ kind: 'answer', index });
    this.render();
  }

  private render(): void {
    const s = this.latest!;
    const g = s.game as any;
    const W = this.scale.width;
    if (g.round !== this.lastRound) {
      this.myPick = null;
      this.lastRound = g.round;
    }
    const myAns: number | null = g.myAnswer ?? this.myPick;
    const reveal = g.stage === 'reveal' || s.phase === 'ended' ? g.reveal : null;

    // 질문 / 결과
    if (g.stage === 'answer' && g.question) this.qText.setText(`${g.question.category ? '[' + g.question.category + '] ' : ''}${g.question.text}`);
    else if (reveal) this.qText.setText(`정답: ${reveal.options[reveal.answerIndex]}`);
    else if (s.phase === 'ended') this.qText.setText(`🏆 생존: ${(g.winnerNames || []).join(', ') || '없음'}`);
    else this.qText.setText('');

    // 보기 버튼 (answer/reveal 단계에서 옵션 표시)
    this.optionGroup.removeAll(true);
    const opts: string[] = (g.stage === 'answer' && g.question?.options) || reveal?.options || [];
    opts.forEach((opt, i) => {
      const y = 80 + i * 52;
      let fill = 0x334155;
      if (reveal) fill = i === reveal.answerIndex ? 0x16a34a : 0x334155;
      else if (myAns === i) fill = 0x4f46e5;
      const box = this.add.rectangle(W / 2, y, W - 60, 44, fill, 0.9).setStrokeStyle(1, 0x475569);
      if (g.stage === 'answer' && g.myAlive && myAns == null) box.setInteractive({ useHandCursor: true }).on('pointerdown', () => this.pick(i));
      const t = this.add.text(W / 2, y, `${i + 1}. ${opt}`, { fontSize: '15px', color: '#fff' }).setOrigin(0.5);
      this.optionGroup.add([box, t]);
    });

    // 상태
    if (s.phase === 'ended') this.statusText.setText('게임 종료');
    else if (reveal) this.statusText.setText(reveal.wipe ? '전원 오답! 탈락 없음' : `탈락: ${reveal.eliminatedNames.join(', ') || '없음'}`);
    else if (!g.myAlive) this.statusText.setText('탈락하여 관전 중…');
    else if (myAns != null) this.statusText.setText('응답함 — 대기 중…');
    else this.statusText.setText('보기를 선택하세요');

    // 토큰
    this.tokens.removeAll(true);
    (s.players as any[]).forEach((p, i) => {
      const x = 36 + (i % 8) * 66;
      const y = this.scale.height - 40 - Math.floor(i / 8) * 48;
      const alive = p.alive !== false;
      const ring = this.add.circle(x, y, 18, 0x000000, 0);
      if (g.stage === 'answer' && p.answered) ring.setStrokeStyle(3, 0xfacc15);
      this.tokens.add(ring);
      // 꾸민 캐릭터 노출 (텍스처 준비 전엔 원형 폴백)
      const texKey = avatarTexture(this, p.avatar, () => this.render());
      if (texKey) {
        const img = this.add.image(x, y, texKey).setDisplaySize(26, 34);
        if (!alive) { img.setAlpha(0.35); img.setTint(0x9aa7b5); }
        this.tokens.add(img);
      } else {
        this.tokens.add(this.add.circle(x, y, 12, 0x334155, alive ? 0.9 : 0.3));
      }
      if (!alive) this.tokens.add(this.add.text(x, y, '💀', { fontSize: '13px' }).setOrigin(0.5));
      const nm = this.add.text(x, y + 22, p.name + (p.id === s.myId ? '(나)' : ''), { fontSize: '9px', color: '#cbd5e1' }).setOrigin(0.5);
      this.tokens.add(nm);
    });
  }
}
