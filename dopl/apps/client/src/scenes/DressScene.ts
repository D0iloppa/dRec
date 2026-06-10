// 분장실 — 별도 페이지(Phaser 씬). 보유 아이템만으로 장착/해제 + 닉네임 변경.
// 상점과 달리 인벤토리 중심 화면 (레퍼런스: 퀴즈퀴즈 분장실).
import Phaser from 'phaser';
import { avatarImgHtml, BASE_NAMES, OVERLAY_ITEMS, type Equipped } from '../avatarRender';
import { addCartoonBackdrop } from '../backdrop';
import { levelOf } from '../level';
import { bgm } from '../bgm';
import * as api from '../api';

interface ShopItem { id: number; code: string; name: string; slot: string; price: number; rarity: string }

const SLOT_TABS: [string, string][] = [
  ['hair', '💇 헤어'], ['top', '👕 상의'], ['acc', '🎀 소품'],
];
const SLOT_LABEL: Record<string, string> = { hair: '헤어', top: '상의', acc: '소품' };

export class DressScene extends Phaser.Scene {
  private dom!: Phaser.GameObjects.DOMElement;
  private items: ShopItem[] = [];
  private owned = new Set<string>();
  private draft: Equipped = {};
  private base = 1; // 미리보기 중인 base (성형 전엔 적용 불가)
  private myBase = 1; // 실제 내 base
  private tab = 'hair';
  private msg = '';
  private token = '';
  private profile: any = null;
  private refreshProfile: () => void = () => {};

  constructor() {
    super('dress');
  }

  create() {
    addCartoonBackdrop(this);
    bgm.play('dress'); // 분장실 전용 트랙
    this.token = this.game.registry.get('token') ?? '';
    this.profile = this.game.registry.get('profile');
    this.refreshProfile = this.game.registry.get('refreshProfile') ?? (() => {});
    this.msg = '';

    this.dom = this.add.dom(this.scale.width / 2, this.scale.height / 2).createFromHTML('<div class="dress-page"></div>');
    this.scale.on('resize', () => this.dom.setPosition(this.scale.width / 2, this.scale.height / 2));

    const onReg = () => { this.profile = this.game.registry.get('profile'); this.render(); };
    this.game.registry.events.on('changedata-profile', onReg);
    this.events.once('shutdown', () => this.game.registry.events.off('changedata-profile', onReg));

    void (async () => {
      try {
        const [cat, inv] = await Promise.all([api.getItems(), api.getInventory(this.token)]);
        this.items = (cat.items as ShopItem[]).filter((i) => OVERLAY_ITEMS.has(i.code));
        this.owned = new Set((inv.items as ShopItem[]).map((i) => i.code));
        const saved = this.profile?.profile?.avatar?.equipped ?? {};
        // 비활성(애셋 미준비) 아이템은 draft에서 제외
        this.draft = Object.fromEntries(Object.entries(saved).filter(([, c]) => this.items.some((i) => i.code === c))) as Equipped;
        this.myBase = this.profile?.profile?.avatar?.base ?? 1;
        this.base = this.myBase;
        this.render();
      } catch (e) {
        this.msg = (e as Error).message;
        this.render();
      }
    })();
    this.render();
  }

