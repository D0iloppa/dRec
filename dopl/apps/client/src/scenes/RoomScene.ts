// 게임방 — 로비와 같은 톤의 Phaser 씬(DOM 오버레이). 대기실/진행/종료를 렌더하고,
// 진행 중엔 기존 게임 캔버스(OxScene 등)를 마운트 포인트에 중첩한다.
// 상태는 PhaserRoom이 registry로 주입('room') → 게임 재생성 없이 갱신.
import Phaser from 'phaser';
import type { RoomState } from '@dopl/protocol';
import { OxScene } from '../games/ox/OxScene';
import { CommonQuizScene } from '../games/common-quiz/CommonQuizScene';

interface DoplGameScene extends Phaser.Scene {
  sendAction: (a: unknown) => void;
  pushState: (s: RoomState) => void;
}
const GAME_SCENES: Record<string, new () => DoplGameScene> = {
  'ox-quiz': OxScene as unknown as new () => DoplGameScene,
  'common-quiz': CommonQuizScene as unknown as new () => DoplGameScene,
};

const PHASE_LABEL: Record<string, string> = { lobby: '대기실', playing: '진행 중', ended: '종료' };

export class RoomScene extends Phaser.Scene {
  private dom!: Phaser.GameObjects.DOMElement;
  private socket!: import('socket.io-client').Socket;
  private state!: RoomState;
  private games: { type: string; label: string; minPlayers: number; maxPlayers: number }[] = [];
  private onLeave!: () => void;

  // 중첩 게임 캔버스
  private gameInstance: Phaser.Game | null = null;
  private gameScene: DoplGameScene | null = null;
  private inGameRendered = false;

  constructor() {
    super('room');
  }

  create() {
    this.cameras.main.setBackgroundColor('#0b3a5b');
    this.socket = this.game.registry.get('socket');
    this.state = this.game.registry.get('room');
    this.games = this.game.registry.get('games') ?? [];
    this.onLeave = this.game.registry.get('onLeave');

    this.dom = this.add.dom(this.scale.width / 2, this.scale.height / 2).createFromHTML('<div class="room"></div>');
    this.scale.on('resize', () => this.dom.setPosition(this.scale.width / 2, this.scale.height / 2));

    const onRoom = () => { this.state = this.game.registry.get('room'); this.refresh(); };
    const onErr = () => this.showError(this.game.registry.get('roomError') as string);
    this.game.registry.events.on('changedata-room', onRoom);
    this.game.registry.events.on('changedata-roomError', onErr);
    this.events.once('shutdown', () => {
      this.game.registry.events.off('changedata-room', onRoom);
      this.game.registry.events.off('changedata-roomError', onErr);
      this.teardownGame();
    });

    this.time.addEvent({ delay: 500, loop: true, callback: () => this.tickTimer() });

    this.renderShell();
    this.refresh();
  }

