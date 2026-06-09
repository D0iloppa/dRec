// 로비 — Phaser 씬(DOM 오버레이). 방 목록/방 만들기/접속자/내 아바타 미리보기/프로필 팝업.
// 서버 'lobby' broadcast 구독. 입장/생성은 socket emit → App의 'state' 리스너가 룸으로 전환.
import Phaser from 'phaser';
import { avatarSvg } from '../avatar';

interface LobbyData {
  rooms: { code: string; type: string; label?: string; title: string; host: string; count: number; max: number }[];
  users: { nickname: string; iq: number | null; avatar: { equipped?: Record<string, string> } | null }[];
}

export class LobbyScene extends Phaser.Scene {
  private dom!: Phaser.GameObjects.DOMElement;
  private lobbyData: LobbyData = { rooms: [], users: [] };
  private creating = false;
  private viewUser: LobbyData['users'][number] | null = null;

  private socket!: import('socket.io-client').Socket;
  private games: { type: string; label: string; minPlayers: number; maxPlayers: number }[] = [];
  private profile: any = null;

  constructor() {
    super('lobby');
  }

  create() {
    this.cameras.main.setBackgroundColor('#0b3a5b');
    this.socket = this.game.registry.get('socket');
    this.games = this.game.registry.get('games') ?? [];
    this.profile = this.game.registry.get('profile');

    this.dom = this.add.dom(this.scale.width / 2, this.scale.height / 2).createFromHTML('<div class="lobby"></div>');
    this.scale.on('resize', () => this.dom.setPosition(this.scale.width / 2, this.scale.height / 2));

    const onLobby = (d: LobbyData) => { this.lobbyData = d; this.render(); };
    this.socket.on('lobby', onLobby);
    this.events.once('shutdown', () => this.socket.off('lobby', onLobby));
    this.socket.emit('lobbyRefresh');
    this.render();
  }

  private esc(s: string) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  }

  private render() {
    const me = this.profile;
    const myAva = avatarSvg(me?.profile?.avatar?.equipped ?? {});
    const rooms = this.lobbyData.rooms;
    const users = this.lobbyData.users;

    const roomCards = rooms.length
      ? rooms.map((r) => `
        <div class="room-card" data-code="${this.esc(r.code)}">
          <div class="room-card-top"><span class="room-code">${this.esc(r.code)}</span><span class="room-type">${this.esc(r.label ?? r.type)}</span></div>
          <div class="room-title">${this.esc(r.title)}</div>
          <div class="room-card-bot"><span>👑 ${this.esc(r.host)}</span><span class="room-count">${r.count}/${r.max}</span></div>
        </div>`).join('')
      : '<div class="empty">열린 방이 없습니다. 방을 만들어보세요!</div>';

    const userItems = users.map((u, i) => `
      <li class="user-item" data-idx="${i}">
        <span class="user-ava">${avatarSvg(u.avatar?.equipped ?? {})}</span>
        <span class="user-nick">${this.esc(u.nickname)}</span>
        <span class="user-iq">IQ ${u.iq ?? '-'}</span>
      </li>`).join('');

    const createDialog = this.creating ? `
      <div class="modal-bg" id="createBg">
        <div class="modal">
          <h3>방 만들기</h3>
          <select id="cType">${this.games.map((g) => `<option value="${g.type}">${this.esc(g.label)} (${g.minPlayers}~${g.maxPlayers})</option>`).join('')}</select>
          <input id="cTitle" placeholder="방 제목 (선택)" maxlength="30">
          <div class="modal-btns"><button id="cCancel" class="btn-ghost">취소</button><button id="cMake" class="btn-primary">만들기</button></div>
        </div>
      </div>` : '';

    const profilePopup = this.viewUser ? `
      <div class="modal-bg" id="profBg">
        <div class="modal profile-modal">
          <div class="prof-ava">${avatarSvg(this.viewUser.avatar?.equipped ?? {})}</div>
          <h3>${this.esc(this.viewUser.nickname)}</h3>
          <div class="prof-iq">🧠 IQ ${this.viewUser.iq ?? '-'}</div>
          <button id="profClose" class="btn-primary">닫기</button>
        </div>
      </div>` : '';

    (this.dom.node as HTMLElement).innerHTML = `
      <div class="lobby">
        <header class="lobby-top">
          <span class="lobby-logo">🎮 DOPL</span>
          <div class="lobby-me">
            <span class="me-ava">${myAva}</span>
            <span><b>${this.esc(me?.profile?.nickname ?? '플레이어')}</b><br><small>🧠 ${me?.profile?.iq ?? '-'} · 🪙 ${me?.wallet?.coins ?? 0}</small></span>
          </div>
        </header>
        <div class="lobby-body">
          <section class="room-area">
            <div class="room-grid">${roomCards}</div>
            <button id="makeRoom" class="make-room-btn">＋ 방 만들기</button>
          </section>
          <aside class="user-area">
            <h4>접속자 (${users.length})</h4>
            <ul class="user-list">${userItems}</ul>
          </aside>
        </div>
        ${createDialog}${profilePopup}
      </div>`;
    this.wire();
  }

  private wire() {
    const node = this.dom.node as HTMLElement;
    const $ = (id: string) => node.querySelector('#' + id);

    node.querySelectorAll('.room-card').forEach((el) =>
      el.addEventListener('click', () => this.socket.emit('joinRoom', { code: (el as HTMLElement).dataset.code }))
    );
    node.querySelectorAll('.user-item').forEach((el) =>
      el.addEventListener('click', () => { this.viewUser = this.lobbyData.users[Number((el as HTMLElement).dataset.idx)]; this.render(); })
    );

    $('makeRoom')?.addEventListener('click', () => { this.creating = true; this.render(); });
    $('cCancel')?.addEventListener('click', () => { this.creating = false; this.render(); });
    $('createBg')?.addEventListener('click', (e) => { if (e.target === $('createBg')) { this.creating = false; this.render(); } });
    $('cMake')?.addEventListener('click', () => {
      const type = (node.querySelector('#cType') as HTMLSelectElement)?.value;
      const title = (node.querySelector('#cTitle') as HTMLInputElement)?.value;
      this.socket.emit('createRoom', { type, title });
      this.creating = false;
    });

    $('profClose')?.addEventListener('click', () => { this.viewUser = null; this.render(); });
    $('profBg')?.addEventListener('click', (e) => { if (e.target === $('profBg')) { this.viewUser = null; this.render(); } });
  }
}
