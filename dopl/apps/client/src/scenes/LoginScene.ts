// 로그인/회원가입 — Phaser 씬. 배경(하늘·구름)·로고는 Phaser로 렌더,
// 입력 폼/버튼은 Phaser DOM 오버레이(CSS 재사용). 이후 로비/룸도 씬으로 전환 예정.
import Phaser from 'phaser';
import { bgm } from '../bgm';

type Mode = 'login' | 'signup';

export class LoginScene extends Phaser.Scene {
  private dom!: Phaser.GameObjects.DOMElement;
  private mode: Mode = 'login';

  constructor() {
    super('login');
  }

  create() {
    this.cameras.main.setBackgroundColor('#7ec8ff');
    this.buildClouds();
    bgm.play('main'); // 메인 BGM은 로그인 화면 전용

    // 로고+폼을 하나의 DOM 컬럼으로 묶어 화면 중앙에 배치(넘치면 스크롤).
    this.dom = this.add.dom(this.scale.width / 2, this.scale.height / 2).createFromHTML('<div class="auth-dom"></div>');
    this.render();

    this.scale.on('resize', this.reposition, this);
  }

  private buildClouds() {
    const W = this.scale.width;
    const H = this.scale.height;
    const specs: [number, number, number][] = [
      [W * 0.15, H * 0.18, 60], [W * 0.82, H * 0.26, 44], [W * 0.22, H * 0.82, 40], [W * 0.85, H * 0.78, 54],
    ];
    for (const [x, y, r] of specs) {
      const c = this.add.container(x, y);
      c.add([
        this.add.ellipse(0, 0, r * 2.4, r, 0xffffff, 0.9),
        this.add.ellipse(-r * 0.7, -r * 0.3, r * 1.2, r * 1.1, 0xffffff, 0.9),
        this.add.ellipse(r * 0.7, -r * 0.2, r, r * 0.9, 0xffffff, 0.9),
      ]);
      this.tweens.add({ targets: c, x: x + 26, yoyo: true, repeat: -1, duration: 7000 + r * 70, ease: 'Sine.easeInOut' });
    }
  }

  private reposition() {
    this.dom.setPosition(this.scale.width / 2, this.scale.height / 2);
  }

  private oauthHTML() {
    return `<div class="oauth-row">
      <div class="oauth-divider"><span>소셜 계정으로 시작</span></div>
      <a class="oauth-btn oauth-google" href="/auth/oauth/google/start"><span class="oauth-ico">G</span>Google로 계속하기</a>
      <a class="oauth-btn oauth-kakao" href="/auth/oauth/kakao/start"><span class="oauth-ico">K</span>카카오로 계속하기</a>
      <a class="oauth-btn oauth-naver" href="/auth/oauth/naver/start"><span class="oauth-ico">N</span>네이버로 계속하기</a>
    </div>`;
  }

  private render() {
    const form =
      this.mode === 'login'
        ? `<form id="loginForm" class="login-panel">
             <div class="panel-fields">
               <label class="field"><span class="field-ico">🆔</span><input id="u" placeholder="아이디" autocomplete="username"></label>
               <label class="field"><span class="field-ico">🔒</span><input id="p" type="password" placeholder="비밀번호" autocomplete="current-password"></label>
             </div>
             <button class="go-btn" type="submit">▶</button>
           </form>
           ${this.oauthHTML()}
           <div class="auth-links">계정이 없으신가요? <span id="toSignup">회원가입</span></div>`
        : `<form id="signupForm" class="signup-card">
             <h2>🎮 회원가입</h2>
             <label class="field"><span class="field-ico">🆔</span><input id="u" placeholder="아이디"></label>
             <label class="field"><span class="field-ico">🔒</span><input id="p" type="password" placeholder="비밀번호 (4자 이상)"></label>
             <label class="field"><span class="field-ico">✅</span><input id="p2" type="password" placeholder="비밀번호 확인"></label>
             <label class="field"><span class="field-ico">🙂</span><input id="nick" placeholder="닉네임 (선택)" maxlength="20"></label>
             <div class="gender-pick">
               <span class="gender-label">캐릭터 선택 (변경 불가)</span>
               <div class="gender-btns">
                 <button type="button" id="gM" class="gender-btn on">🙎 남자</button>
                 <button type="button" id="gF" class="gender-btn">🙎‍♀️ 여자</button>
               </div>
             </div>
             <button class="signup-btn" type="submit">가입하기</button>
           </form>
           ${this.oauthHTML()}
           <div class="auth-links">이미 계정이 있으신가요? <span id="toLogin">로그인</span></div>`;

    (this.dom.node as HTMLElement).innerHTML = `<div class="auth-dom">
        <div class="logo3d">DOPL</div>
        <div class="logo-sub">doil&nbsp;playground</div>
        <div id="err" class="auth-error" style="display:none"></div>${form}
        <div class="auth-links"><span id="bgmToggle" class="muted-link">${bgm.enabled() ? '🔊 배경음악 켬' : '🔇 배경음악 끔'}</span></div></div>`;
    // innerHTML 변경 후 크기 재계산 → origin(0.5) 기준 수직 중앙정렬
    this.dom.updateSize();
    this.dom.setPosition(this.scale.width / 2, this.scale.height / 2);
    this.wire();
  }

  private wire() {
    const node = this.dom.node as HTMLElement;
    const sel = <T extends HTMLElement>(id: string) => node.querySelector('#' + id) as T | null;
    const errEl = sel<HTMLDivElement>('err')!;
    const showErr = (m: string) => { errEl.textContent = m; errEl.style.display = 'block'; };

    const api = this.game.registry.get('api') as typeof import('../api');
    const onAuth = this.game.registry.get('onAuth') as (t: string) => void;

    sel('toSignup')?.addEventListener('click', () => { this.mode = 'signup'; this.render(); });
    sel('toLogin')?.addEventListener('click', () => { this.mode = 'login'; this.render(); });
    sel('bgmToggle')?.addEventListener('click', () => {
      const on = bgm.toggle();
      const el = sel('bgmToggle');
      if (el) el.textContent = on ? '🔊 배경음악 켬' : '🔇 배경음악 끔';
    });

    sel<HTMLFormElement>('loginForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api.login(sel<HTMLInputElement>('u')!.value, sel<HTMLInputElement>('p')!.value);
        onAuth(r.token);
      } catch (ex) { showErr((ex as Error).message); }
    });

    // 성별 캐릭터 선택 (기본 남자)
    let gender = 'm';
    const gM = sel<HTMLButtonElement>('gM');
    const gF = sel<HTMLButtonElement>('gF');
    const pick = (g: string) => {
      gender = g;
      gM?.classList.toggle('on', g === 'm');
      gF?.classList.toggle('on', g === 'f');
    };
    gM?.addEventListener('click', () => pick('m'));
    gF?.addEventListener('click', () => pick('f'));

    sel<HTMLFormElement>('signupForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = sel<HTMLInputElement>('u')!.value;
      const p = sel<HTMLInputElement>('p')!.value;
      const p2 = sel<HTMLInputElement>('p2')!.value;
      const nick = sel<HTMLInputElement>('nick')!.value;
      if (p.length < 4) return showErr('비밀번호는 4자 이상이어야 합니다.');
      if (p !== p2) return showErr('비밀번호가 일치하지 않습니다.');
      try {
        const r = await api.signup(u, p, nick || undefined, gender);
        onAuth(r.token);
      } catch (ex) { showErr((ex as Error).message); }
    });
  }
}
