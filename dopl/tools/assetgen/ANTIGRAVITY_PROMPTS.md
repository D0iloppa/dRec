# 안티그라비티 이미지 생성 프롬프트 (25장 예산)

> 사용법: 각 항목의 **레퍼런스 이미지를 첨부**하고 프롬프트를 붙여넣어 생성 →
> 결과 PNG를 **지정된 파일명으로** `dopl/assets_gen/v2/<m|f>/` 에 저장.
> 전부 모이면 아래 "사후 처리"의 명령만 실행하면 추출·검수·배포 준비까지 자동이다.

## 공통 주의
- 결과물은 **레퍼런스와 같은 구도/크기/스타일**이어야 한다 (편집 개념). 캐릭터가 다시 그려지거나 위치가 변하면 폐기 후 리롤.
- 배경은 항상 **균일한 마젠타(#FF00FF)** 유지. 텍스트/워터마크 금지.
- 마음에 안 들면 리롤 — 어차피 자동 게이트(audit)가 거른다.

---

## A. 수리 대상 8장 — 단일 착용샷 (레퍼런스: `assets_gen/v2/<g>/ref_b<i>.png`)

공통 프롬프트 틀 (아이템 부분만 교체):

```
Edit the reference image. It contains one character portrait. Put this on the character: {ITEM}.
CRITICAL: keep everything else EXACTLY identical to the reference — same canvas size, same layout,
same character position, same face, same body, same colors, same flat magenta background (#FF00FF).
Change nothing except adding the item. Same retro pixel art style. No text.
```

| # | 레퍼런스 첨부 | {ITEM} | 저장 파일명 |
|---|---|---|---|
| 1 | `v2/m/ref_b1.png` | a small golden royal crown worn on top of the head | `v2/m/wear_acc_crown_b1.png` |
| 2 | `v2/m/ref_b2.png` | a small golden royal crown worn on top of the head | `v2/m/wear_acc_crown_b2.png` |
| 3 | `v2/m/ref_b3.png` | a small golden royal crown worn on top of the head | `v2/m/wear_acc_crown_b3.png` |
| 4 | `v2/m/ref_b3.png` | black trendy sunglasses worn over the eyes | `v2/m/wear_acc_sunglasses_b3.png` |
| 5 | `v2/f/ref_b1.png` | a small golden royal crown worn on top of the head | `v2/f/wear_acc_crown_b1.png` |
| 6 | `v2/f/ref_b2.png` | a small golden royal crown worn on top of the head | `v2/f/wear_acc_crown_b2.png` |
| 7 | `v2/f/ref_b3.png` | a small golden royal crown worn on top of the head | `v2/f/wear_acc_crown_b3.png` |
| 8 | `v2/f/ref_b2.png` | black trendy sunglasses worn over the eyes | `v2/f/wear_acc_sunglasses_b2.png` |

---

## B. 신규 아이템 16장 — 3인 시트 착용샷 (레퍼런스: `assets_gen/v2/<g>/sheet_base.png`)

공통 프롬프트 틀:

```
Edit the reference image. It contains 3 character portraits in 3 vertical panels.
Put this on ALL 3 characters — every single panel MUST clearly show the item: {ITEM}.
CRITICAL: keep everything else EXACTLY identical to the reference — same canvas size, same panel
layout, same character positions, same faces, same bodies, same colors, same flat magenta
background (#FF00FF). Change nothing except adding the item. Same retro pixel art style. No text.
```

각 아이템당 남(`v2/m/sheet_base.png` 첨부) / 여(`v2/f/sheet_base.png` 첨부) 1장씩:

| # | 아이템 | {ITEM} | 저장 파일명 (`<g>`=m/f) |
|---|---|---|---|
| 9·10 | 스파이크 머리 | spiky dark-brown anime hair pointing upward (replace the current hairstyle) | `v2/<g>/sheet_wear_hair_spiky.png` |
| 11·12 | 포니테일 | navy-blue hair tied in a high ponytail with a small pink hair tie (replace the current hairstyle) | `v2/<g>/sheet_wear_hair_pony.png` |
| 13·14 | 정장 | a black formal suit with a white shirt and a red necktie, fully covering the chest and torso | `v2/<g>/sheet_wear_top_suit.png` |
| 15·16 | 줄무늬티 | an orange-and-white horizontally striped shirt, fully covering the chest and torso | `v2/<g>/sheet_wear_top_stripe.png` |
| 17·18 | 야구모자 | a red baseball cap worn forward on the head | `v2/<g>/sheet_wear_acc_cap.png` |
| 19·20 | 안경 | round thin-framed black glasses worn over the eyes | `v2/<g>/sheet_wear_acc_glasses.png` |
| 21·22 | 헤드폰 | big grey over-ear headphones worn on the head | `v2/<g>/sheet_wear_acc_headphone.png` |
| 23·24 | 리본 | a large pink ribbon bow on the side of the head | `v2/<g>/sheet_wear_acc_ribbon.png` |

(예비 1장: 실패분 리롤용)

---

## 사후 처리 (이미지가 모이면)

```bash
cd dopl/tools/assetgen
python3 assetgen.py refine     # 시트/단일 착용샷에서 overlay 추출 (정렬·구멍보정 자동, API 불필요)
python3 assetgen.py audit      # 품질 감사 — FAIL이 있으면 그 항목만 안티그라비티에서 리롤
python3 assetgen.py promote    # public/avatar 승격 (정렬 크롭 + 캔버스 통일)
```

신규 아이템(B)을 서비스에 노출하려면 추가로:
1. `apps/client/src/avatarRender.ts`의 `OVERLAY_ITEMS`에 코드 추가
2. DB: `UPDATE item SET enabled = true WHERE code IN ('hair_spiky', ...);` (seed_items.sql 말미 UPDATE도 갱신)
3. 클라 빌드 + `./dopl_deploy.sh`
