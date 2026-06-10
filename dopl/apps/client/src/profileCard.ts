// 프로필 카드 HTML — 캐릭터 착용샷 · 닉네임 · Lv · IQ · 경험치 바.
// 로비 접속자/게임방 참가자 클릭 시 공용으로 사용.
import { avatarImgHtml, type AvatarInfo } from './avatarRender';
import { levelOf } from './level';

const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export interface PublicProfile {
  nickname: string;
  iq: number | null;
  xp?: number | null;
  avatar: AvatarInfo | null;
}

export function profileCardHtml(p: PublicProfile): string {
  const xp = p.xp ?? 0;
  const lv = levelOf(xp);
  const base = 50 * (lv - 1) * (lv - 1);
  const next = 50 * lv * lv;
  const pct = Math.max(0, Math.min(100, Math.round(((xp - base) / (next - base)) * 100)));
  return `
    <div class="pcard">
      <div class="pcard-ava">${avatarImgHtml(p.avatar ?? {})}</div>
      <h3><span class="lb-lv">Lv.${lv}</span> ${esc(p.nickname)}</h3>
      <div class="pcard-iq">🧠 IQ ${p.iq ?? '-'}</div>
      <div class="pcard-xp">
        <div class="pcard-xp-bar"><div class="pcard-xp-fill" style="width:${pct}%"></div></div>
        <small>경험치 ${xp} / ${next}</small>
      </div>
    </div>`;
}
