// 상점 — 별도 페이지(Phaser 씬). 좌측 내 캐릭터 착용 미리보기(입어보기 반영),
// 중앙 카테고리 탭 + 아이템 카드(성별 맞춤 착용샷)·구매. 저장하면 입어본 모습 그대로 장착.
import Phaser from 'phaser';
import { avatarImgHtml, OVERLAY_ITEMS, type Equipped } from '../avatarRender';
import { petItemSvg } from '../petSvg';
import { addCartoonBackdrop } from '../backdrop';
import { levelOf } from '../level';
import { bgm } from '../bgm';
import * as api from '../api';

interface ShopItem { id: number; code: string; name: string; slot: string; price: number; rarity: string }

const SLOT_TABS: [string, string][] = [
  ['hair', '💇 헤어'], ['top', '👕 상의'], ['acc', '🎀 소품'], ['pet', '🐾 펫용품'],
];
const PET_SLOTS = ['pet_food', 'pet_snack', 'pet_acc'];
const RARITY_COLOR: Record<string, string> = { common: '#64748b', rare: '#2563eb', epic: '#9333ea' };

export class ShopScene extends Phaser.Scene {
  private dom!: Phaser.GameObjects.DOMElement;
  private items: ShopItem[] = [];
  private owned = new Set<string>();
  private tryOn: Equipped = {};
  private tab = 'top';
  private msg = '';
  private token = '';
  private profile: any = null;
  private refreshProfile: () => void = () => {};

  constructor() {
    super('shop');
  }

