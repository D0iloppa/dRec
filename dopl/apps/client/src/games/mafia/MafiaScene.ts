// 마피아 Phaser 씬 — 시스템 사회자의 진행 상태를 렌더.
// 역할 카드 / 플레이어 타겟팅(밤 능력·투표) / 공개 투표 현황 / 아침·처형 발표 연출.
import Phaser from 'phaser';
import type { RoomState } from '@dopl/protocol';
import { avatarTexture } from '../../avatarTexture';
import { bgm } from '../../bgm';

type Role = 'mafia' | 'police' | 'doctor' | 'citizen';

const ROLE_LABEL: Record<Role, string> = { mafia: '마피아', police: '경찰', doctor: '의사', citizen: '시민' };
const ROLE_ICON: Record<Role, string> = { mafia: '🔪', police: '🕵️', doctor: '💉', citizen: '👤' };
const ROLE_COLOR: Record<Role, number> = { mafia: 0xdc2626, police: 0x2563eb, doctor: 0x16a34a, citizen: 0x64748b };
const ROLE_DESC: Record<Role, string> = {
  mafia: '밤마다 한 명을 제거하세요. 동료와 채팅으로 작전을 짜세요.',
  police: '밤마다 한 명을 조사해 마피아인지 알아냅니다.',
  doctor: '밤마다 한 명을 지목해 마피아의 공격에서 살립니다.',
  citizen: '낮 토론과 투표로 마피아를 찾아내세요.',
};

export class MafiaScene extends Phaser.Scene {
  sendAction!: (a: { kind: string; target?: string }) => void;
  private latest: RoomState | null = null;
  private ready = false;

  private stageText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private ui!: Phaser.GameObjects.Container;

