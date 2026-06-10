// 꼬들 — 한글 워들 미니게임 (솔로 + SNS 공유).
// 데일리 단어(서버 판정), 자모 6칸 × 6시도. 입력은 실제 꼬들처럼 자모 단위:
// 현재 줄에 자모가 분리되어 채워지고, 하단 두벌식(QWERTY) 키보드 + 실제 키보드(e.code 매핑) 지원.
// 진행 상태는 localStorage(퍼즐 번호 기준)에 보관.
interface Row {
  jamo: string[];
  marks: string[]; // 'hit' | 'near' | 'miss'
}
interface State {
  rows: Row[];
  done: boolean;
  success: boolean;
  answer?: string;
}

const MARK_EMOJI: Record<string, string> = { hit: '🟩', near: '🟨', miss: '⬛' };

// 두벌식 키보드 배열 (shift = 쌍자음/ㅒㅖ)
const KB_ROWS: string[][] = [
  ['ㅂ', 'ㅈ', 'ㄷ', 'ㄱ', 'ㅅ', 'ㅛ', 'ㅕ', 'ㅑ', 'ㅐ', 'ㅔ'],
  ['ㅁ', 'ㄴ', 'ㅇ', 'ㄹ', 'ㅎ', 'ㅗ', 'ㅓ', 'ㅏ', 'ㅣ'],
];
const KB_ROW3 = ['ㅋ', 'ㅌ', 'ㅊ', 'ㅍ', 'ㅠ', 'ㅜ', 'ㅡ'];
const SHIFT_MAP: Record<string, string> = { 'ㅂ': 'ㅃ', 'ㅈ': 'ㅉ', 'ㄷ': 'ㄸ', 'ㄱ': 'ㄲ', 'ㅅ': 'ㅆ', 'ㅐ': 'ㅒ', 'ㅔ': 'ㅖ' };
// 물리 키보드 e.code → 자모 (두벌식, IME 상태와 무관)
const CODE_MAP: Record<string, string> = {
  KeyQ: 'ㅂ', KeyW: 'ㅈ', KeyE: 'ㄷ', KeyR: 'ㄱ', KeyT: 'ㅅ', KeyY: 'ㅛ', KeyU: 'ㅕ', KeyI: 'ㅑ', KeyO: 'ㅐ', KeyP: 'ㅔ',
  KeyA: 'ㅁ', KeyS: 'ㄴ', KeyD: 'ㅇ', KeyF: 'ㄹ', KeyG: 'ㅎ', KeyH: 'ㅗ', KeyJ: 'ㅓ', KeyK: 'ㅏ', KeyL: 'ㅣ',
  KeyZ: 'ㅋ', KeyX: 'ㅌ', KeyC: 'ㅊ', KeyV: 'ㅍ', KeyB: 'ㅠ', KeyN: 'ㅜ', KeyM: 'ㅡ',
};

