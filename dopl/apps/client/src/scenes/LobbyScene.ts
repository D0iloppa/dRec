// 로비 — Phaser 씬(카툰 배경 + DOM 오버레이). 큐플레이 레퍼런스 구성:
// 방 목록 테이블(대기중/게임중) · 접속자 패널(LV/IQ) · 로비 전체 채팅 · 하단 기능 바(미니게임/꾸미기·상점/게임방법/EXIT).
// 골격은 1회 렌더(채팅 입력 포커스 유지), 데이터 영역만 부분 갱신.
import Phaser from 'phaser';
import { avatarImgHtml } from '../avatarRender';
import { addCartoonBackdrop } from '../backdrop';
import { levelOf } from '../level';
import { MINIGAMES, type Minigame } from '../minigames';
import { bgm } from '../bgm';
import { profileCardHtml } from '../profileCard';
import * as api from '../api';

interface LobbyData {
  rooms: { code: string; type: string; label?: string; title: string; host: string; count: number; max: number; status: string }[];
  users: { nickname: string; iq: number | null; xp?: number; avatar: { equipped?: Record<string, string> } | null }[];
  chat: { name: string; text: string; ts: number }[];
}
// 게임 카탈로그 카드 설명 (키비주얼: /games/<type>.png)
const GAME_DESC: Record<string, string> = {
  'ox-quiz': 'O? X? 골라서 살아남는 서바이벌 퀴즈',
  'common-quiz': '4지선다 상식 퀴즈 — 틀리면 탈락!',
  'speed-quiz': '채팅 타이핑 선착 정답! 초성 힌트까지',
  'mafia': '밤과 낮, 거짓말쟁이를 찾아라',
  'bang': '서부 총잡이 정체 추리 — 보안관·무법자·배신자',
  'splendor': '보석을 모아 개발카드·귀족으로 명성 15점 선점',
  'liar': '제시어를 모르는 라이어를 힌트로 색출하라',
  'onecard': '같은 무늬·숫자로 손패를 먼저 비워라 (공격·스킵·방향)',
  'poker': '텍사스 홀덤 — 블러프와 베팅의 심리전',
  'puyo': '실시간 1:1 블록 퍼즐 — 연쇄로 상대를 방해뿌요로 묻어라',
};

export class LobbyScene extends Phaser.Scene {
  private dom!: Phaser.GameObjects.DOMElement;
  private lobbyData: LobbyData = { rooms: [], users: [], chat: [] };
  private creating = false;
  private createType = '';
  private viewUser: LobbyData['users'][number] | null = null;
  private helpOpen = false;
  private jukeOpen = false;
  private friendsOpen = false;
  private friendsData: { friends: any[]; received: any[]; sent: any[] } | null = null;
  private friendsMsg = '';
  private miniList = false;
  private miniGame: Minigame | null = null;

  private socket!: import('socket.io-client').Socket;
  private games: { type: string; label: string; minPlayers: number; maxPlayers: number }[] = [];
  private profile: any = null;
  private token = '';
  private onLogout: () => void = () => {};
  private refreshProfile: () => void = () => {};

  constructor() {
    super('lobby');
  }