  private esc(s: string) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  }
  private gender(): string {
    return this.profile?.profile?.avatar?.gender === 'f' ? 'f' : 'm';
  }

  private render() {
    const me = this.profile?.profile;
    const g = this.gender();
    const tabs = SLOT_TABS.map(
      ([slot, label]) => `<button class="dx-tab ${this.tab === slot ? 'on' : ''}" data-slot="${slot}">${label}</button>`
    ).join('');

    // 보유(무료 포함) 아이템만
    const mine = this.items.filter((i) => i.slot === this.tab && (i.price === 0 || this.owned.has(i.code)));
    const cards = mine
      .map((it) => {
        const on = this.draft[it.slot] === it.code;
        const preview = avatarImgHtml({ gender: g, base: this.base, equipped: { ...this.draft, [it.slot]: it.code } });
        return `
        <div class="dx-card ${on ? 'sel' : ''}" data-code="${it.code}">
          <div class="dx-prev">${preview}</div>
          <div class="dx-name">${this.esc(it.name)}</div>
          ${on ? '<span class="dx-badge on">장착중</span>' : '<span class="dx-badge own">보유</span>'}
        </div>`;
      })
      .join('');

    // 현재 착용 요약
    const wearing = Object.entries(this.draft)
      .map(([slot, code]) => {
        const it = this.items.find((i) => i.code === code);
        return it ? `<span class="wear-chip">${SLOT_LABEL[slot] ?? slot}: ${this.esc(it.name)}</span>` : '';
      })
      .join('');

    (this.dom.node as HTMLElement).innerHTML = `
      <div class="dress-page page-panel">
        <header class="dx-head">
          <b>👗 분장실</b>
          <span class="dx-sub">캐릭터: ${g === 'f' ? '여자' : '남자'} (고정)</span>
          <button id="goShop" class="lb-btn lb-btn-amber">🛍 상점</button>
          <button id="goLobby" class="lb-btn lb-btn-red">⬅ 로비로</button>
        </header>
        <div class="dx-body">
          <div class="dx-preview-pane">
            <div class="dx-big">${avatarImgHtml({ gender: g, base: this.base, equipped: this.draft })}</div>
            <b><span class="lb-lv">Lv.${levelOf(me?.xp)}</span> ${this.esc(me?.nickname ?? '')}</b>
            <div class="nick-edit">
              <input id="nickInput" maxlength="20" placeholder="새 닉네임" value="${this.esc(me?.nickname ?? '')}">
              <button id="nickSave" class="lb-btn lb-btn-amber">변경</button>
            </div>
            <div class="wear-chips">${wearing || '<small class="shop-hint">기본 차림</small>'}</div>
          </div>
          <div class="dx-right">
            <div class="base-pick">
              <span class="base-pick-label">캐릭터</span>
              ${[1, 2, 3].map((n) => `<div class="base-opt ${this.base === n ? 'sel' : ''} ${this.myBase === n ? 'mine' : ''}" data-base="${n}"><img src="/avatar/${g}/b${n}/base.png" alt="base${n}" draggable="false"><span class="base-name">${BASE_NAMES[g]?.[n - 1] ?? ''}${this.myBase === n ? ' ✔' : ''}</span></div>`).join('')}
              ${this.base !== this.myBase
                ? `<button id="surgeryBtn" class="lb-btn lb-btn-red surgery-btn">✨ 성형하기<br><small>🪙 100,000</small></button>`
                : '<span class="shop-hint surgery-hint">다른 캐릭터는 [성형]으로만 변경돼요</span>'}
            </div>
            <div class="dx-tabs">${tabs}</div>
            <div class="dx-grid">${cards || '<div class="lb-empty">보유한 아이템이 없어요. 상점에서 구매해 보세요!</div>'}</div>
          </div>
        </div>
        <footer class="dx-foot">
          <span class="dx-msg">${this.esc(this.msg)}</span>
          <button id="dressSave" class="lb-btn lb-btn-green">저장 (장착 적용)</button>
        </footer>
      </div>`;
    this.wire();
    this.dom.updateSize();
    this.dom.setPosition(this.scale.width / 2, this.scale.height / 2);
  }

  private wire() {
    const n = this.dom.node as HTMLElement;
    n.querySelector('#goLobby')?.addEventListener('click', () => this.scene.start('lobby'));
    n.querySelector('#goShop')?.addEventListener('click', () => this.scene.start('shop'));
    n.querySelectorAll('.dx-tab').forEach((el) =>
      el.addEventListener('click', () => { this.tab = (el as HTMLElement).dataset.slot!; this.render(); })
    );
    n.querySelectorAll('.dx-card').forEach((el) =>
      el.addEventListener('click', () => {
        const code = (el as HTMLElement).dataset.code!;
        const item = this.items.find((i) => i.code === code);
        if (!item) return;
        if (this.draft[item.slot] === code) delete this.draft[item.slot];
        else this.draft[item.slot] = code;
        this.render();
      })
    );
    n.querySelectorAll('.base-opt').forEach((el) =>
      el.addEventListener('click', () => { this.base = Number((el as HTMLElement).dataset.base); this.render(); })
    );
    n.querySelector('#surgeryBtn')?.addEventListener('click', () => {
      const name = BASE_NAMES[this.gender()]?.[this.base - 1] ?? '';
      if (!window.confirm(`정말 "${name}"(으)로 성형할까요?\n비용: 🪙 100,000 (환불 불가)`)) return;
      api.surgery(this.token, this.base)
        .then(() => {
          this.myBase = this.base;
          this.msg = `✨ 성형 완료! 이제 ${name}의 모습이에요.`;
          (this.game.registry.get('socket') as { emit: (e: string) => void } | undefined)?.emit?.('profileRefresh');
          this.refreshProfile();
          this.render();
        })
        .catch((e) => { this.msg = e.message; this.render(); });
    });
    n.querySelector('#dressSave')?.addEventListener('click', () => void this.save());
    n.querySelector('#nickSave')?.addEventListener('click', () => void this.saveNick());
  }

  private async save() {
    try {
      await api.equipAvatar(this.token, this.draft);
      (this.game.registry.get('socket') as { emit: (e: string) => void } | undefined)?.emit?.('profileRefresh');
      this.refreshProfile();
      this.msg = '저장되었습니다!';
    } catch (e) {
      this.msg = (e as Error).message;
    }
    this.render();
  }

  private async saveNick() {
    const input = (this.dom.node as HTMLElement).querySelector('#nickInput') as HTMLInputElement;
    const nickname = input?.value.trim();
    if (!nickname) return;
    try {
      await api.patchProfile(this.token, { nickname });
      (this.game.registry.get('socket') as { emit: (e: string) => void } | undefined)?.emit?.('profileRefresh');
      this.refreshProfile();
      this.msg = `닉네임이 "${nickname}"(으)로 변경되었습니다!`;
    } catch (e) {
      this.msg = (e as Error).message;
    }
    this.render();
  }
}
