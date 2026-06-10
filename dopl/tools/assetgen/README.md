# DOPL 애셋 생성기 (나노바나나)

Gemini 이미지 모델(나노바나나)로 **베이스 캐릭터(남/여)** 와 **아이템별 착용샷**을 생성한다.
착용샷은 베이스 캐릭터 이미지를 레퍼런스로 첨부해 "같은 캐릭터가 해당 아이템만 바꾼 모습"으로
만들어지므로 캐릭터 일관성이 유지된다.

## 준비
```bash
pip install requests pillow
cp .env.example .env   # GEMINI_API_KEY 입력
```

## 사용
```bash
python3 assetgen.py check                 # 키/모델 동작 확인
python3 assetgen.py base                  # 베이스 캐릭터 생성 (남/여)
python3 assetgen.py item top_hoodie       # 특정 아이템 착용샷 (남녀)
python3 assetgen.py item acc_crown --gender f
python3 assetgen.py all                   # 전체 아이템 (이미 있으면 건너뜀)
python3 assetgen.py all --slot acc --force
```

## 산출물 / 워크플로
1. 생성 결과는 `dopl/assets_gen/<m|f>/` 에 저장 (base.png, wear_<code>.png — 투명 배경 PNG)
2. **검수 후** 마음에 드는 것만 `dopl/apps/client/public/avatar/<m|f>/` 로 복사해 클라이언트에 연결
3. 마음에 안 들면 같은 명령 재실행(생성마다 결과가 달라짐) 또는 items.json 프롬프트 수정

## 새 아이템 추가 절차
1. `db/seed_items.sql` 에 아이템 추가 (code/slot/price)
2. `items.json` 에 같은 code로 영어 프롬프트 추가
3. `python3 assetgen.py item <code>` 로 착용샷 생성 → 검수 → public 복사
4. (현재는 클라 `avatar.ts`의 SVG placeholder가 렌더 — PNG 전환 시 code 단위로 교체)

## 스타일 변경
`assetgen.py` 상단 `STYLE`/`BASE_PROMPTS` 상수가 전체 룩을 결정한다. 스타일을 바꾸면
**base부터 다시 생성**해야 착용샷 일관성이 유지된다.

## v2: base + overlay 레이어 구조 (현행)
```bash
python3 assetgen.py bases                       # 벗은 base 남녀 각 3종 (시트 1요청→3분할)
python3 assetgen.py overlay top_hoodie          # 아이템 overlay (base별 1장, diff 추출)
python3 assetgen.py --gender m compose 1 top_hoodie acc_crown   # 합성 미리보기(QA)
```
산출물: `assets_gen/v2/<m|f>/base{1..3}.png`, `overlay_<code>_b{1..3}.png`, `preview_*.png`
