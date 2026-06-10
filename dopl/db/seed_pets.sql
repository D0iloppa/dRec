-- 펫 종류 + 펫용품 시드. 재적용 안전.
INSERT INTO pet_species (code, name, asset, price) VALUES
  ('pet_dog',   '강아지', 'svg:pet_dog',   100),
  ('pet_cat',   '고양이', 'svg:pet_cat',   100),
  ('pet_chick', '병아리', 'svg:pet_chick', 50)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, asset = EXCLUDED.asset, price = EXCLUDED.price;

-- 펫용품 (item 테이블 재사용): pet_food/pet_snack=소모품(수량), pet_acc=꾸미기
INSERT INTO item (code, name, slot, asset, price, rarity) VALUES
  ('pet_food_basic',   '사료',       'pet_food',  'svg:pet_food_basic',   15,  'common'),
  ('pet_food_premium', '고급 사료',  'pet_food',  'svg:pet_food_premium', 40,  'rare'),
  ('pet_snack_cookie', '쿠키 간식',  'pet_snack', 'svg:pet_snack_cookie', 25,  'common'),
  ('pet_snack_cake',   '케이크 간식','pet_snack', 'svg:pet_snack_cake',   60,  'rare'),
  ('pet_acc_ribbon',   '펫 리본',    'pet_acc',   'svg:pet_acc_ribbon',   150, 'common'),
  ('pet_acc_hat',      '펫 모자',    'pet_acc',   'svg:pet_acc_hat',      200, 'rare')
ON CONFLICT (code) DO NOTHING;
UPDATE item SET enabled = true WHERE slot IN ('pet_food','pet_snack','pet_acc');