async function call(path: string, token: string, body?: unknown) {
  const res = await fetch(`/mini/wordle/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청 실패');
  return data;
}

export const wordleGame = {
  id: 'wordle',
  icon: '🟩',
  name: '꼬들 — 한글 워들',
  desc: '오늘의 두 글자 단어를 6번 안에! 자모 단위로 힌트를 드려요. 결과를 SNS에 공유해 보세요.',

  mount(host: HTMLElement, ctx: { token: string; refreshProfile: () => void }) {
    let puzzleNo = 0;
    let maxAttempts = 6;
    let jamoLen = 6;
    let state: State = { rows: [], done: false, success: false };
    let cur: string[] = []; // 입력 중인 자모
    let shift = false;
    let submitting = false;
    let msg = '';
    let reward = 0;

    const storeKey = () => `dopl-wordle-${puzzleNo}`;
    const save = () => localStorage.setItem(storeKey(), JSON.stringify(state));
    const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

    function shareText(): string {
      const score = state.success ? `${state.rows.length}/${maxAttempts}` : `X/${maxAttempts}`;
      const grid = state.rows.map((r) => r.marks.map((m) => MARK_EMOJI[m]).join('')).join('\n');
      return `DOPL 꼬들 #${puzzleNo} ${score}\n\n${grid}\n\nhttps://dopl.doil.me`;
    }

    // 시도한 자모별 최고 등급 (키보드 색칠용)
    function jamoBest(): Map<string, string> {
      const rank: Record<string, number> = { miss: 0, near: 1, hit: 2 };
      const best = new Map<string, string>();
      for (const r of state.rows)
        r.jamo.forEach((j, i) => {
          const m = r.marks[i]!;
          if (!best.has(j) || rank[m]! > rank[best.get(j)!]!) best.set(j, m);
        });
      return best;
    }

    function keyHtml(j: string, best: Map<string, string>): string {
      const label = shift ? (SHIFT_MAP[j] ?? j) : j;
      const mark = best.get(label) ?? '';
      return `<button type="button" class="kb-key ${mark}" data-key="${label}">${label}</button>`;
    }

    function render() {
      const best = jamoBest();
      const rows: string[] = [];
      for (let i = 0; i < maxAttempts; i++) {
        const r = state.rows[i];
        const isCur = !state.done && i === state.rows.length;
        const tiles = Array.from({ length: jamoLen }, (_, j) => {
          if (r) return `<span class="wd-tile ${r.marks[j]}">${esc(r.jamo[j]!)}</span>`;
          if (isCur) return `<span class="wd-tile ${cur[j] ? 'cur' : 'empty'}">${esc(cur[j] ?? '')}</span>`;
          return '<span class="wd-tile empty"></span>';
        }).join('');
        rows.push(`<div class="wd-row ${isCur ? 'active' : ''}">${tiles}</div>`);
      }

      const kb = state.done
        ? ''
        : `
        <div class="kb">
          ${KB_ROWS.map((row) => `<div class="kb-row">${row.map((j) => keyHtml(j, best)).join('')}</div>`).join('')}
          <div class="kb-row">
            <button type="button" class="kb-key wide fn ${shift ? 'on' : ''}" data-key="⇧">⇧</button>
            ${KB_ROW3.map((j) => keyHtml(j, best)).join('')}
            <button type="button" class="kb-key wide fn" data-key="⌫">⌫</button>
          </div>
          <div class="kb-row">
            <button type="button" class="kb-key enter fn" data-key="⏎">입력 (Enter)</button>
          </div>
        </div>`;

      host.innerHTML = `
        <div class="wd">
          <div class="wd-head">
            <b>꼬들 #${puzzleNo}</b>
            <span class="wd-sub">두 글자 단어 · 자모 ${jamoLen}칸 · ${maxAttempts}번 도전 · 키보드로 입력하세요</span>
          </div>
          <div class="wd-grid">${rows.join('')}</div>
          ${state.done
            ? `<div class="wd-done ${state.success ? 'win' : 'fail'}">
                 ${state.success ? `🎉 ${state.rows.length}번 만에 정답!` : `😢 실패! 정답은 "${esc(state.answer ?? '')}"`}
                 ${reward > 0 ? `<div class="wd-reward">🪙 +${reward} 보상 획득!</div>` : ''}
               </div>
               <button id="wdShare" class="lb-btn lb-btn-green wd-share">📤 결과 공유하기</button>`
            : kb}
          <div class="wd-msg">${esc(msg)}</div>
        </div>`;

      host.querySelectorAll('.kb-key').forEach((el) =>
        el.addEventListener('click', () => press((el as HTMLElement).dataset.key!))
      );
      host.querySelector('#wdShare')?.addEventListener('click', () => void share());
    }

    function press(key: string) {
      if (state.done || submitting) return;
      msg = '';
      if (key === '⇧') shift = !shift;
      else if (key === '⌫') cur.pop();
      else if (key === '⏎') { void submit(); return; }
      else if (cur.length < jamoLen) { cur.push(key); shift = false; }
      render();
    }

    // 물리 키보드 (두벌식 매핑, IME 무관). 모달이 닫히면 스스로 해제.
    const onKeydown = (e: KeyboardEvent) => {
      if (!document.body.contains(host)) {
        window.removeEventListener('keydown', onKeydown);
        return;
      }
      if (state.done || submitting) return;
      if (e.code === 'Enter') { e.preventDefault(); void submit(); return; }
      if (e.code === 'Backspace') { e.preventDefault(); msg = ''; cur.pop(); render(); return; }
      const base = CODE_MAP[e.code];
      if (!base) return;
      e.preventDefault();
      const j = e.shiftKey ? (SHIFT_MAP[base] ?? base) : base;
      if (cur.length < jamoLen) { msg = ''; cur.push(j); render(); }
    };
    window.addEventListener('keydown', onKeydown);

    async function submit() {
      if (cur.length !== jamoLen) {
        msg = `자모 ${jamoLen}개를 모두 채워주세요. (${cur.length}/${jamoLen})`;
        render();
        return;
      }
      submitting = true;
      try {
        const r = await call('guess', ctx.token, { jamo: cur, attempt: state.rows.length + 1 });
        state.rows.push({ jamo: r.guessJamo, marks: r.marks });
        cur = [];
        if (r.correct) {
          state.done = true;
          state.success = true;
        } else if (state.rows.length >= maxAttempts) {
          state.done = true;
          state.success = false;
          state.answer = r.answer;
        }
        save();
        if (state.done) {
          const res = await call('result', ctx.token, { attempts: state.rows.length, success: state.success });
          reward = res.reward ?? 0;
          if (reward > 0) ctx.refreshProfile();
        }
      } catch (e) {
        msg = (e as Error).message;
      }
      submitting = false;
      render();
    }

    async function share() {
      const text = shareText();
      try {
        if (navigator.share) await navigator.share({ text });
        else {
          await navigator.clipboard.writeText(text);
          msg = '결과를 클립보드에 복사했어요! SNS에 붙여넣기 하세요.';
          render();
        }
      } catch {
        /* 공유 취소 */
      }
    }

    void (async () => {
      try {
        const t = await call('today', ctx.token);
        puzzleNo = t.puzzleNo;
        maxAttempts = t.maxAttempts;
        jamoLen = t.jamoLen;
        const saved = localStorage.getItem(storeKey());
        if (saved) {
          try { state = JSON.parse(saved); } catch { /* 무시 */ }
        }
        // 서버에 기록은 있는데 로컬 그리드가 없으면(다른 기기 등) 완료 상태로만 표시
        if (t.myResult && !state.done) {
          state.done = true;
          state.success = t.myResult.success;
          msg = '오늘 퍼즐은 이미 플레이했어요. 내일 새 단어로 만나요!';
        }
        render();
      } catch (e) {
        host.innerHTML = `<div class="wd-msg">${esc((e as Error).message)}</div>`;
      }
    })();
  },
};