  private esc(s: string) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  }

  private node() {
    return this.dom.node as HTMLElement;
  }

  // 정적 골격 1회 생성. 채팅 입력/나가기 버튼은 여기서만 wire(재렌더로 포커스 잃지 않게).
  private renderShell() {
    this.node().innerHTML = `
      <div class="room">
        <header class="room-top">
          <span class="room-head"><b id="rGame"></b> · <span id="rCode"></span></span>
          <span class="room-phase"><span id="rPhase"></span><span id="rTimer" class="timer"></span></span>
        </header>
        <div id="rErr" class="room-err" style="display:none"></div>
        <div class="room-body">
          <main id="rMain" class="room-main"></main>
          <aside class="room-side">
            <h4>채팅</h4>
            <div id="rChatLog" class="chatlog"></div>
            <form id="rChatForm" class="chatform"><input id="rChatInput" placeholder="메시지…" autocomplete="off"><button type="submit">전송</button></form>
          </aside>
        </div>
        <button id="rLeave" class="room-leave">나가기</button>
      </div>`;

    const n = this.node();
    n.querySelector('#rChatForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = n.querySelector('#rChatInput') as HTMLInputElement;
      const text = input.value.trim();
      if (!text) return;
      this.socket.emit('chat', { text });
      input.value = '';
    });
    n.querySelector('#rLeave')?.addEventListener('click', () => this.onLeave?.());

    this.dom.updateSize();
    this.dom.setPosition(this.scale.width / 2, this.scale.height / 2);
  }

  private showError(msg: string) {
    const el = this.node().querySelector('#rErr') as HTMLElement;
    if (!el) return;
    if (msg) { el.textContent = msg; el.style.display = 'block'; }
    else { el.style.display = 'none'; }
  }

  private tickTimer() {
    const el = this.node()?.querySelector('#rTimer') as HTMLElement;
    if (!el) return;
    const endsAt = this.state?.timerEndsAt;
    if (!endsAt) { el.textContent = ''; return; }
    el.textContent = ' ⏳ ' + Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)) + 's';
  }

  private refresh() {
    const s = this.state;
    const n = this.node();
    const meta = this.games.find((g) => g.type === s.type);

    (n.querySelector('#rGame') as HTMLElement).textContent = meta?.label ?? s.type;
    (n.querySelector('#rCode') as HTMLElement).textContent = s.code;
    (n.querySelector('#rPhase') as HTMLElement).textContent = PHASE_LABEL[s.phase] ?? s.phase;
    this.tickTimer();

    const main = n.querySelector('#rMain') as HTMLElement;
    if (s.phase === 'lobby') {
      if (this.inGameRendered) { this.teardownGame(); this.inGameRendered = false; }
      this.renderWaiting(main, meta);
    } else {
      this.renderInGame(main, s);
    }

    // 채팅 로그 (입력/폼은 건드리지 않음)
    const log = n.querySelector('#rChatLog') as HTMLElement;
    log.innerHTML = s.chat.map((c) => `<div class="chatline"><b>${this.esc(c.name)}</b> ${this.esc(c.text)}</div>`).join('');
    log.scrollTop = log.scrollHeight;

    this.dom.updateSize();
    this.dom.setPosition(this.scale.width / 2, this.scale.height / 2);
  }

  private renderWaiting(main: HTMLElement, meta?: { minPlayers: number }) {
    const s = this.state;
    const isHost = s.hostId === s.myId;
    const players = s.players
      .map((p) => `<li class="${p.connected ? '' : 'off'}">${this.esc(p.name)} ${p.isHost ? '👑' : ''}</li>`)
      .join('');
    main.innerHTML = `
      <div class="room-card">
        <h3>참가자 (${s.players.length})</h3>
        <ul class="players">${players}</ul>
        ${isHost
          ? `<button id="rStart" class="room-start-btn">게임 시작 (${meta?.minPlayers ?? 2}명 이상)</button>`
          : `<p class="muted">호스트가 시작하기를 기다리는 중…</p>`}
      </div>`;
    main.querySelector('#rStart')?.addEventListener('click', () => this.socket.emit('start'));
  }

  private renderInGame(main: HTMLElement, s: RoomState) {
    const hasScene = !!GAME_SCENES[s.type];
    if (!this.inGameRendered) {
      main.innerHTML = hasScene
        ? `<div class="game-pane"><div id="gameMount" class="game-mount"></div><div class="game-log"><h4>진행</h4><div id="gameLogList"></div></div></div>`
        : `<div class="empty">이 게임의 화면은 아직 준비 중입니다. (type: ${this.esc(s.type)})</div>`;
      this.inGameRendered = true;
      if (hasScene) this.mountGame(s.type);
    }
    if (!hasScene) return;
    this.gameScene?.pushState(s);
    const logList = main.querySelector('#gameLogList') as HTMLElement | null;
    if (logList) {
      logList.innerHTML = (((s.game as any).log as string[]) || []).map((l) => `<div class="logline">${this.esc(l)}</div>`).join('');
    }
  }

  private mountGame(type: string) {
    const mount = this.node().querySelector('#gameMount') as HTMLElement;
    const SceneClass = GAME_SCENES[type];
    if (!mount || !SceneClass) return;
    const scene = new SceneClass();
    scene.sendAction = (a: unknown) => this.socket.emit('action', a);
    this.gameScene = scene;
    this.gameInstance = new Phaser.Game({
      type: Phaser.AUTO,
      parent: mount,
      width: 560,
      height: 420,
      backgroundColor: '#0f172a',
      scene,
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_HORIZONTALLY },
    });
    scene.pushState(this.state);
  }

  private teardownGame() {
    if (this.gameInstance) {
      this.gameInstance.destroy(true);
      this.gameInstance = null;
      this.gameScene = null;
    }
  }
}
