// 로비 — Phaser 씬(카툰 배경 + DOM 오버레이). 큐플레이 레퍼런스 구성:
// 방 목록 테이블(대기중/게임중) · 접속자 패널(LV/IQ) · 로비 전체 채팅 · 하단 기능 바(미니게임/꾸미기·상점/게임방법/EXIT).
// 골격은 1회 렌더(채팅 입력 포커스 유지), 데이터 영역만 부분 갱신.
import Phaser from 'phaser';
import { avatarSvg } from '../avatar';
import { addCartoonBackdrop } from '../backdrop';
import { levelOf } from '../level';
import { MINIGAMES, type Minigame } from '../minigames';
import * as api from '../api';

interface LobbyData {
  rooms: { code: string; type: string; label?: string; title: string; host: string; count: number; max: number; status: string }[];
  users: { nickname: string; iq: number | null; xp?: number; avatar: { equipped?: Record<string, string> } | null }[];
  chat: { name: string; text: string; ts: number }[];
}
interface ShopItem { id: number; code: string; name: string; slot: string; price: number; rarity: string }

const SLOT_TABS: [string, string][] = [
  ['body', '🧍 피부'], ['face', '🙂 표정'], ['hair', '💇 헤어'], ['top', '👕 상의'], ['acc', '🎀 소품'],
];
const RARITY_COLOR: Record<string, string> = { common: '#64748b', rare: '#2563eb', epic: '#9333ea' };

export class LobbyScene extends Phaser.Scene {
  private dom!: Phaser.GameObjects.DOMElement;
  private lobbyData: LobbyData = { rooms: [], users: [], chat: [] };
  private creating = false;
  private viewUser: LobbyData['users'][number] | null = null;
  private helpOpen = false;
  private miniList = false;
  private miniGame: Minigame | null = null;

  private socket!: import('socket.io-client').Socket;
  private games: { type: string; label: string; minPlayers: number; maxPlayers: number }[] = [];
  private profile: any = null;
  private token = '';
  private onLogout: () => void = () => {};
  private refreshProfile: () => void = () => {};

  // 꾸미기&상점 상태
  private dressOpen = false;
  private dressTab = 'body';
  private items: ShopItem[] = [];
  private owned = new Set<string>();
  private draft: Record<string, string> = {};
  private dressMsg = '';

  constructor() {
    super('lobby');
  }

  create() {
    addCartoonBackdrop(this);
    this.socket = this.game.registry.get('socket');
    this.games = this.game.registry.get('games') ?? [];
    this.profile = this.game.registry.get('profile');
    this.token = this.game.registry.get('token') ?? '';
    this.onLogout = this.game.registry.get('onLogout') ?? (() => {});
    this.refreshProfile = this.game.registry.get('refreshProfile') ?? (() => {});

    this.dom = this.add.dom(this.scale.width / 2, this.scale.height / 2).createFromHTML('<div class="lb"></div>');
    this.scale.on('resize', () => this.dom.setPosition(this.scale.width / 2, this.scale.height / 2));

    const onLobby = (d: LobbyData) => { this.lobbyData = { chat: [], ...d }; this.updateData(); };
    this.socket.on('lobby', onLobby);

    const onReg = () => {
      this.games = this.game.registry.get('games') ?? [];
      this.profile = this.game.registry.get('profile');
      this.updateData();
      if (this.dressOpen) this.renderModal();
    };
    this.game.registry.events.on('changedata-games', onReg);
    this.game.registry.events.on('changedata-profile', onReg);

    this.events.once('shutdown', () => {
      this.socket.off('lobby', onLobby);
      this.game.registry.events.off('changedata-games', onReg);
      this.game.registry.events.off('changedata-profile', onReg);
    });

    this.renderShell();
    this.socket.emit('lobbyRefresh');
    this.updateData();
  }

