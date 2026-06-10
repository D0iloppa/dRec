// 꼬들(한글 워들) 미니게임 — 데일리 단어(KST), 자모 6칸 · 6시도, 서버 판정.
// 미니게임은 게임별로 /mini/<id> 라우터를 추가하는 구조 (단일 진입점 아님).
import express from 'express';
import { pool } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const wordleRouter = express.Router();

const GAME = 'wordle';
const MAX_ATTEMPTS = 6;
const JAMO_LEN = 6;
// 퍼즐 #1 = 2026-06-01 (KST)
const BASE_DAY = Math.floor(Date.UTC(2026, 5, 1) / 86400000);

const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
// 복모음·겹받침은 2자모로 분해 (쌍자음 ㄲㅆ 등은 1자모)
const SPLIT: Record<string, string[]> = {
  'ㅘ': ['ㅗ','ㅏ'], 'ㅙ': ['ㅗ','ㅐ'], 'ㅚ': ['ㅗ','ㅣ'], 'ㅝ': ['ㅜ','ㅓ'], 'ㅞ': ['ㅜ','ㅔ'], 'ㅟ': ['ㅜ','ㅣ'], 'ㅢ': ['ㅡ','ㅣ'],
  'ㄳ': ['ㄱ','ㅅ'], 'ㄵ': ['ㄴ','ㅈ'], 'ㄶ': ['ㄴ','ㅎ'], 'ㄺ': ['ㄹ','ㄱ'], 'ㄻ': ['ㄹ','ㅁ'], 'ㄼ': ['ㄹ','ㅂ'],
  'ㄽ': ['ㄹ','ㅅ'], 'ㄾ': ['ㄹ','ㅌ'], 'ㄿ': ['ㄹ','ㅍ'], 'ㅀ': ['ㄹ','ㅎ'], 'ㅄ': ['ㅂ','ㅅ'],
};

// 한글 단어 → 자모 배열. 한글 음절이 아닌 문자가 있으면 null.
export function toJamo(word: string): string[] | null {
  const out: string[] = [];
  for (const ch of word) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) return null;
    const cho = CHO[Math.floor(code / 588)]!;
    const jung = JUNG[Math.floor((code % 588) / 28)]!;
    const jong = JONG[code % 28]!;
    out.push(cho, ...(SPLIT[jung] ?? [jung]));
    if (jong) out.push(...(SPLIT[jong] ?? [jong]));
  }
  return out;
}

// 워들 판정 (중복 자모 처리 포함): hit=위치 일치, near=다른 위치에 존재, miss=없음
function judge(answer: string[], guess: string[]): string[] {
  const res: string[] = Array(guess.length).fill('miss');
  const remain: Record<string, number> = {};
  answer.forEach((a, i) => {
    if (guess[i] === a) res[i] = 'hit';
    else remain[a] = (remain[a] ?? 0) + 1;
  });
  guess.forEach((g, i) => {
    if (res[i] === 'miss' && (remain[g] ?? 0) > 0) {
      res[i] = 'near';
      remain[g]!--;
    }
  });
  return res;
}

function todayPuzzleNo(): number {
  const kstDay = Math.floor((Date.now() + 9 * 3600 * 1000) / 86400000);
  return kstDay - BASE_DAY + 1;
}

async function todayWord(): Promise<{ puzzleNo: number; word: string }> {
  const puzzleNo = todayPuzzleNo();
  const { rows } = await pool.query('SELECT word FROM wordle_word ORDER BY id');
  if (rows.length === 0) throw new Error('단어 풀이 비었습니다');
  // 같은 날짜 = 같은 단어 (결정적). 단어가 추가돼도 과거와 무관하게 잘 동작.
  const word = rows[((puzzleNo - 1) % rows.length + rows.length) % rows.length].word as string;
  return { puzzleNo, word };
}

