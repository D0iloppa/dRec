// 펫 — 다마고치식 관리. 1인 1펫, 스탯(배고픔/행복)은 조회 시 경과시간만큼 감소(lazy tick).
// 먹이/간식은 상점 소모품(user_inventory.qty), 효과는 코드 상수로 관리.
import express from 'express';
import { pool } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const petRouter = express.Router();
petRouter.use(requireAuth);

// 시간당 감소율 / 먹이 효과
const DECAY_HUNGER_PER_H = 4;
const DECAY_HAPPY_PER_H = 3;
const FOOD_EFFECTS: Record<string, { hunger?: number; happiness?: number; exp?: number }> = {
  pet_food_basic: { hunger: 30 },
  pet_food_premium: { hunger: 60, happiness: 5 },
  pet_snack_cookie: { happiness: 20, exp: 5 },
  pet_snack_cake: { happiness: 45, exp: 12 },
};

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

// lazy tick — 경과 시간만큼 스탯 감소 후 저장된 최신 펫 행 반환
async function tickPet(uid: number) {
  const { rows } = await pool.query('SELECT * FROM user_pet WHERE user_id = $1', [uid]);
  const pet = rows[0];
  if (!pet) return null;
  const hours = (Date.now() - new Date(pet.last_tick).getTime()) / 3600_000;
  if (hours < 0.05) return pet;
  let hunger = pet.hunger - hours * DECAY_HUNGER_PER_H;
  let happiness = pet.happiness - hours * DECAY_HAPPY_PER_H;
  if (hunger <= 0) happiness -= hours * 4; // 굶으면 행복 추가 하락
  hunger = clamp(hunger);
  happiness = clamp(happiness);
  const { rows: upd } = await pool.query(
    `UPDATE user_pet SET hunger = $2, happiness = $3, last_tick = now() WHERE user_id = $1 RETURNING *`,
    [uid, hunger, happiness]
  );
  return upd[0];
}

function view(pet: any) {
  if (!pet) return null;
  return {
    species: pet.species_code,
    name: pet.name,
    hunger: pet.hunger,
    happiness: pet.happiness,
    exp: pet.exp,
    level: Math.floor(Math.sqrt(pet.exp / 20)) + 1,
    accessory: pet.accessory,
    mood: pet.hunger < 25 || pet.happiness < 25 ? 'sad' : pet.happiness >= 70 ? 'happy' : 'ok',
  };
}

// 내 펫 + 종류 카탈로그 + 펫용품 인벤(qty)
petRouter.get('/', async (req: AuthedRequest, res) => {
  try {
    const uid = req.user!.uid;
    const pet = await tickPet(uid);
    const { rows: species } = await pool.query('SELECT code, name, asset, price FROM pet_species ORDER BY price');
    const { rows: supplies } = await pool.query(
      `SELECT i.code, i.name, i.slot, i.price, ui.qty
         FROM user_inventory ui JOIN item i ON i.id = ui.item_id
        WHERE ui.user_id = $1 AND i.slot IN ('pet_food', 'pet_snack', 'pet_acc') ORDER BY i.slot, i.price`,
      [uid]
    );
    res.json({ pet: view(pet), species, supplies });
  } catch (e) {
    console.error('[pet/get]', e);
    res.status(500).json({ error: '펫 조회 오류' });
  }
});