  private esc(s: string) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  }
  private node() {
    return this.dom.node as HTMLElement;
  }
  private $(id: string) {
    return this.node().querySelector('#' + id) as HTMLElement | null;
  }

  // ── 골격 (1회) ──────────────────────────────────────────────
  private renderShell() {
    this.node().innerHTML = `
      <div class="lb">
        <header class="lb-top">
          <span class="logo3d lb-logo">DOPL</span>
          <span class="lb-tagline">QUIZ · PLAY · GROUND</span>
          <div class="lb-actions">
            <div class="lb-me" id="lbMe"></div>
          </div>
        </header>
        <div class="lb-mid">
          <section class="lb-rooms">
            <div class="lb-rooms-head">
              <h3>🎮 게임 방</h3>
              <button id="lbMake" class="lb-btn lb-btn-green">＋ 방 만들기</button>
            </div>
            <div class="lb-table-wrap">
              <table class="lb-table">
                <thead><tr><th>상태</th><th>코드</th><th>게임</th><th>제목</th><th>방장</th><th>인원</th></tr></thead>
                <tbody id="lbRoomRows"></tbody>
              </table>
              <div id="lbNoRooms" class="lb-empty" style="display:none">열린 방이 없습니다. 첫 방을 만들어보세요!</div>
            </div>
          </section>
          <aside class="lb-users">
            <h4 id="lbUserCount">접속자</h4>
            <ul id="lbUserList" class="lb-userlist"></ul>
          </aside>
        </div>
        <footer class="lb-chatbox">
          <div id="lbChatLog" class="lb-chatlog"></div>
          <form id="lbChatForm" class="lb-chatform">
            <input id="lbChatInput" placeholder="로비 채팅… (Enter로 전송)" maxlength="300" autocomplete="off">
            <button type="submit" class="lb-btn lb-btn-green">전송</button>
          </form>
        </footer>
        <nav class="lb-bottombar">
          <button id="lbMini" class="lb-fn">🎯 미니게임</button>
          <button id="lbDress" class="lb-fn">👕 꾸미기·상점</button>
          <button id="lbHelp" class="lb-fn">📖 게임 방법</button>
          <span class="lb-spacer"></span>
          <button id="lbExit" class="lb-btn lb-btn-red lb-exit">EXIT</button>
        </nav>
        <div id="lbModal"></div>
      </div>`;

    this.$('lbExit')?.addEventListener('click', () => this.onLogout());
    this.$('lbMake')?.addEventListener('click', () => { this.creating = true; this.renderModal(); });
    this.$('lbDress')?.addEventListener('click', () => void this.openDress());
    this.$('lbMini')?.addEventListener('click', () => { this.miniList = true; this.renderModal(); });
    this.$('lbHelp')?.addEventListener('click', () => { this.helpOpen = true; this.renderModal(); });
    this.$('lbChatForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = this.$('lbChatInput') as HTMLInputElement;
      const text = input.value.trim();
      if (!text) return;
      this.socket.emit('lobbyChat', { text });
      input.value = '';
    });

    this.dom.updateSize();
    this.dom.setPosition(this.scale.width / 2, this.scale.height / 2);
  }

  // ── 데이터 영역 부분 갱신 ────────────────────────────────────
  private updateData() {
    if (!this.$('lbMe')) return;
    const me = this.profile;
    const eq = me?.profile?.avatar?.equipped ?? {};
    const lv = levelOf(me?.profile?.xp);
    this.$('lbMe')!.innerHTML = `
      <span class="lb-me-ava">${avatarSvg(eq)}</span>
      <span class="lb-me-info"><b><span class="lb-lv">Lv.${lv}</span> ${this.esc(me?.profile?.nickname ?? '플레이어')}</b>
      <small>🧠 ${me?.profile?.iq ?? '-'} · 🪙 ${me?.wallet?.coins ?? 0}</small></span>`;

    const rooms = this.lobbyData.rooms;
    const rows = rooms
      .map((r) => {
        const waiting = r.status === 'waiting';
        const full = r.count >= r.max;
        const joinable = waiting && !full;
        return `
        <tr class="${joinable ? 'joinable' : 'locked'}" data-code="${this.esc(r.code)}" data-join="${joinable ? 1 : 0}">
          <td><span class="lb-badge ${waiting ? 'wait' : 'play'}">${waiting ? (full ? '가득참' : '대기중') : '게임중'}</span></td>
          <td class="lb-code">${this.esc(r.code)}</td>
          <td>${this.esc(r.label ?? r.type)}</td>
          <td class="lb-title">${this.esc(r.title)}</td>
          <td>👑 ${this.esc(r.host)}</td>
          <td class="lb-count">${r.count}/${r.max}</td>
        </tr>`;
      })
      .join('');
    this.$('lbRoomRows')!.innerHTML = rows;
    this.$('lbNoRooms')!.style.display = rooms.length ? 'none' : 'block';
    this.node().querySelectorAll('#lbRoomRows tr[data-join="1"]').forEach((el) =>
      el.addEventListener('click', () => this.socket.emit('joinRoom', { code: (el as HTMLElement).dataset.code }))
    );

    const users = this.lobbyData.users;
    this.$('lbUserCount')!.textContent = `접속자 (${users.length})`;
    this.$('lbUserList')!.innerHTML = users
      .map(
        (u, i) => `
        <li class="lb-user" data-idx="${i}">
          <span class="lb-user-ava">${avatarSvg(u.avatar?.equipped ?? {})}</span>
          <span class="lb-user-nick">${this.esc(u.nickname)}</span>
          <span class="lb-user-meta"><span class="lb-lv">Lv.${levelOf(u.xp)}</span><span class="lb-user-iq">IQ ${u.iq ?? '-'}</span></span>
        </li>`
      )
      .join('');
    this.node().querySelectorAll('.lb-user').forEach((el) =>
      el.addEventListener('click', () => {
        this.viewUser = this.lobbyData.users[Number((el as HTMLElement).dataset.idx)] ?? null;
        this.renderModal();
      })
    );

    const log = this.$('lbChatLog')!;
    log.innerHTML = (this.lobbyData.chat ?? [])
      .map((c) => `<div class="lb-chatline"><b>${this.esc(c.name)}</b> ${this.esc(c.text)}</div>`)
      .join('');
    log.scrollTop = log.scrollHeight;

    this.dom.updateSize();
    this.dom.setPosition(this.scale.width / 2, this.scale.height / 2);
  }

  // ── 모달 (방 만들기 / 프로필 / 꾸미기&상점 / 미니게임 / 게임방법) ──
  private renderModal() {
    const host = this.$('lbModal')!;
    if (this.creating) host.innerHTML = this.createRoomHtml();
    else if (this.dressOpen) host.innerHTML = this.dressHtml();
    else if (this.miniGame) host.innerHTML = this.miniGameHtml();
    else if (this.miniList) host.innerHTML = this.miniListHtml();
    else if (this.helpOpen) host.innerHTML = this.helpHtml();
    else if (this.viewUser) host.innerHTML = this.profileHtml();
    else { host.innerHTML = ''; return; }
    this.wireModal();
    if (this.miniGame) {
      const mount = host.querySelector('#miniHost') as HTMLElement;
      if (mount) this.miniGame.mount(mount, { token: this.token, refreshProfile: this.refreshProfile });
    }
    this.dom.updateSize();
    this.dom.setPosition(this.scale.width / 2, this.scale.height / 2);
  }

  private createRoomHtml() {
    return `
      <div class="modal-bg" id="mBg">
        <div class="modal lb-modal">
          <h3>방 만들기</h3>
          <select id="cType">${this.games.map((g) => `<option value="${g.type}">${this.esc(g.label)} (${g.minPlayers}~${g.maxPlayers}명)</option>`).join('')}</select>
          <input id="cTitle" placeholder="방 제목 (선택)" maxlength="30">
          <div class="modal-btns"><button id="mCancel" class="btn-ghost">취소</button><button id="cMake" class="btn-primary">만들기</button></div>
        </div>
      </div>`;
  }

  private profileHtml() {
    const u = this.viewUser!;
    return `
      <div class="modal-bg" id="mBg">
        <div class="modal lb-modal profile-modal">
          <div class="prof-ava">${avatarSvg(u.avatar?.equipped ?? {})}</div>
          <h3><span class="lb-lv">Lv.${levelOf(u.xp)}</span> ${this.esc(u.nickname)}</h3>
          <div class="prof-iq">🧠 IQ ${u.iq ?? '-'}</div>
          <button id="mCancel" class="btn-primary">닫기</button>
        </div>
      </div>`;
  }

  private miniListHtml() {
    const cards = MINIGAMES.map(
      (m) => `
      <div class="mini-card" data-mini="${m.id}">
        <div class="mini-icon">${m.icon}</div>
        <b>${this.esc(m.name)}</b>
        <p>${this.esc(m.desc)}</p>
        <span class="mini-go">PLAY ▶</span>
      </div>`
    ).join('');
    return `
      <div class="modal-bg" id="mBg">
        <div class="mini-panel">
          <header class="dx-head"><b>🎯 미니게임</b><span class="dx-sub">혼자 즐기고, 결과는 SNS로!</span><button id="mCancel" class="dx-close">✕</button></header>
          <div class="mini-grid">
            ${cards}
            <div class="mini-card soon"><div class="mini-icon">🧩</div><b>준비 중</b><p>새 미니게임이 추가될 예정이에요.</p></div>
          </div>
        </div>
      </div>`;
  }

  private miniGameHtml() {
    const m = this.miniGame!;
    return `
      <div class="modal-bg" id="mBg">
        <div class="mini-panel">
          <header class="dx-head"><b>${m.icon} ${this.esc(m.name)}</b><button id="mCancel" class="dx-close">✕</button></header>
          <div id="miniHost" class="mini-host"></div>
        </div>
      </div>`;
  }

  private helpHtml() {
    return `
      <div class="modal-bg" id="mBg">
        <div class="mini-panel help-panel">
          <header class="dx-head"><b>📖 게임 방법</b><button id="mCancel" class="dx-close">✕</button></header>
          <div class="help-body">
            <h4>⚡ 스피드퀴즈</h4>
            <p>문제가 나오면 <b>채팅창에 정답을 타이핑</b>하세요. 가장 빨리 맞힌 사람이 +10점! 시간이 절반 지나면 초성 힌트가 공개됩니다. 10라운드 점수 합계로 순위를 가립니다.</p>
            <h4>🧠 OX 퀴즈 · 상식퀴즈</h4>
            <p>서바이벌 방식! 문제마다 답을 고르고, 틀리면 탈락합니다. 최후 생존자가 우승. (전원 오답이면 탈락 없음)</p>
            <h4>🟩 꼬들 (미니게임)</h4>
            <p>매일 바뀌는 <b>두 글자 단어</b>를 자모 단위 힌트로 6번 안에 맞히세요. 🟩 위치 일치 · 🟨 포함 · ⬛ 없음. 결과를 SNS에 공유할 수 있어요.</p>
            <h4>🧠 IQ · ⭐ 레벨</h4>
            <p>게임에서 이기면 IQ가 오릅니다 (최대 1000 — 높을수록 오르기 어려워요). 플레이할수록 XP가 쌓여 레벨이 오릅니다.</p>
          </div>
        </div>
      </div>`;
  }

  private dressHtml() {
    const coins = this.profile?.wallet?.coins ?? 0;
    const tabs = SLOT_TABS.map(
      ([slot, label]) => `<button class="dx-tab ${this.dressTab === slot ? 'on' : ''}" data-slot="${slot}">${label}</button>`
    ).join('');
    const slotItems = this.items.filter((i) => i.slot === this.dressTab);
    const cards = slotItems
      .map((it) => {
        const isOwned = this.owned.has(it.code) || it.price === 0;
        const equippedNow = this.draft[it.slot] === it.code;
        const preview = avatarSvg({ ...this.draft, [it.slot]: it.code });
        const badge = equippedNow
          ? '<span class="dx-badge on">장착중</span>'
          : isOwned
            ? '<span class="dx-badge own">보유</span>'
            : `<span class="dx-badge price">🪙 ${it.price}</span>`;
        return `
        <div class="dx-card ${equippedNow ? 'sel' : ''}" data-code="${it.code}" data-owned="${isOwned ? 1 : 0}" data-id="${it.id}">
          <div class="dx-prev">${preview}</div>
          <div class="dx-name" style="color:${RARITY_COLOR[it.rarity] ?? '#333'}">${this.esc(it.name)}</div>
          ${badge}
        </div>`;
      })
      .join('');
    return `
      <div class="modal-bg" id="mBg">
        <div class="dx">
          <header class="dx-head">
            <b>👕 꾸미기 & 상점</b>
            <span class="dx-coins">🪙 ${coins}</span>
            <button id="mCancel" class="dx-close">✕</button>
          </header>
          <div class="dx-body">
            <div class="dx-preview-pane">
              <div class="dx-big">${avatarSvg(this.draft)}</div>
              <b>${this.esc(this.profile?.profile?.nickname ?? '')}</b>
            </div>
            <div class="dx-right">
              <div class="dx-tabs">${tabs}</div>
              <div class="dx-grid">${cards || '<div class="lb-empty">아이템이 없습니다</div>'}</div>
            </div>
          </div>
          <footer class="dx-foot">
            <span class="dx-msg">${this.esc(this.dressMsg)}</span>
            <button id="dxSave" class="lb-btn lb-btn-green">저장 (장착 적용)</button>
          </footer>
        </div>
      </div>`;
  }

  private wireModal() {
    const host = this.$('lbModal')!;
    const close = () => {
      this.creating = false;
      this.viewUser = null;
      this.dressOpen = false;
      this.dressMsg = '';
      this.helpOpen = false;
      this.miniList = false;
      this.miniGame = null;
      this.renderModal();
    };
    host.querySelector('#mCancel')?.addEventListener('click', close);
    host.querySelector('#mBg')?.addEventListener('click', (e) => { if ((e.target as HTMLElement).id === 'mBg') close(); });

    host.querySelector('#cMake')?.addEventListener('click', () => {
      const type = (host.querySelector('#cType') as HTMLSelectElement)?.value;
      const title = (host.querySelector('#cTitle') as HTMLInputElement)?.value;
      this.socket.emit('createRoom', { type, title });
      close();
    });

    host.querySelectorAll('.mini-card[data-mini]').forEach((el) =>
      el.addEventListener('click', () => {
        this.miniList = false;
        this.miniGame = MINIGAMES.find((m) => m.id === (el as HTMLElement).dataset.mini) ?? null;
        this.renderModal();
      })
    );

    host.querySelectorAll('.dx-tab').forEach((el) =>
      el.addEventListener('click', () => { this.dressTab = (el as HTMLElement).dataset.slot!; this.renderModal(); })
    );
    host.querySelectorAll('.dx-card').forEach((el) =>
      el.addEventListener('click', () => void this.onItemClick(el as HTMLElement))
    );
    host.querySelector('#dxSave')?.addEventListener('click', () => void this.saveDress());
  }

  private async openDress() {
    try {
      const [cat, inv] = await Promise.all([api.getItems(), api.getInventory(this.token)]);
      this.items = cat.items;
      this.owned = new Set((inv.items as ShopItem[]).map((i) => i.code));
      this.draft = { ...(this.profile?.profile?.avatar?.equipped ?? {}) };
      this.dressOpen = true;
      this.dressMsg = '';
      this.renderModal();
    } catch (e) {
      this.dressMsg = (e as Error).message;
    }
  }

  private async onItemClick(el: HTMLElement) {
    const code = el.dataset.code!;
    const item = this.items.find((i) => i.code === code);
    if (!item) return;
    const isOwned = el.dataset.owned === '1';

    if (!isOwned) {
      if (!window.confirm(`"${item.name}" 아이템을 🪙 ${item.price}에 구매할까요?`)) return;
      try {
        await api.buyItem(this.token, item.id);
        this.owned.add(code);
        this.draft[item.slot] = code;
        this.dressMsg = `${item.name} 구매 완료!`;
        this.refreshProfile(); // 코인 갱신
      } catch (e) {
        this.dressMsg = (e as Error).message;
      }
      this.renderModal();
      return;
    }
    if (this.draft[item.slot] === code) delete this.draft[item.slot];
    else this.draft[item.slot] = code;
    this.renderModal();
  }

  private async saveDress() {
    try {
      await api.equipAvatar(this.token, this.draft);
      this.socket.emit('profileRefresh'); // 로비 접속자 목록에 반영
      this.refreshProfile();
      this.dressMsg = '저장되었습니다!';
    } catch (e) {
      this.dressMsg = (e as Error).message;
    }
    this.renderModal();
  }
}