// 오늘의 퍼즐 정보 (+ 내 기록)
wordleRouter.get('/today', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { puzzleNo } = await todayWord();
    const { rows } = await pool.query(
      'SELECT attempts, success FROM mini_result WHERE user_id = $1 AND game = $2 AND puzzle_no = $3',
      [req.user!.uid, GAME, puzzleNo]
    );
    res.json({ puzzleNo, jamoLen: JAMO_LEN, maxAttempts: MAX_ATTEMPTS, myResult: rows[0] ?? null });
  } catch (e) {
    console.error('[wordle/today]', e);
    res.status(500).json({ error: '퍼즐 조회 오류' });
  }
});

// 두벌식으로 입력 가능한 자모 집합 (자음 19 + 기본 모음 14 + ㅒㅖ)
const TYPABLE = new Set([...CHO, 'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅛ', 'ㅜ', 'ㅠ', 'ㅡ', 'ㅣ']);

// 추측 판정. jamo 배열(자모 단위 입력) 또는 guess 단어 중 하나를 받는다.
// attempt(몇 번째 시도)가 마지막이면 정답 공개.
wordleRouter.post('/guess', requireAuth, async (req, res) => {
  const attempt = Number(req.body?.attempt ?? 0);
  let guess: string[] | null = null;

  if (Array.isArray(req.body?.jamo)) {
    guess = (req.body.jamo as unknown[]).map(String);
    if (guess.length !== JAMO_LEN || !guess.every((j) => TYPABLE.has(j))) {
      res.status(400).json({ error: `자모 ${JAMO_LEN}개를 입력하세요.` });
      return;
    }
  } else {
    const guessWord = String(req.body?.guess ?? '').trim();
    if ([...guessWord].length !== 2) {
      res.status(400).json({ error: '두 글자 단어를 입력하세요.' });
      return;
    }
    guess = toJamo(guessWord);
    if (!guess) {
      res.status(400).json({ error: '한글만 입력할 수 있어요.' });
      return;
    }
    if (guess.length !== JAMO_LEN) {
      res.status(400).json({ error: `자모 ${JAMO_LEN}개 단어만 가능해요. (입력: ${guess.length}개)` });
      return;
    }
  }
  try {
    const { word } = await todayWord();
    const answer = toJamo(word)!;
    const marks = judge(answer, guess);
    const correct = marks.every((m) => m === 'hit');
    const out: Record<string, unknown> = { ok: true, guessJamo: guess, marks, correct };
    if (!correct && attempt >= MAX_ATTEMPTS) out.answer = word;
    res.json(out);
  } catch (e) {
    console.error('[wordle/guess]', e);
    res.status(500).json({ error: '판정 오류' });
  }
});

// 결과 기록 (퍼즐당 1회) + 성공 보상: 적게 시도할수록 코인 ↑
wordleRouter.post('/result', requireAuth, async (req: AuthedRequest, res) => {
  const attempts = Number(req.body?.attempts);
  const success = req.body?.success === true;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    res.status(400).json({ error: 'attempts가 올바르지 않습니다.' });
    return;
  }
  const uid = req.user!.uid;
  const client = await pool.connect();
  try {
    const { puzzleNo } = await todayWord();
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `INSERT INTO mini_result (user_id, game, puzzle_no, attempts, success)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [uid, GAME, puzzleNo, attempts, success]
    );
    const already = rowCount === 0;
    const reward = !already && success ? 40 - attempts * 5 : 0; // 1트라이 35 ~ 6트라이 10
    if (reward > 0) {
      await client.query('UPDATE user_wallet SET coins = coins + $2, updated_at = now() WHERE user_id = $1', [uid, reward]);
    }
    if (!already) {
      // 미니게임 XP: 참가 5 + 보상만큼
      await client.query('UPDATE user_profile SET xp = xp + $2, updated_at = now() WHERE user_id = $1', [uid, 5 + reward]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, already, reward });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[wordle/result]', e);
    res.status(500).json({ error: '결과 기록 오류' });
  } finally {
    client.release();
  }
});