  create() {
    addCartoonBackdrop(this);
    bgm.play('shop');
    this.token = this.game.registry.get('token') ?? '';
    this.profile = this.game.registry.get('profile');
    this.refreshProfile = this.game.registry.get('refreshProfile') ?? (() => {});
    this.msg = '';

    this.dom = this.add.dom(this.scale.width / 2, this.scale.height / 2).createFromHTML('<div class="shop"></div>');
    this.scale.on('resize', () => this.dom.setPosition(this.scale.width / 2, this.scale.height / 2));

    const onReg = () => { this.profile = this.game.registry.get('profile'); this.render(); };
    this.game.registry.events.on('changedata-profile', onReg);
    this.events.once('shutdown', () => this.game.registry.events.off('changedata-profile', onReg));

    void (async () => {
      try {
        const [cat, inv] = await Promise.all([api.getItems(), api.getInventory(this.token)]);
        this.items = (cat.items as ShopItem[]).filter((i) => OVERLAY_ITEMS.has(i.code) || PET_SLOTS.includes(i.slot));
        this.owned = new Set((inv.items as ShopItem[]).map((i) => i.code));
        const saved = this.profile?.profile?.avatar?.equipped ?? {};
        this.tryOn = Object.fromEntries(Object.entries(saved).filter(([, c]) => this.items.some((i) => i.code === c))) as Equipped;
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
  private baseN(): number {
    return this.profile?.profile?.avatar?.base ?? 1;
  }
  private gender(): string {
    return this.profile?.profile?.avatar?.gender === 'f' ? 'f' : 'm';
  }

  private render() {
    const me = this.profile?.profile;
    const coins = this.profile?.wallet?.coins ?? 0;
    const g = this.gender();
    const tabs = SLOT_TABS.map(
      ([slot, label]) => `<button class="dx-tab ${this.tab === slot ? 'on' : ''}" data-slot="${slot}">${label}</button>`
    ).join('');
    const cards = this.items
      .filter((i) => (this.tab === 'pet' ? PET_SLOTS.includes(i.slot) : i.slot === this.tab))
      .map((it) => {
        // 펫용품: 소모품은 항상 구매 가능(수량 누적), 미리보기는 아이콘
        if (PET_SLOTS.includes(it.slot)) {
          const consumable = it.slot !== 'pet_acc';
          const ownedAcc = !consumable && this.owned.has(it.code);
          return `
        <div class="dx-card" data-pet="1">
          <div class="dx-prev pet-ico">${petItemSvg(it.code)}</div>
          <div class="dx-name" style="color:${RARITY_COLOR[it.rarity] ?? '#333'}">${this.esc(it.name)}</div>
          ${ownedAcc ? '<span class="dx-badge own">보유</span>' : `<span class="dx-badge price">🪙 ${it.price}</span>`}
          ${ownedAcc ? '' : `<button class="shop-buy" data-buy="${it.code}">구매</button>`}
        </div>`;
        }
        const isOwned = this.owned.has(it.code) || it.price === 0;
        const trying = this.tryOn[it.slot] === it.code;
        const preview = avatarImgHtml({ gender: g, base: this.baseN(), equipped: { ...this.tryOn, [it.slot]: it.code } });
        return `
        <div class="dx-card ${trying ? 'sel' : ''}" data-code="${it.code}">
          <div class="dx-prev">${preview}</div>
          <div class="dx-name" style="color:${RARITY_COLOR[it.rarity] ?? '#333'}">${this.esc(it.name)}</div>
          ${trying ? '<span class="dx-badge on">입는 중</span>' : isOwned ? '<span class="dx-badge own">보유</span>' : `<span class="dx-badge price">🪙 ${it.price}</span>`}
          ${!isOwned ? `<button class="shop-buy" data-buy="${it.code}">구매</button>` : ''}
        </div>`;
      })
      .join('');

    (this.dom.node as HTMLElement).innerHTML = `
      <div class="shop page-panel">
        <header class="dx-head">
          <b>🛍 PLAY SHOP</b>
          <span class="dx-coins">🪙 ${coins}</span>
          <button id="goDress" class="lb-btn lb-btn-amber">👗 분장실</button>
          <button id="goLobby" class="lb-btn lb-btn-red">⬅ 로비로</button>
        </header>
        <div class="dx-body">
          <div class="dx-preview-pane">
            <div class="dx-big">${avatarImgHtml({ gender: g, base: this.baseN(), equipped: this.tryOn })}</div>
            <b><span class="lb-lv">Lv.${levelOf(me?.xp)}</span> ${this.esc(me?.nickname ?? '')}</b>
            <small class="shop-hint">카드를 누르면 입어볼 수 있어요</small>
          </div>
          <div class="dx-right">
            <div class="dx-tabs">${tabs}</div>
            <div class="dx-grid">${cards || '<div class="lb-empty">아이템이 없습니다</div>'}</div>
          </div>
        </div>
        <footer class="dx-foot">
          <span class="dx-msg">${this.esc(this.msg)}</span>
          <button id="shopSave" class="lb-btn lb-btn-green">입어본 모습으로 장착 저장</button>
        </footer>
      </div>`;
    this.wire();
    this.dom.updateSize();
    this.dom.setPosition(this.scale.width / 2, this.scale.height / 2);
  }

  private wire() {
    const n = this.dom.node as HTMLElement;
    n.querySelector('#goLobby')?.addEventListener('click', () => this.scene.start('lobby'));
    n.querySelector('#goDress')?.addEventListener('click', () => this.scene.start('dress'));
    n.querySelectorAll('.dx-tab').forEach((el) =>
      el.addEventListener('click', () => { this.tab = (el as HTMLElement).dataset.slot!; this.render(); })
    );
    n.querySelectorAll('.dx-card').forEach((el) =>
      el.addEventListener('click', () => {
        if ((el as HTMLElement).dataset.pet) return; // 펫용품은 입어보기 없음
        const code = (el as HTMLElement).dataset.code!;
        const item = this.items.find((i) => i.code === code);
        if (!item) return;
        // 입어보기 토글 (구매 여부 무관 — 미리보기는 자유)
        if (this.tryOn[item.slot] === code) delete this.tryOn[item.slot];
        else this.tryOn[item.slot] = code;
        this.render();
      })
    );
    n.querySelectorAll('.shop-buy').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.buy((el as HTMLElement).dataset.buy!);
      })
    );
    n.querySelector('#shopSave')?.addEventListener('click', () => void this.save());
  }

  private async buy(code: string) {
    const item = this.items.find((i) => i.code === code);
    if (!item) return;
    if (!window.confirm(`"${item.name}" 아이템을 🪙 ${item.price}에 구매할까요?`)) return;
    try {
      await api.buyItem(this.token, item.id);
      this.owned.add(code);
      this.tryOn[item.slot] = code;
      this.msg = `${item.name} 구매 완료!`;
      this.refreshProfile();
    } catch (e) {
      this.msg = (e as Error).message;
    }
    this.render();
  }

  private async save() {
    // 미보유(가격>0) 아이템은 저장에서 제외 — 서버도 거부하지만 친절하게 걸러준다
    const equip: Equipped = {};
    for (const [slot, code] of Object.entries(this.tryOn)) {
      const it = this.items.find((i) => i.code === code);
      if (it && (it.price === 0 || this.owned.has(code))) equip[slot] = code;
    }
    try {
      await api.equipAvatar(this.token, equip);
      (this.game.registry.get('socket') as { emit: (e: string) => void } | undefined)?.emit?.('profileRefresh');
      this.refreshProfile();
      this.msg = '장착 저장 완료!';
    } catch (e) {
      this.msg = (e as Error).message;
    }
    this.render();
  }
}