  constructor() {
    super('mafia');
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

  private stageLabel(g: any): string {
    switch (g.stage) {
      case 'night': return `🌙 ${g.day}번째 밤`;
      case 'dawn': return '🌅 아침 — 밤사이 무슨 일이…';
      case 'day': return `☀️ ${g.day}일차 낮 — 토론`;
      case 'vote': return '🗳 투표';
      case 'execution': return '⚖️ 투표 결과';
      default: return '';
    }
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
    this.stageText.setText(this.stageLabel(g));

    // 단계별 BGM — 밤: 긴장 트랙, 아침/낮(투표·발표 포함): 낮 트랙, 종료: 정지
    if (s.phase === 'playing' && g.stage) bgm.play(g.stage === 'night' ? 'mafiaNight' : 'mafiaDay');
    else if (s.phase === 'ended') bgm.stop();

    const myRole: Role | undefined = g.myRole;
    const myAlive: boolean = g.myAlive;

    // ── 역할 카드 ──
    if (myRole) {
      const rc = ROLE_COLOR[myRole];
      this.ui.add(this.add.rectangle(W / 2, 52, W - 24, 40, rc, 0.22).setStrokeStyle(2, rc));
      this.ui.add(
        this.add
          .text(W / 2, 44, `당신은 ${ROLE_ICON[myRole]} ${ROLE_LABEL[myRole]} ${myAlive ? '' : '(사망 👻)'}`, {
            fontSize: '15px', color: '#fff', fontStyle: 'bold',
          })
          .setOrigin(0.5)
      );
      const sub = myRole === 'mafia' && g.mates ? `동료: ${(g.mates as string[]).join(', ')}` : ROLE_DESC[myRole];
      this.ui.add(this.add.text(W / 2, 61, sub, { fontSize: '11px', color: '#cbd5e1' }).setOrigin(0.5));
    }

    // 경찰 조사 기록
    if (myRole === 'police' && Array.isArray(g.investigations) && g.investigations.length) {
      const lines = (g.investigations as { name: string; mafia: boolean }[])
        .slice(-4)
        .map((r) => `${r.name}: ${r.mafia ? '🔪 마피아!' : '✅ 시민측'}`)
        .join('   ');
      this.ui.add(this.add.text(W / 2, 80, `조사 기록 — ${lines}`, { fontSize: '11px', color: '#93c5fd' }).setOrigin(0.5));
    }

    // ── 플레이어 토큰 그리드 ──
    const players = s.players as any[];
    const cols = Math.min(5, players.length);
    const cellW = Math.min(104, (W - 20) / cols);
    const startX = W / 2 - (cols * cellW) / 2 + cellW / 2;
    const startY = 128;

    const myPick: string | null = g.myPick ?? null; // 마피아 지목
    const myHeal: string | null = g.myHeal ?? null;
    const myVote: string | null = g.myVote ?? null;

    players.forEach((p, i) => {
      const x = startX + (i % cols) * cellW;
      const y = startY + Math.floor(i / cols) * 96;
      const alive = p.alive !== false;
      const role: Role | undefined = p.role;

      // 타겟 가능 여부
      let onPick: (() => void) | null = null;
      if (myAlive && alive && s.phase === 'playing') {
        if (g.stage === 'night' && myRole === 'mafia' && role !== 'mafia') onPick = () => this.sendAction({ kind: 'kill', target: p.id });
        else if (g.stage === 'night' && myRole === 'police' && !g.policeDone && p.id !== s.myId)
          onPick = () => this.sendAction({ kind: 'investigate', target: p.id });
        else if (g.stage === 'night' && myRole === 'doctor') onPick = () => this.sendAction({ kind: 'heal', target: p.id });
        else if (g.stage === 'vote') onPick = () => this.sendAction({ kind: 'vote', target: p.id });
      }

      // 링(선택/타겟 하이라이트) — 아바타 뒤에 깔리는 원
      const ring = this.add.circle(x, y, 27, 0x000000, 0);
      if (myPick === p.id) ring.setStrokeStyle(4, 0xef4444);
      else if (myHeal === p.id) ring.setStrokeStyle(4, 0x4ade80);
      else if (myVote === p.id) ring.setStrokeStyle(4, 0xfacc15);
      else if (onPick) ring.setStrokeStyle(2, 0xffffff, 0.5);
      else if (role) ring.setStrokeStyle(2, ROLE_COLOR[role], 0.9); // 공개된 직업 컬러
      this.ui.add(ring);

      // 꾸민 캐릭터 노출 (텍스처 준비 전엔 원형 폴백)
      const texKey = avatarTexture(this, (p as any).avatar, () => this.render());
      let clickTarget: Phaser.GameObjects.Image | Phaser.GameObjects.Arc;
      if (texKey) {
        const img = this.add.image(x, y, texKey).setDisplaySize(38, 50);
        if (!alive) { img.setAlpha(0.4); img.setTint(0x9aa7b5); }
        this.ui.add(img);
        clickTarget = img;
      } else {
        const circ = this.add.circle(x, y, 20, 0x334155, alive ? 0.9 : 0.3);
        this.ui.add(circ);
        clickTarget = circ;
      }
      if (onPick) clickTarget.setInteractive({ useHandCursor: true }).on('pointerdown', onPick);
      if (!alive) this.ui.add(this.add.text(x, y, '💀', { fontSize: '18px' }).setOrigin(0.5));
      const nm = this.add
        .text(x, y + 32, p.name + (p.id === s.myId ? ' (나)' : ''), { fontSize: '11px', color: alive ? '#e2e8f0' : '#64748b' })
        .setOrigin(0.5);
      this.ui.add(nm);

      // 상태 줄: 사망 직업 / 투표 수 / 투표 완료
      let sub = '';
      if (!alive && role) sub = `${ROLE_ICON[role]} ${ROLE_LABEL[role]}`;
      else if ((g.stage === 'vote' || g.stage === 'execution') && p.voteCount > 0) sub = `🗳 ${p.voteCount}표`;
      else if (g.stage === 'vote' && p.voted) sub = '✓ 투표함';
      else if (alive && role && p.id !== s.myId) sub = `${ROLE_ICON[role]}`; // 마피아 동료/관전자에게 공개된 직업
      if (sub) this.ui.add(this.add.text(x, y + 46, sub, { fontSize: '10px', color: '#fbbf24' }).setOrigin(0.5));
    });

    // ── 하단 안내 + 액션 버튼 ──
    let prompt = '';
    if (s.phase === 'ended') {
      prompt = g.winner === 'mafia' ? '🔪 마피아의 승리!' : '🎉 시민의 승리!';
    } else if (!myAlive) {
      prompt = '👻 사망 — 유령 채팅으로 관전 중입니다.';
    } else
      switch (g.stage) {
        case 'night':
          if (myRole === 'mafia') prompt = myPick ? '지목 완료 — 동료와 합의하세요 (재선택 가능)' : '🔪 제거할 대상을 선택하세요';
          else if (myRole === 'police') prompt = g.policeDone ? '조사 완료 — 아침을 기다립니다' : '🕵️ 조사할 대상을 선택하세요';
          else if (myRole === 'doctor') prompt = myHeal ? '치료 대상 지정 완료 (재선택 가능)' : '💉 살릴 사람을 선택하세요 (자신 가능)';
          else prompt = '🌙 밤입니다… 조용히 아침을 기다리세요.';
          break;
        case 'day':
          prompt = `채팅으로 토론하세요! (건너뛰기 동의 ${g.skipCount ?? 0}/${g.aliveCount})`;
          break;
        case 'vote':
          prompt = myVote ? `투표 완료 (${g.votedCount}/${g.aliveCount})` : '처형할 사람을 클릭하세요';
          break;
      }
    this.ui.add(this.add.text(W / 2, H - 52, prompt, { fontSize: '13px', color: '#cbd5e1' }).setOrigin(0.5));

    if (s.phase === 'playing' && myAlive) {
      if (g.stage === 'day' && !g.mySkip) this.btn(W / 2, H - 24, 180, '⏩ 토론 건너뛰기 동의', 0x2563eb, () => this.sendAction({ kind: 'skipDay' }));
      if (g.stage === 'vote' && myVote !== 'abstain') this.btn(W / 2, H - 24, 120, '🙅 기권', 0x64748b, () => this.sendAction({ kind: 'vote', target: 'abstain' }));
    }

    // ── 아침/처형 발표 배너 ──
    if ((g.stage === 'dawn' || g.stage === 'execution') && g.reveal) {
      const r = g.reveal as { type: string; name?: string; role?: Role };
      let text = '';
      if (r.type === 'killed') text = `☠️ ${r.name}님이 살해당했습니다\n(직업: ${ROLE_ICON[r.role!]} ${ROLE_LABEL[r.role!]})`;
      else if (r.type === 'safe') text = `💉 의사가 ${r.name}님을 살려냈습니다!`;
      else if (r.type === 'peace') text = '🕊 평화로운 밤이었습니다';
      else if (r.type === 'executed') text = `⚖️ ${r.name}님이 처형되었습니다\n(직업: ${ROLE_ICON[r.role!]} ${ROLE_LABEL[r.role!]})`;
      else if (r.type === 'novote') text = '⚖️ 표가 모이지 않아\n아무도 처형되지 않았습니다';
      const bg = this.add.rectangle(W / 2, 100, W - 60, 64, 0x0f172a, 0.92).setStrokeStyle(2, 0xfacc15);
      const t = this.add.text(W / 2, 100, text, { fontSize: '15px', color: '#fde68a', align: 'center', fontStyle: 'bold' }).setOrigin(0.5);
      this.ui.add([bg, t]);
    }
  }
}