  create() {
    addCartoonBackdrop(this);
    bgm.play('lobby');
    this.socket = this.game.registry.get('socket');
    this.games = this.game.registry.get('games') ?? [];
    this.profile = this.game.registry.get('profile');
    this.token = this.game.registry.get('token') ?? '';
    this.onLogout = this.game.registry.get('onLogout') ?? (() => {});
    this.refreshProfile = this.game.registry.get('refreshProfile') ?? (() => {});

    this.dom = this.add.dom(this.scale.width / 2, this.scale.height / 2).createFromHTML('<div class="lb"></div>');
    this.scale.on('resize', () => this.dom.setPosition(this.scale.width / 2, this.scale.height / 2));

    const onLobby = (d: LobbyData) => { this.lobbyData = { ...d, chat: d.chat ?? [] }; this.updateData(); };
    this.socket.on('lobby', onLobby);

    const onReg = () => {
      this.games = this.game.registry.get('games') ?? [];
      this.profile = this.game.registry.get('profile');
      this.updateData();
    };
    this.game.registry.events.on('changedata-games', onReg);
    this.game.registry.events.on('changedata-profile', onReg);

    this.events.once('shutdown', () => {
      this.socket.off('lobby', onLobby);
      this.game.registry.events.off('changedata-games', onReg);
      this.game.registry.events.off('changedata-profile', onReg);
    });

    this.time.addEvent({ delay: 500, loop: true, callback: () => this.updateJuke() });
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
              <form id="lbJoinForm" class="lb-joincode">
                <input id="lbCode" placeholder="방 코드" maxlength="4" autocomplete="off" spellcheck="false">
                <button type="submit" class="lb-btn lb-btn-amber">입장</button>
              </form>
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
          <button id="lbShop" class="lb-fn">🛍 상점</button>
          <button id="lbDressRoom" class="lb-fn">👗 분장실</button>
          <button id="lbFriends" class="lb-fn">👥 친구</button>
          <button id="lbPet" class="lb-fn">🐾 펫</button>
          <button id="lbJuke" class="lb-fn">🎵 쥬크박스</button>
          <button id="lbHelp" class="lb-fn">📖 게임 방법</button>
          <button id="lbBgm" class="lb-fn">${bgm.enabled() ? '🔊 음악 켬' : '🔇 음악 끔'}</button>
          <span class="lb-spacer"></span>
          <button id="lbExit" class="lb-btn lb-btn-red lb-exit">EXIT</button>
        </nav>
        <div id="lbModal"></div>
      </div>`;

    this.$('lbExit')?.addEventListener('click', () => this.onLogout());
    this.$('lbMake')?.addEventListener('click', () => {
      this.creating = true;
      this.createType = this.games[0]?.type ?? '';
      this.renderModal();
    });
    // 코드로 입장 — 4자리 방 코드 직접 입력 (성공 시 서버가 'state' push → 방 진입, 실패는 placeholder로 안내)
    this.$('lbJoinForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = this.$('lbCode') as HTMLInputElement | null;
      const code = input?.value.trim().toUpperCase() ?? '';
      if (!code) return;
      this.socket.emit('joinRoom', { code }, (res?: { ok: boolean; error?: string }) => {
        if (input) input.value = '';
        if (res && !res.ok && input) input.placeholder = res.error ?? '입장 실패';
      });
    });
    this.$('lbCode')?.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      t.value = t.value.toUpperCase();
    });
    this.$('lbShop')?.addEventListener('click', () => this.scene.start('shop'));
    this.$('lbDressRoom')?.addEventListener('click', () => this.scene.start('dress'));
    this.$('lbMini')?.addEventListener('click', () => { this.miniList = true; this.renderModal(); });
    this.$('lbJuke')?.addEventListener('click', () => { this.jukeOpen = true; this.renderModal(); });
    this.$('lbFriends')?.addEventListener('click', () => void this.openFriends());
    this.$('lbPet')?.addEventListener('click', () => this.scene.start('pet'));
    this.$('lbHelp')?.addEventListener('click', () => { this.helpOpen = true; this.renderModal(); });
    this.$('lbBgm')?.addEventListener('click', () => {
      const on = bgm.toggle();
      const btn = this.$('lbBgm');
      if (btn) btn.textContent = on ? '🔊 음악 켬' : '🔇 음악 끔';
    });
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
    const lv = levelOf(me?.profile?.xp);
    this.$('lbMe')!.innerHTML = `
      <span class="lb-me-ava">${avatarImgHtml(me?.profile?.avatar ?? {})}</span>
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
          <span class="lb-user-ava">${avatarImgHtml(u.avatar ?? {})}</span>
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
    else if (this.miniGame) host.innerHTML = this.miniGameHtml();
    else if (this.miniList) host.innerHTML = this.miniListHtml();
    else if (this.jukeOpen) host.innerHTML = this.jukeHtml();
    else if (this.friendsOpen) host.innerHTML = this.friendsHtml();
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

  // 방 만들기 — 게임 카탈로그. 3열×2행(6개)을 한 페이지로, 게임이 늘면 페이지를 추가(점/화살표/스와이프).
  private createRoomHtml() {
    const PER_PAGE = 6;
    const card = (g: { type: string; label: string; minPlayers: number; maxPlayers: number }) => `
        <div class="gc-card ${this.createType === g.type ? 'sel' : ''}" data-type="${g.type}">
          <div class="gc-img"><img src="/games/${g.type}.png" alt="" draggable="false" onerror="if(!this.dataset.svg){this.dataset.svg='1';this.src='/games/${g.type}.svg';}else{this.parentElement.classList.add('noimg');}"></div>
          <div class="gc-info">
            <b>${this.esc(g.label)}</b>
            <small>${this.esc(GAME_DESC[g.type] ?? '')}</small>
            <span class="gc-players">👥 ${g.minPlayers}~${g.maxPlayers}명</span>
          </div>
          <span class="gc-check">✔</span>
        </div>`;
    const pageCount = Math.max(1, Math.ceil(this.games.length / PER_PAGE));
    const pages = Array.from({ length: pageCount }, (_, i) =>
      `<div class="gc-page">${this.games.slice(i * PER_PAGE, i * PER_PAGE + PER_PAGE).map(card).join('')}</div>`
    ).join('');
    const multi = pageCount > 1;
    const nav = multi
      ? `<button class="gc-nav gc-prev" id="gcPrev" aria-label="이전" style="visibility:hidden">‹</button><button class="gc-nav gc-next" id="gcNext" aria-label="다음">›</button>`
      : '';
    const dots = multi
      ? `<div class="gc-dots">${Array.from({ length: pageCount }, (_, i) => `<button class="gc-dot${i === 0 ? ' on' : ''}" data-page="${i}" aria-label="${i + 1}페이지"></button>`).join('')}</div>`
      : '';
    return `
      <div class="modal-bg" id="mBg">
        <div class="mini-panel gamecat-panel">
          <header class="dx-head"><b>🎮 방 만들기</b><span class="dx-sub">어떤 게임으로 모일까요?</span><button id="mCancel" class="dx-close">✕</button></header>
          <div class="gc-railwrap">${nav}<div class="gc-pages" id="gcPages">${pages}</div></div>
          ${dots}
          <footer class="dx-foot gc-foot">
            <input id="cTitle" placeholder="방 제목 (선택)" maxlength="30">
            <button id="cMake" class="lb-btn lb-btn-green">이 게임으로 방 만들기</button>
          </footer>
        </div>
      </div>`;
  }

  private profileHtml() {
    const u = this.viewUser!;
    const isMe = u.nickname === this.profile?.profile?.nickname;
    return `
      <div class="modal-bg" id="mBg">
        <div class="modal lb-modal profile-modal">
          ${profileCardHtml({ nickname: u.nickname, iq: u.iq, xp: u.xp, avatar: u.avatar })}
          <div class="modal-btns">
            ${isMe ? '' : `<button id="pAddFr" class="btn-ghost" data-nick="${this.esc(u.nickname)}">➕ 친구 요청</button>`}
            <button id="mCancel" class="btn-primary">닫기</button>
          </div>
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

  // 친구 — 목록/받은·보낸 요청/닉네임으로 추가
  private async openFriends() {
    this.friendsOpen = true;
    this.friendsMsg = '';
    try {
      this.friendsData = await api.getFriends(this.token);
    } catch (e) {
      this.friendsData = null;
      this.friendsMsg = (e as Error).message;
    }
    this.renderModal();
  }

  private friendsHtml() {
    const d = this.friendsData ?? { friends: [], received: [], sent: [] };
    const friendRow = (f: any) => `
      <div class="fr-row">
        <span class="fr-ava">${avatarImgHtml(f.avatar ?? {})}</span>
        <span class="fr-dot ${f.online ? 'on' : ''}"></span>
        <span class="fr-nick"><span class="lb-lv">Lv.${levelOf(f.xp)}</span> ${this.esc(f.nickname)}</span>
        <button class="fr-btn fr-del" data-nick="${this.esc(f.nickname)}">삭제</button>
      </div>`;
    const recvRow = (f: any) => `
      <div class="fr-row">
        <span class="fr-ava">${avatarImgHtml(f.avatar ?? {})}</span>
        <span class="fr-nick">${this.esc(f.nickname)}</span>
        <button class="fr-btn fr-accept" data-nick="${this.esc(f.nickname)}">수락</button>
        <button class="fr-btn fr-decline" data-nick="${this.esc(f.nickname)}">거절</button>
      </div>`;
    const sentRow = (f: any) => `
      <div class="fr-row">
        <span class="fr-ava">${avatarImgHtml(f.avatar ?? {})}</span>
        <span class="fr-nick">${this.esc(f.nickname)}</span>
        <span class="fr-wait">대기 중…</span>
        <button class="fr-btn fr-del" data-nick="${this.esc(f.nickname)}">취소</button>
      </div>`;
    return `
      <div class="modal-bg" id="mBg">
        <div class="mini-panel fr-panel">
          <header class="dx-head"><b>👥 친구</b><button id="mCancel" class="dx-close">✕</button></header>
          <div class="fr-body">
            <form id="frAddForm" class="fr-add">
              <input id="frAddInput" placeholder="친구 닉네임 입력" maxlength="20" autocomplete="off">
              <button type="submit" class="lb-btn lb-btn-green">➕ 친구 요청</button>
            </form>
            <div class="dx-msg">${this.esc(this.friendsMsg)}</div>
            ${d.received.length ? `<h4>📥 받은 요청 (${d.received.length})</h4>${d.received.map(recvRow).join('')}` : ''}
            <h4>친구 (${d.friends.length})</h4>
            ${d.friends.map(friendRow).join('') || '<div class="lb-empty">아직 친구가 없어요. 닉네임으로 요청해 보세요!</div>'}
            ${d.sent.length ? `<h4>📤 보낸 요청 (${d.sent.length})</h4>${d.sent.map(sentRow).join('')}` : ''}
          </div>
        </div>
      </div>`;
  }

  // 쥬크박스 — 레코드판 플레이어 + OST 리스트 (커버: /bgm/cover/<key>.jpg, 영상 첫 프레임)
  private jukeHtml() {
    const cur = bgm.current();
    const meta = bgm.list().find((t) => t.key === cur) ?? bgm.list()[0];
    const rows = bgm
      .list()
      .map(
        (t) => `
        <div class="juke-row ${cur === t.key ? 'on' : ''}" data-key="${t.key}">
          <input type="checkbox" class="juke-chk" data-key="${t.key}">
          <img class="juke-thumb" src="/bgm/cover/${t.key}.jpg" alt="" onerror="this.style.visibility='hidden'">
          <div class="juke-info"><b>${this.esc(t.title)}</b><small>${this.esc(t.desc)}</small></div>
          <button class="juke-play lb-btn lb-btn-green" data-key="${t.key}">▶</button>
        </div>`
      )
      .join('');
    return `
      <div class="modal-bg" id="mBg">
        <div class="mini-panel juke-panel">
          <header class="dx-head"><b>🎵 쥬크박스</b><span class="dx-sub">DOPL OST — 골라 듣는 배경음악</span><button id="mCancel" class="dx-close">✕</button></header>
          <div class="jk-player">
            <img id="jkCover" class="jk-cover" src="/bgm/cover/${meta?.key ?? 'main'}.jpg" alt="">
            <div class="jk-vinyl-wrap">
              <div id="jkVinyl" class="jk-vinyl ${bgm.paused() ? '' : 'spin'}">
                <img id="jkVinylCover" src="/bgm/cover/${meta?.key ?? 'main'}.jpg" alt="">
              </div>
              <div class="jk-tonearm"></div>
            </div>
            <div class="jk-meta">
              <b id="jkTitle">${this.esc(meta?.title ?? '')}</b>
              <small id="jkDesc">${this.esc(meta?.desc ?? '')}</small>
              <div class="jk-progress"><div id="jkBar" class="jk-bar"></div></div>
              <div class="jk-ctrl-row">
                <span id="jkTime" class="jk-time">0:00</span>
                <div class="jk-ctrls">
                  <button id="jkPrev" class="jk-btn">⏮</button>
                  <button id="jkPlay" class="jk-btn jk-btn-main">${bgm.paused() ? '▶' : '⏸'}</button>
                  <button id="jkNext" class="jk-btn">⏭</button>
                </div>
                <span id="jkDur" class="jk-time">0:00</span>
              </div>
            </div>
          </div>
          <div class="juke-list">${rows || '<div class="lb-empty">트랙 정보를 불러오지 못했어요</div>'}</div>
          <footer class="dx-foot">
            <button id="jukeQueue" class="lb-btn lb-btn-amber">☑ 선택한 곡 이어듣기</button>
            <button id="jukeStop" class="lb-btn lb-btn-green">로비 음악으로 돌아가기</button>
          </footer>
        </div>
      </div>`;
  }

  // 쥬크박스 부분 갱신 — 진행바/회전/현재 곡 표시 (체크박스 보존 위해 재렌더 없이)
  private updateJuke() {
    if (!this.jukeOpen) return;
    const host = this.$('lbModal');
    if (!host || !host.querySelector('.jk-player')) return;
    const cur = bgm.current();
    const meta = bgm.list().find((t) => t.key === cur);
    const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const { t, d } = bgm.progress();
    const set = (id: string, fn: (el: HTMLElement) => void) => {
      const el = host.querySelector('#' + id) as HTMLElement | null;
      if (el) fn(el);
    };
    set('jkBar', (el) => { el.style.width = d ? `${(t / d) * 100}%` : '0%'; });
    set('jkTime', (el) => { el.textContent = fmt(t); });
    set('jkDur', (el) => { el.textContent = d ? fmt(d) : '-:--'; });
    set('jkPlay', (el) => { el.textContent = bgm.paused() ? '▶' : '⏸'; });
    set('jkVinyl', (el) => el.classList.toggle('spin', !bgm.paused()));
    if (meta) {
      set('jkTitle', (el) => { el.textContent = meta.title; });
      set('jkDesc', (el) => { el.textContent = meta.desc; });
      set('jkCover', (el) => { const src = `/bgm/cover/${meta.key}.jpg`; if (!(el as HTMLImageElement).src.endsWith(src)) (el as HTMLImageElement).src = src; });
      set('jkVinylCover', (el) => { const src = `/bgm/cover/${meta.key}.jpg`; if (!(el as HTMLImageElement).src.endsWith(src)) (el as HTMLImageElement).src = src; });
    }
    host.querySelectorAll('.juke-row').forEach((el) =>
      el.classList.toggle('on', (el as HTMLElement).dataset.key === cur)
    );
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

  private wireModal() {
    const host = this.$('lbModal')!;
    const close = () => {
      this.creating = false;
      this.viewUser = null;
      this.helpOpen = false;
      this.jukeOpen = false;
      this.friendsOpen = false;
      this.friendsMsg = '';
      this.miniList = false;
      this.miniGame = null;
      this.renderModal();
    };
    host.querySelector('#mCancel')?.addEventListener('click', close);
    host.querySelector('#mBg')?.addEventListener('click', (e) => { if ((e.target as HTMLElement).id === 'mBg') close(); });

    // 카탈로그 카드 선택 — 제목 입력 보존 위해 재렌더 없이 클래스만 갱신
    host.querySelectorAll('.gc-card').forEach((el) =>
      el.addEventListener('click', () => {
        this.createType = (el as HTMLElement).dataset.type!;
        host.querySelectorAll('.gc-card').forEach((c) =>
          c.classList.toggle('sel', (c as HTMLElement).dataset.type === this.createType)
        );
      })
    );
    host.querySelector('#cMake')?.addEventListener('click', () => {
      const title = (host.querySelector('#cTitle') as HTMLInputElement)?.value;
      this.socket.emit('createRoom', { type: this.createType, title });
      close();
    });

    // 카탈로그 페이지네이션 — 점/화살표/휠/스와이프로 페이지 이동
    const pages = host.querySelector('#gcPages') as HTMLElement | null;
    if (pages && pages.children.length > 1) {
      const dotEls = [...host.querySelectorAll('.gc-dot')] as HTMLElement[];
      const prev = host.querySelector('#gcPrev') as HTMLElement | null;
      const next = host.querySelector('#gcNext') as HTMLElement | null;
      const last = pages.children.length - 1;
      const cur = () => (pages.clientWidth ? Math.round(pages.scrollLeft / pages.clientWidth) : 0);
      const sync = () => {
        const p = cur();
        dotEls.forEach((d, i) => d.classList.toggle('on', i === p));
        if (prev) prev.style.visibility = p <= 0 ? 'hidden' : 'visible';
        if (next) next.style.visibility = p >= last ? 'hidden' : 'visible';
      };
      const go = (p: number) => pages.scrollTo({ left: Math.max(0, Math.min(last, p)) * pages.clientWidth, behavior: 'smooth' });
      pages.addEventListener('scroll', sync);
      dotEls.forEach((d) => d.addEventListener('click', () => go(Number(d.dataset.page))));
      prev?.addEventListener('click', () => go(cur() - 1));
      next?.addEventListener('click', () => go(cur() + 1));
      pages.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { pages.scrollLeft += e.deltaY; e.preventDefault(); }
      }, { passive: false });
      setTimeout(sync, 0);
    }

    // 프로필 카드의 친구 요청 버튼
    const pAdd = host.querySelector('#pAddFr') as HTMLButtonElement | null;
    pAdd?.addEventListener('click', () => {
      api.friendRequest(this.token, pAdd.dataset.nick!)
        .then((r) => { pAdd.textContent = r.accepted ? '✅ 친구가 됐어요!' : '✅ 요청 보냄'; pAdd.disabled = true; })
        .catch((err) => { pAdd.textContent = err.message; pAdd.disabled = true; });
    });

    // 친구 — 요청/수락/거절/삭제 후 목록 갱신
    const reloadFriends = () => void this.openFriends();
    host.querySelector('#frAddForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = host.querySelector('#frAddInput') as HTMLInputElement;
      const nickname = input.value.trim();
      if (!nickname) return;
      api.friendRequest(this.token, nickname)
        .then((r) => { this.friendsMsg = r.accepted ? '서로 요청해서 바로 친구가 됐어요!' : '요청을 보냈습니다!'; reloadFriends(); })
        .catch((err) => { this.friendsMsg = err.message; this.renderModal(); });
    });
    host.querySelectorAll('.fr-accept').forEach((el) =>
      el.addEventListener('click', () =>
        api.friendAccept(this.token, (el as HTMLElement).dataset.nick!).then(reloadFriends).catch(() => {}))
    );
    host.querySelectorAll('.fr-decline').forEach((el) =>
      el.addEventListener('click', () =>
        api.friendDecline(this.token, (el as HTMLElement).dataset.nick!).then(reloadFriends).catch(() => {}))
    );
    host.querySelectorAll('.fr-del').forEach((el) =>
      el.addEventListener('click', () =>
        api.friendRemove(this.token, (el as HTMLElement).dataset.nick!).then(reloadFriends).catch(() => {}))
    );

    // 쥬크박스 — 플레이어 컨트롤 + 단곡/이어듣기
    host.querySelectorAll('.juke-play').forEach((el) =>
      el.addEventListener('click', () => { bgm.play((el as HTMLElement).dataset.key!); this.updateJuke(); })
    );
    host.querySelectorAll('.juke-row .juke-thumb, .juke-row .juke-info').forEach((el) =>
      el.addEventListener('click', () => { bgm.play((el.closest('.juke-row') as HTMLElement).dataset.key!); this.updateJuke(); })
    );
    host.querySelector('#jkPlay')?.addEventListener('click', () => {
      if (bgm.paused()) bgm.resume();
      else bgm.pause();
      this.updateJuke();
    });
    host.querySelector('#jkPrev')?.addEventListener('click', () => { bgm.step(-1); this.updateJuke(); });
    host.querySelector('#jkNext')?.addEventListener('click', () => { bgm.step(1); this.updateJuke(); });
    host.querySelector('#jukeQueue')?.addEventListener('click', () => {
      const keys = [...host.querySelectorAll('.juke-chk:checked')].map((el) => (el as HTMLElement).dataset.key!);
      if (keys.length) {
        bgm.playList(keys);
        this.updateJuke();
      }
    });
    host.querySelector('#jukeStop')?.addEventListener('click', () => {
      bgm.play('lobby');
      this.updateJuke();
    });

    host.querySelectorAll('.mini-card[data-mini]').forEach((el) =>
      el.addEventListener('click', () => {
        this.miniList = false;
        this.miniGame = MINIGAMES.find((m) => m.id === (el as HTMLElement).dataset.mini) ?? null;
        this.renderModal();
      })
    );

  }

}
