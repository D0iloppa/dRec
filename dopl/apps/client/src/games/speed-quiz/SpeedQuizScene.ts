// 스피드퀴즈 Phaser 씬. 문제/글자수 마스크/초성 힌트/점수판을 렌더.
// 답안 입력은 방의 채팅창을 그대로 사용(큐플레이 방식) — 별도 입력 UI 없음.
import Phaser from 'phaser';
import type { RoomState } from '@dopl/protocol';

export class SpeedQuizScene extends Phaser.Scene {
  sendAction!: (a: unknown) => void;
  private latest: RoomState | null = null;
  private ready = false;

  private roundText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private qText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private board!: Phaser.GameObjects.Container;

  constructor() {
    super('speed-quiz');
  }

  create(): void {
    const W = this.scale.width;
    this.roundText = this.add.text(12, 10, '', { fontSize: '14px', color: '#94a3b8' });
    this.timerText = this.add.text(W - 12, 10, '', { fontSize: '16px', color: '#94a3b8' }).setOrigin(1, 0);
    this.qText = this.add
      .text(W / 2, 64, '', { fontSize: '20px', color: '#e2e8f0', align: 'center', wordWrap: { width: W - 50 } })
      .setOrigin(0.5, 0);
    this.hintText = this.add
      .text(W / 2, 160, '', { fontSize: '26px', color: '#facc15', align: 'center', letterSpacing: 4 })
      .setOrigin(0.5, 0);
    this.statusText = this.add.text(W / 2, 220, '', { fontSize: '14px', color: '#cbd5e1' }).setOrigin(0.5, 0);
    this.board = this.add.container(0, 0);
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

  private render(): void {
    const s = this.latest!;
    const g = s.game as any;

    this.roundText.setText(g.round ? `라운드 ${g.round} / ${g.total}` : '');

    if (g.stage === 'answer' && g.question) {
      const q = g.question;
      this.qText.setText(`${q.category ? '[' + q.category + '] ' : ''}${q.text}`);
      this.hintText.setText(q.hint ?? q.mask ?? '');
      this.hintText.setColor(q.hint ? '#facc15' : '#64748b');
      this.statusText.setText('💬 채팅창에 정답을 입력하세요! (가장 빨리 맞히면 +10점)');
    } else if (g.stage === 'reveal' && g.reveal) {
      this.qText.setText(g.reveal.question);
      this.hintText.setText(`정답: ${g.reveal.answer}`);
      this.hintText.setColor('#4ade80');
      this.statusText.setText(g.reveal.winnerName ? `⚡ ${g.reveal.winnerName} 정답!` : '⏰ 시간 초과 — 정답자 없음');
    } else if (s.phase === 'ended') {
      this.qText.setText(`🏆 우승: ${(g.winnerNames || []).join(', ') || '없음'}`);
      this.hintText.setText('');
      this.statusText.setText('게임 종료');
    } else {
      this.qText.setText('');
      this.hintText.setText('');
      this.statusText.setText('');
    }

    // 점수판 — 점수순 정렬
    this.board.removeAll(true);
    const players = [...(s.players as any[])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const baseY = this.scale.height - 24 - players.length * 22;
    this.board.add(this.add.text(16, baseY - 24, '점수판', { fontSize: '12px', color: '#94a3b8' }));
    players.forEach((p, i) => {
      const y = baseY + i * 22;
      const isMe = p.id === s.myId;
      this.board.add(
        this.add.text(16, y, `${i + 1}. ${p.name}${isMe ? ' (나)' : ''}`, {
          fontSize: '13px',
          color: isMe ? '#facc15' : '#cbd5e1',
        })
      );
      this.board.add(
        this.add.text(220, y, `${p.score ?? 0}점`, { fontSize: '13px', color: '#7dd3fc' }).setOrigin(0, 0)
      );
    });
  }
}
