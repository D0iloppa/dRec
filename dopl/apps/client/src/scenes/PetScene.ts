// 펫 — 별도 페이지(Phaser 씬). 입양 → 다마고치식 관리(배고픔/행복 게이지, 먹이/간식/놀아주기)
// + 펫 꾸미기(보유 pet_acc 장착) + 이름 변경. 먹이·간식은 상점에서 구매(소모품).
import Phaser from 'phaser';
import { addCartoonBackdrop } from '../backdrop';
import { petSvg, petItemSvg, type PetMood } from '../petSvg';
import { bgm } from '../bgm';

interface PetView {
  species: string;
  name: string;
  hunger: number;
  happiness: number;
  exp: number;
  level: number;
  accessory: string | null;
  mood: PetMood;
}
interface Species { code: string; name: string; asset: string; price: number }
interface Supply { code: string; name: string; slot: string; price: number; qty: number }

async function call(path: string, token: string, method = 'GET', body?: unknown) {
  const res = await fetch('/pet' + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청 실패');
  return data;
}

export class PetScene extends Phaser.Scene {
  private dom!: Phaser.GameObjects.DOMElement;
  private token = '';
  private refreshProfile: () => void = () => {};
  private pet: PetView | null = null;
  private species: Species[] = [];
  private supplies: Supply[] = [];
  private adoptPick = '';
  private msg = '';
  private loaded = false;

  constructor() {
    super('pet');
  }

  create() {
    addCartoonBackdrop(this);
    bgm.play('lobby'); // 펫 전용 트랙 생기면 교체
    this.token = this.game.registry.get('token') ?? '';
    this.refreshProfile = this.game.registry.get('refreshProfile') ?? (() => {});
    this.msg = '';
    this.loaded = false;

    this.dom = this.add.dom(this.scale.width / 2, this.scale.height / 2).createFromHTML('<div class="pet-page"></div>');
    this.scale.on('resize', () => this.dom.setPosition(this.scale.width / 2, this.scale.height / 2));
    void this.reload();
    this.render();
  }

  private esc(s: string) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  }

  private async reload() {
    try {
      const d = await call('/', this.token);
      this.pet = d.pet;
      this.species = d.species;
      this.supplies = d.supplies;
      if (!this.adoptPick) this.adoptPick = this.species[0]?.code ?? '';
    } catch (e) {
      this.msg = (e as Error).message;
    }
    this.loaded = true;
    this.render();
  }

  private gauge(label: string, value: number, color: string) {
    return `
      <div class="pet-gauge">
        <span class="pet-gauge-label">${label}</span>
        <div class="pet-gauge-bar"><div class="pet-gauge-fill" style="width:${value}%;background:${color}"></div></div>
        <span class="pet-gauge-val">${value}</span>
      </div>`;
  }

  private render() {
    const inner = !this.loaded
      ? '<div class="lb-empty">불러오는 중…</div>'
      : this.pet
        ? this.careHtml()
        : this.adoptHtml();
    (this.dom.node as HTMLElement).innerHTML = `
      <div class="pet-page page-panel">
        <header class="dx-head">
          <b>🐾 마이 펫</b>
          <span class="dx-sub">다마고치처럼 돌봐주세요 — 굶기면 시무룩해져요</span>
          <button id="goShopP" class="lb-btn lb-btn-amber">🛍 상점</button>
          <button id="goLobbyP" class="lb-btn lb-btn-red">⬅ 로비로</button>
        </header>
        ${inner}
        <footer class="dx-foot"><span class="dx-msg">${this.esc(this.msg)}</span></footer>
      </div>`;
    this.wire();
    this.dom.updateSize();
    this.dom.setPosition(this.scale.width / 2, this.scale.height / 2);
  }

  // 입양 화면
  private adoptHtml() {
    const cards = this.species
      .map(
        (s) => `
        <div class="pet-species ${this.adoptPick === s.code ? 'sel' : ''}" data-code="${s.code}">
          <div class="pet-species-img">${petSvg(s.code, 'happy')}</div>
          <b>${this.esc(s.name)}</b>
          <span class="dx-badge price">🪙 ${s.price}</span>
        </div>`
      )
      .join('');
    return `
      <div class="pet-adopt">
        <h3>어떤 친구를 입양할까요?</h3>
        <div class="pet-species-row">${cards}</div>
        <div class="pet-adopt-form">
          <input id="petName" maxlength="12" placeholder="펫 이름 (최대 12자)">
          <button id="petAdopt" class="lb-btn lb-btn-green">🏡 입양하기</button>
        </div>
      </div>`;
  }

  // 관리 화면
  private careHtml() {
    const p = this.pet!;
    const foods = this.supplies.filter((s) => s.slot === 'pet_food' || s.slot === 'pet_snack');
    const accs = this.supplies.filter((s) => s.slot === 'pet_acc');
    const foodBtns = foods.length
      ? foods
          .map(
            (s) => `
        <button class="pet-feed-btn" data-code="${s.code}">
          <span class="pet-item-ico">${petItemSvg(s.code)}</span>
          <span>${this.esc(s.name)} <b>×${s.qty}</b></span>
        </button>`
          )
          .join('')
      : '<div class="shop-hint">먹이가 없어요 — 상점의 🐾 펫용품에서 구매하세요!</div>';
    const accBtns = accs
      .map(
        (s) => `
      <button class="pet-feed-btn ${p.accessory === s.code ? 'on' : ''}" data-acc="${s.code}">
        <span class="pet-item-ico">${petItemSvg(s.code)}</span>
        <span>${this.esc(s.name)}${p.accessory === s.code ? ' (착용 중)' : ''}</span>
      </button>`
      )
      .join('');
    const moodText = { happy: '😊 기분 최고!', ok: '😐 그럭저럭…', sad: '😢 시무룩해요' }[p.mood];
    return `
      <div class="pet-care">
        <div class="pet-left">
          <div class="pet-big">${petSvg(p.species, p.mood, p.accessory)}</div>
          <div class="pet-nameline"><span class="lb-lv">Lv.${p.level}</span> <b>${this.esc(p.name)}</b></div>
          <div class="pet-mood">${moodText}</div>
          <div class="nick-edit">
            <input id="petRename" maxlength="12" placeholder="새 이름">
            <button id="petRenameBtn" class="lb-btn lb-btn-amber">변경</button>
          </div>
        </div>
        <div class="pet-right">
          ${this.gauge('🍖 배고픔', p.hunger, 'linear-gradient(90deg,#fb923c,#ea580c)')}
          ${this.gauge('💖 행복', p.happiness, 'linear-gradient(90deg,#f9a8d4,#ec4899)')}
          <button id="petPlay" class="lb-btn lb-btn-green pet-play">🎾 놀아주기 (+행복)</button>
          <h4>🍚 먹이 주기</h4>
          <div class="pet-feeds">${foodBtns}</div>
          <h4>🎀 펫 꾸미기</h4>
          <div class="pet-feeds">${accBtns || '<div class="shop-hint">펫 액세서리는 상점에서!</div>'}
            ${p.accessory ? '<button class="pet-feed-btn" data-acc="__none__">❌ 벗기기</button>' : ''}</div>
        </div>
      </div>`;
  }

  private wire() {
    const n = this.dom.node as HTMLElement;
    n.querySelector('#goLobbyP')?.addEventListener('click', () => this.scene.start('lobby'));
    n.querySelector('#goShopP')?.addEventListener('click', () => this.scene.start('shop'));
    n.querySelectorAll('.pet-species').forEach((el) =>
      el.addEventListener('click', () => { this.adoptPick = (el as HTMLElement).dataset.code!; this.render(); })
    );
    n.querySelector('#petAdopt')?.addEventListener('click', () => {
      const name = (n.querySelector('#petName') as HTMLInputElement)?.value.trim();
      call('/adopt', this.token, 'POST', { species: this.adoptPick, name })
        .then((r) => { this.pet = r.pet; this.msg = '가족이 되었어요! 🎉'; this.refreshProfile(); this.render(); })
        .catch((e) => { this.msg = e.message; this.render(); });
    });
    n.querySelectorAll('.pet-feed-btn[data-code]').forEach((el) =>
      el.addEventListener('click', () => {
        call('/feed', this.token, 'POST', { itemCode: (el as HTMLElement).dataset.code })
          .then((r) => { this.pet = r.pet; this.msg = '냠냠! 🍖'; void this.reload(); })
          .catch((e) => { this.msg = e.message; this.render(); });
      })
    );
    n.querySelectorAll('.pet-feed-btn[data-acc]').forEach((el) =>
      el.addEventListener('click', () => {
        const raw = (el as HTMLElement).dataset.acc!;
        call('/acc', this.token, 'PUT', { code: raw === '__none__' ? null : raw })
          .then(() => { this.msg = '꾸미기 완료!'; void this.reload(); })
          .catch((e) => { this.msg = e.message; this.render(); });
      })
    );
    n.querySelector('#petPlay')?.addEventListener('click', () => {
      call('/play', this.token, 'POST')
        .then((r) => { this.pet = r.pet; this.msg = '신나게 놀았어요! 🎾'; this.render(); })
        .catch((e) => { this.msg = e.message; this.render(); });
    });
    n.querySelector('#petRenameBtn')?.addEventListener('click', () => {
      const name = (n.querySelector('#petRename') as HTMLInputElement)?.value.trim();
      if (!name) return;
      call('/name', this.token, 'POST', { name })
        .then(() => { this.msg = `이름이 "${name}"(으)로 바뀌었어요!`; void this.reload(); })
        .catch((e) => { this.msg = e.message; this.render(); });
    });
  }
}