// 입양 — 종 가격만큼 코인 차감, 1인 1펫
petRouter.post('/adopt', async (req: AuthedRequest, res) => {
  const uid = req.user!.uid;
  const speciesCode = String(req.body?.species ?? '');
  const name = String(req.body?.name ?? '').trim().slice(0, 12);
  if (!name) { res.status(400).json({ error: '펫 이름을 지어주세요.' }); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ex } = await client.query('SELECT 1 FROM user_pet WHERE user_id = $1', [uid]);
    if (ex[0]) { await client.query('ROLLBACK'); res.status(409).json({ error: '이미 펫이 있습니다.' }); return; }
    const { rows: sp } = await client.query('SELECT code, price FROM pet_species WHERE code = $1', [speciesCode]);
    if (!sp[0]) { await client.query('ROLLBACK'); res.status(404).json({ error: '없는 펫 종류입니다.' }); return; }
    const { rows: w } = await client.query('SELECT coins FROM user_wallet WHERE user_id = $1 FOR UPDATE', [uid]);
    if ((w[0]?.coins ?? 0) < sp[0].price) { await client.query('ROLLBACK'); res.status(402).json({ error: '코인이 부족합니다.' }); return; }
    await client.query('UPDATE user_wallet SET coins = coins - $2, updated_at = now() WHERE user_id = $1', [uid, sp[0].price]);
    await client.query('INSERT INTO user_pet (user_id, species_code, name) VALUES ($1, $2, $3)', [uid, speciesCode, name]);
    await client.query('COMMIT');
    const pet = await tickPet(uid);
    res.json({ ok: true, pet: view(pet) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[pet/adopt]', e);
    res.status(500).json({ error: '입양 처리 오류' });
  } finally {
    client.release();
  }
});

// 먹이/간식 주기 — 소모품 qty 차감 + 효과 반영
petRouter.post('/feed', async (req: AuthedRequest, res) => {
  const uid = req.user!.uid;
  const code = String(req.body?.itemCode ?? '');
  const fx = FOOD_EFFECTS[code];
  if (!fx) { res.status(400).json({ error: '먹일 수 없는 아이템입니다.' }); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT ui.item_id, ui.qty FROM user_inventory ui JOIN item i ON i.id = ui.item_id
        WHERE ui.user_id = $1 AND i.code = $2 FOR UPDATE`,
      [uid, code]
    );
    if (!rows[0] || rows[0].qty < 1) { await client.query('ROLLBACK'); res.status(402).json({ error: '보유 수량이 없습니다. 상점에서 구매하세요!' }); return; }
    if (rows[0].qty === 1) await client.query('DELETE FROM user_inventory WHERE user_id = $1 AND item_id = $2', [uid, rows[0].item_id]);
    else await client.query('UPDATE user_inventory SET qty = qty - 1 WHERE user_id = $1 AND item_id = $2', [uid, rows[0].item_id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[pet/feed]', e);
    res.status(500).json({ error: '먹이 처리 오류' });
    client.release();
    return;
  }
  client.release();
  try {
    const pet = await tickPet(uid);
    if (!pet) { res.status(404).json({ error: '펫이 없습니다.' }); return; }
    const { rows: upd } = await pool.query(
      `UPDATE user_pet SET hunger = LEAST(100, hunger + $2), happiness = LEAST(100, happiness + $3), exp = exp + $4
        WHERE user_id = $1 RETURNING *`,
      [uid, fx.hunger ?? 0, fx.happiness ?? 0, fx.exp ?? 0]
    );
    res.json({ ok: true, pet: view(upd[0]) });
  } catch (e) {
    console.error('[pet/feed2]', e);
    res.status(500).json({ error: '먹이 처리 오류' });
  }
});

// 놀아주기 (무료)
petRouter.post('/play', async (req: AuthedRequest, res) => {
  try {
    const uid = req.user!.uid;
    const pet = await tickPet(uid);
    if (!pet) { res.status(404).json({ error: '펫이 없습니다.' }); return; }
    const { rows } = await pool.query(
      `UPDATE user_pet SET happiness = LEAST(100, happiness + 6), exp = exp + 2 WHERE user_id = $1 RETURNING *`,
      [uid]
    );
    res.json({ ok: true, pet: view(rows[0]) });
  } catch (e) {
    console.error('[pet/play]', e);
    res.status(500).json({ error: '놀아주기 오류' });
  }
});

// 이름 변경
petRouter.post('/name', async (req: AuthedRequest, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 12);
  if (!name) { res.status(400).json({ error: '이름을 입력하세요.' }); return; }
  try {
    const { rowCount } = await pool.query('UPDATE user_pet SET name = $2 WHERE user_id = $1', [req.user!.uid, name]);
    if (!rowCount) { res.status(404).json({ error: '펫이 없습니다.' }); return; }
    res.json({ ok: true });
  } catch (e) {
    console.error('[pet/name]', e);
    res.status(500).json({ error: '이름 변경 오류' });
  }
});

// 펫 꾸미기 — 보유한 pet_acc 장착/해제(null)
petRouter.put('/acc', async (req: AuthedRequest, res) => {
  const uid = req.user!.uid;
  const code = req.body?.code === null ? null : String(req.body?.code ?? '');
  try {
    if (code) {
      const { rows } = await pool.query(
        `SELECT 1 FROM user_inventory ui JOIN item i ON i.id = ui.item_id
          WHERE ui.user_id = $1 AND i.code = $2 AND i.slot = 'pet_acc'`,
        [uid, code]
      );
      if (!rows[0]) { res.status(403).json({ error: '보유하지 않은 펫 아이템입니다.' }); return; }
    }
    const { rowCount } = await pool.query('UPDATE user_pet SET accessory = $2 WHERE user_id = $1', [uid, code]);
    if (!rowCount) { res.status(404).json({ error: '펫이 없습니다.' }); return; }
    res.json({ ok: true });
  } catch (e) {
    console.error('[pet/acc]', e);
    res.status(500).json({ error: '꾸미기 처리 오류' });
  }
});
