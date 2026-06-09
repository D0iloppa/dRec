-- 아바타 아이템 시드 (SVG 플레이스홀더). price=0은 기본 무료(누구나 장착 가능).
-- asset = 'svg:<key>' — 클라이언트 SVG 렌더러가 key로 그린다. 추후 스프라이트로 교체.
INSERT INTO item (code, name, slot, asset, price, rarity) VALUES
  ('body_basic',   '기본 몸',     'body', 'svg:body_basic',   0,   'common'),
  ('face_smile',   '웃는 얼굴',   'face', 'svg:face_smile',   0,   'common'),
  ('face_cool',    '시크한 얼굴', 'face', 'svg:face_cool',    100, 'common'),
  ('hair_short',   '단발',        'hair', 'svg:hair_short',   0,   'common'),
  ('hair_spiky',   '스파이크',    'hair', 'svg:hair_spiky',   150, 'common'),
  ('hair_long',    '장발',        'hair', 'svg:hair_long',    150, 'rare'),
  ('top_tee',      '티셔츠',      'top',  'svg:top_tee',      0,   'common'),
  ('top_hoodie',   '후드티',      'top',  'svg:top_hoodie',   200, 'common'),
  ('top_suit',     '정장',        'top',  'svg:top_suit',     500, 'rare'),
  ('acc_glasses',  '안경',        'acc',  'svg:acc_glasses',  120, 'common'),
  ('acc_crown',    '왕관',        'acc',  'svg:acc_crown',    1000,'epic')
ON CONFLICT (code) DO NOTHING;
