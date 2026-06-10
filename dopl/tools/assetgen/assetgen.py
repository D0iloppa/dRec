#!/usr/bin/env python3
"""DOPL 애셋 생성기 — 나노바나나(Gemini 이미지 모델)로 캐릭터/아이템 착용샷 생성.

사용법:
  python3 assetgen.py check                  # API 키/모델 동작 확인
  python3 assetgen.py base                   # 남/여 베이스 캐릭터 생성 (base_m.png, base_f.png)
  python3 assetgen.py item top_hoodie        # 아이템 착용샷 (베이스 이미지를 레퍼런스로, 남녀 각각)
  python3 assetgen.py item top_hoodie --gender f
  python3 assetgen.py all                    # items.json 전체 아이템 착용샷
  python3 assetgen.py all --slot acc         # 특정 슬롯만

설정:
  같은 디렉토리의 .env 파일에 GEMINI_API_KEY=<키> 저장 (gitignore 됨).
  모델 변경: .env에 GEMINI_IMAGE_MODEL=gemini-3-pro-image-preview 등.

산출물:
  dopl/assets_gen/<gender>/base.png, wear_<code>.png
  (검수 후 dopl/apps/client/public/avatar/ 로 복사해 사용)

의존성: pip install requests pillow
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import time
from pathlib import Path

import requests
from PIL import Image

HERE = Path(__file__).resolve().parent
OUT_ROOT = HERE.parent.parent / "assets_gen"  # dopl/assets_gen
DEFAULT_MODEL = "gemini-2.5-flash-image"

# 공통 스타일 — 모든 애셋이 같은 룩을 유지하도록 한 곳에서 관리.
# 톤 레퍼런스: ref/tone.png (큐플레이 아바타 스프라이트 — 빅헤드+작은 상체, 도트, 맨몸 베이스)
STYLE = (
    "retro early-2000s Korean online game avatar sprite, pixel art (dot art) style "
    "like classic QPlay/Fortress era Korean casual game avatars, "
    "exaggerated game-avatar proportion: big head with small narrow shoulders and upper body, "
    "crisp clean pixels, dark bold outlines, strong shading, "
    "adult facial features with attitude (smirk/cool expression — not a childish cute illustration), "
    "bust-up (head and upper torso), facing front, centered, "
    "background must be one perfectly flat uniform magenta color (#FF00FF) with absolutely "
    "no dithering, no noise, no gradient on the background, no text, no watermark, no frame"
)

BASE_PROMPTS = {
    "m": (
        "A young adult Korean man with short black hair, sharp eyes and a confident smirk, "
        "wearing a plain white t-shirt. " + STYLE
    ),
    "f": (
        "A young adult Korean woman with shoulder-length dark hair, confident stylish expression "
        "and light makeup, wearing a plain white t-shirt. " + STYLE
    ),
}


def load_env() -> dict:
    env = {}
    env_path = HERE / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def gen_image(prompt: str, ref_images: list[bytes] | None = None, retries: int = 3) -> bytes:
    """나노바나나 호출 — 텍스트(+레퍼런스 이미지) → PNG bytes."""
    env = load_env()
    key = env.get("GEMINI_API_KEY")
    if not key:
        sys.exit(f"GEMINI_API_KEY가 없습니다. {HERE / '.env'} 파일에 GEMINI_API_KEY=<키> 를 저장하세요.")
    model = env.get("GEMINI_IMAGE_MODEL", DEFAULT_MODEL)

    parts: list[dict] = []
    for ref in ref_images or []:
        parts.append({"inline_data": {"mime_type": "image/png", "data": base64.b64encode(ref).decode()}})
    parts.append({"text": prompt})

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {"contents": [{"parts": parts}]}

    last_err = ""
    for attempt in range(1, retries + 1):
        r = requests.post(url, json=body, headers={"x-goog-api-key": key}, timeout=120)
        if r.status_code == 200:
            data = r.json()
            for part in data.get("candidates", [{}])[0].get("content", {}).get("parts", []):
                inline = part.get("inlineData") or part.get("inline_data")
                if inline and inline.get("data"):
                    return base64.b64decode(inline["data"])
            last_err = "응답에 이미지가 없음: " + json.dumps(data)[:300]
        else:
            last_err = f"HTTP {r.status_code}: {r.text[:300]}"
        if attempt < retries:
            time.sleep(2 * attempt)
    sys.exit(f"이미지 생성 실패 ({retries}회 시도): {last_err}")


def chroma_key(png: bytes) -> bytes:
    """마젠타(#FF00FF) 배경 → 투명.
    의상의 핑크/마젠타를 지우지 않도록 테두리에서 flood-fill로 배경에 '연결된' 픽셀만 제거한다.
    (디더링된 어두운 마젠타까지 잡도록 비율 기반 판정)
    """
    img = Image.open(io.BytesIO(png)).convert("RGBA")
    px = img.load()
    w, h = img.size

    def is_bg(p):
        r, g, b, _ = p
        return r > g + 40 and b > g + 40 and r > 90 and b > 90

    seen = bytearray(w * h)
    stack = []
    for x in range(w):
        for y in (0, h - 1):
            if is_bg(px[x, y]):
                stack.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_bg(px[x, y]):
                stack.append((x, y))
    while stack:
        x, y = stack.pop()
        idx = y * w + x
        if seen[idx]:
            continue
        seen[idx] = 1
        if not is_bg(px[x, y]):
            continue
        px[x, y] = (0, 0, 0, 0)
        if x > 0: stack.append((x - 1, y))
        if x < w - 1: stack.append((x + 1, y))
        if y > 0: stack.append((x, y - 1))
        if y < h - 1: stack.append((x, y + 1))

    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def save(path: Path, png: bytes, transparent: bool):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(chroma_key(png) if transparent else png)
    print(f"  → {path.relative_to(OUT_ROOT.parent)}")


def load_items() -> list[dict]:
    return json.loads((HERE / "items.json").read_text(encoding="utf-8"))


def base_path(gender: str) -> Path:
    # 확정(승격)된 베이스가 있으면 그것을 레퍼런스로 사용 — 톤 일관성의 단일 원본 (STYLE_GUIDE.md 참고)
    ref = HERE / "ref" / f"base_{gender}.png"
    if ref.exists():
        return ref
    return OUT_ROOT / gender / "base.png"


# ── v2: base + 아이템 overlay 레이어 구조 ─────────────────────────
# base는 그대로 두고, 아이템은 "그 base에 맞춘 overlay(아이템만, 나머지 투명)"로 생성해
# 클라이언트에서 base 위에 합성한다. 토큰 절약을 위해 3분할 시트로 한 번에 생성 후 slice.
V2_ROOT = OUT_ROOT / "v2"
BASES_PER_GENDER = 3

BASE_VARIANTS = {
    "m": [
        "short neat black hair, sharp eyes, confident smirk",
        "wavy brown medium hair, friendly grin, slightly tanned skin",
        "buzz-cut hair, stern cool expression, strong jaw",
    ],
    "f": [
        "shoulder-length dark hair, confident stylish expression, light makeup",
        "long wavy blonde hair, bright cheerful smile",
        "short bob black hair with blunt bangs, cool chic expression",
    ],
}

SHEET_RULE = (
    "Create ONE image divided into exactly 3 equal vertical panels side by side (left, middle, right). "
    "Do not draw panel borders. "
)


def v2_sheet_path(gender: str) -> Path:
    return V2_ROOT / gender / "sheet_base.png"


def slice3(png: bytes) -> list[bytes]:
    img = Image.open(io.BytesIO(png)).convert("RGBA")
    w, h = img.size
    out = []
    for i in range(3):
        part = img.crop((w * i // 3, 0, w * (i + 1) // 3, h))
        buf = io.BytesIO()
        part.save(buf, format="PNG")
        out.append(buf.getvalue())
    return out


def cmd_bases(args):
    """성별당 1요청 — 서로 다른 base 3종을 3분할 시트로 생성 후 slice.
    base는 '아무것도 안 입은 상태'(상의 미착용) — 아이템 overlay가 위에 합성된다."""
    word = {"m": "man", "f": "woman"}
    bare = {
        "m": "completely shirtless bare upper body (no shirt, no clothing on torso)",
        "f": "wearing only a plain light-grey bandeau underwear top (no other clothing on torso)",
    }
    tone = (HERE / "ref" / "tone.png").read_bytes()
    for g in args.genders:
        variants = BASE_VARIANTS[g]
        prompt = (
            "Match the art style, pixel density, proportions and tone of the provided reference sprite EXACTLY. "
            + SHEET_RULE
            + f"In each panel, one DIFFERENT young adult Korean {word[g]}, {bare[g]}, bust-up, all in the SAME art style: "
            + " ".join(f"Panel {i + 1}: {v}." for i, v in enumerate(variants))
            + " " + STYLE
        )
        print(f"[bases:{g}] 시트 생성 중…")
        png = gen_image(prompt, ref_images=[tone])
        (V2_ROOT / g).mkdir(parents=True, exist_ok=True)
        v2_sheet_path(g).write_bytes(png)  # 레퍼런스용 원본(마젠타 유지) 보존
        for i, part in enumerate(slice3(png), start=1):
            save(V2_ROOT / g / f"base{i}.png", part, not args.keep_bg)



def _is_magenta(p) -> bool:
    r, g, b = p[0], p[1], p[2]
    return r > g + 40 and b > g + 40 and r > 90 and b > 90


def content_bbox(img: Image.Image):
    """마젠타 배경을 제외한 콘텐츠(캐릭터) bbox — 패널 라인 같은 가는 줄은 밀도 필터로 무시."""
    W, H = img.size
    px = img.load()
    rows = [0] * H
    cols = [0] * W
    for y in range(H):
        for x in range(W):
            if not _is_magenta(px[x, y]):
                rows[y] += 1
                cols[x] += 1
    ys = [y for y in range(H) if rows[y] >= 12]
    xs = [x for x in range(W) if cols[x] >= 12]
    if not ys or not xs:
        return None
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def _small_mask(img: Image.Image, ds: int = 4):
    """다운스케일 콘텐츠(비마젠타) 마스크 — 정렬 탐색용."""
    w, h = max(1, img.width // ds), max(1, img.height // ds)
    sm = img.resize((w, h))
    px = sm.load()
    return [bytearray(1 if not _is_magenta(px[x, y]) else 0 for x in range(w)) for y in range(h)], w, h


def align_to_base(b_img: Image.Image, w_img: Image.Image) -> Image.Image:
    """착용샷을 base 캔버스에 정렬 — 균등 스케일(비율 보존) + 위치 탐색(마스크 겹침 최대화).
    모델이 임의 해상도(예: 544x1920)로 출력해도 캐릭터끼리 픽셀 단위로 맞춘다."""
    if w_img.size == b_img.size:
        return w_img
    bb = content_bbox(b_img)
    wb = content_bbox(w_img)
    if not bb or not wb:
        return w_img.resize(b_img.size)
    DS = 4
    bmask, bw, bh = _small_mask(b_img, DS)
    s0 = (bb[3] - bb[1]) / max(1, wb[3] - wb[1])  # 높이 기준 1차 스케일
    best = (None, -1)  # ((scale, ox, oy), score)
    for f in (0.90, 0.95, 1.0, 1.05, 1.10):
        sc = s0 * f
        scaled = w_img.resize((max(1, int(w_img.width * sc)), max(1, int(w_img.height * sc))))
        sb = content_bbox(scaled)
        if not sb:
            continue
        wmask, ww, wh = _small_mask(scaled, DS)
        # 기준 배치: 콘텐츠 bbox 상단-중앙 정렬
        ox0 = ((bb[0] + bb[2]) // 2 - (sb[0] + sb[2]) // 2) // DS
        oy0 = (bb[1] - sb[1]) // DS
        for dy in range(-6, 7):
            for dx in range(-6, 7):
                ox, oy = ox0 + dx, oy0 + dy
                score = 0
                for y in range(bh):
                    wy = y - oy
                    if 0 <= wy < wh:
                        brow = bmask[y]
                        wrow = wmask[wy]
                        for x in range(0, bw, 2):  # 2px 샘플링으로 가속
                            wx = x - ox
                            if 0 <= wx < ww and brow[x] and wrow[wx]:
                                score += 1
                if score > best[1]:
                    best = ((sc, ox * DS, oy * DS), score)
    if best[0] is None:
        return w_img.resize(b_img.size)
    sc, ox, oy = best[0]
    scaled = w_img.resize((max(1, int(w_img.width * sc)), max(1, int(w_img.height * sc))))
    canvas = Image.new("RGBA", b_img.size, (255, 0, 255, 255))
    canvas.paste(scaled, (ox, oy))
    return canvas


def _neighbors8(mask: bytearray, W: int, H: int, x: int, y: int) -> int:
    n = 0
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and mask[ny * W + nx]:
                n += 1
    return n


def diff_overlay(base_png: bytes, wear_png: bytes, thr: int = 90) -> bytes:
    """overlay = (착용샷 - base) 픽셀 diff. 바뀐 픽셀만 남기고 나머지는 투명.
    모델에게 '아이템만 그려라'를 시키는 것보다 '입혀진 모습으로 편집'이 정렬·품질이 좋아서,
    착용샷을 받아 base와의 차이를 overlay 레이어로 추출한다.
    깨짐 방지 보정: ① 구멍 메우기(이웃 다수가 마스크면 포함, 3회) ② 점노이즈/잔 성분 제거."""
    b = Image.open(io.BytesIO(base_png)).convert("RGBA")
    w_img = Image.open(io.BytesIO(wear_png)).convert("RGBA")
    w_img = align_to_base(b, w_img)
    W, H = b.size
    bp, wp = b.load(), w_img.load()
    mask = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            r1, g1, b1, _ = bp[x, y]
            r2, g2, b2, _ = wp[x, y]
            if _is_magenta((r2, g2, b2)):
                continue  # 배경 픽셀은 아이템이 아님 — 마젠타 누설 방지
            if abs(r1 - r2) + abs(g1 - g2) + abs(b1 - b2) > thr:
                mask[y * W + x] = 1

    # ① 구멍 메우기 — 아이템 내부에서 base와 색이 비슷해 빠진 픽셀을 이웃 기반으로 복원
    for _ in range(3):
        add = []
        for y in range(H):
            for x in range(W):
                if not mask[y * W + x] and _neighbors8(mask, W, H, x, y) >= 5:
                    add.append((x, y))
        if not add:
            break
        for x, y in add:
            mask[y * W + x] = 1

    # ② 잔 성분 제거 — 연결 성분이 40px 미만이면 노이즈로 보고 버림
    seen = bytearray(W * H)
    for y0 in range(H):
        for x0 in range(W):
            i0 = y0 * W + x0
            if not mask[i0] or seen[i0]:
                continue
            comp = []
            stack = [(x0, y0)]
            seen[i0] = 1
            while stack:
                x, y = stack.pop()
                comp.append((x, y))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < W and 0 <= ny < H:
                            ni = ny * W + nx
                            if mask[ni] and not seen[ni]:
                                seen[ni] = 1
                                stack.append((nx, ny))
            if len(comp) < 40:
                for x, y in comp:
                    mask[y * W + x] = 0

    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    op = out.load()
    for y in range(H):
        for x in range(W):
            if mask[y * W + x]:
                op[x, y] = wp[x, y]
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


# 게임 카탈로그 키비주얼 (방 만들기 카드용) — 캐릭터 톤과 같은 레트로 도트 일러스트
GAME_CARDS = {
    "ox-quiz": "A quiz game key visual: a giant blue O panel and a red X panel on a game-show stage, "
               "spotlights, tense crowd silhouettes below",
    "common-quiz": "A quiz game key visual: four colorful answer cards (1,2,3,4) floating over a podium, "
                   "a glowing light bulb above, confetti",
    "speed-quiz": "A typing speed-quiz key visual: a lightning bolt striking a retro keyboard, "
                  "racing speech bubbles with Korean consonant hints, speed lines",
    "mafia": "A mafia party game key visual: a noir night city, full moon, a mysterious fedora-wearing "
             "silhouette holding a knife behind his back, dramatic shadows",
}


def cmd_gamecard(args):
    """게임 키비주얼 생성 — public/games/<type>.png 로 쓸 카드 아트 (배경 유지, 투명화 없음)."""
    out_dir = OUT_ROOT / "games"
    for t, desc in GAME_CARDS.items():
        if args.code and args.code != t:
            continue
        prompt = (
            desc + ". Retro early-2000s Korean online game illustration in detailed pixel art (dot art) style, "
            "vivid saturated colors, dark bold outlines, dynamic composition, landscape orientation, "
            "no text, no logo, no watermark, fills the entire frame edge to edge."
        )
        print(f"[gamecard {t}] 생성 중…")
        png = gen_image(prompt)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"{t}.png").write_bytes(png)
        print(f"  → assets_gen/games/{t}.png")


def cmd_refine(args):
    """보관된 착용 시트(sheet_wear_*)에서 overlay를 재추출 — API 비용 없이 깨짐 보정 적용.
    시트에 없던 패널(단일 폴백으로 만든 것)은 기존 파일을 유지한다."""
    for g in args.genders:
        sheet = v2_sheet_path(g)
        if not sheet.exists():
            continue
        base_parts = slice3(sheet.read_bytes())
        for wear_p in sorted((V2_ROOT / g).glob("sheet_wear_*.png")):
            code = wear_p.stem.replace("sheet_wear_", "")
            if args.code and args.code != code:
                continue
            wear_parts = slice3(wear_p.read_bytes())
            for i in range(3):
                # 단일 폴백 착용샷이 있으면 그것을 우선 사용 (시트보다 그 base에 정확)
                single_p = V2_ROOT / g / f"wear_{code}_b{i + 1}.png"
                src = single_p.read_bytes() if single_p.exists() else wear_parts[i]
                ov = diff_overlay(base_parts[i], src)
                p = V2_ROOT / g / f"overlay_{code}_b{i + 1}.png"
                if is_ghost(ov):
                    print(f"  [{code}:{g} b{i + 1}] 아이템 없음 — 기존 overlay 유지")
                    continue
                p.write_bytes(ov)
                print(f"  → {p.relative_to(OUT_ROOT.parent)} (재추출)")


def is_ghost(overlay_png: bytes) -> bool:
    """아이템이 실제로 그려졌는지 판별 — 고스트(윤곽 노이즈)는 바운딩박스 대비 픽셀 밀도가 낮다."""
    img = Image.open(io.BytesIO(overlay_png)).convert("RGBA")
    alpha = img.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        return True  # 완전 빈 overlay
    visible = sum(1 for a in alpha.getdata() if a > 0)
    if visible < 800:
        return True  # 사실상 빈 overlay
    area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    return area == 0 or visible / area < 0.12


def wear_edit_prompt(item: dict, multi: bool) -> str:
    target = (
        "It contains 3 character portraits in 3 vertical panels. "
        "Put this on ALL 3 characters — every single panel MUST clearly show the item: "
        if multi
        else "It contains one character portrait. Put this on the character: "
    )
    return (
        "Edit the reference image. " + target + f"{item['prompt']}. "
        "CRITICAL: keep everything else EXACTLY identical to the reference — same canvas size, "
        "same layout, same character positions, same faces, same bodies, same colors, "
        "same flat magenta background (#FF00FF). Change nothing except adding the item. "
        "Same retro pixel art style. No text."
    )



def torso_coverage(ov_png: bytes) -> float:
    """상의 overlay의 몸통 중앙부(폭 25~75%, 높이 45~90%) 불투명 비율 — 뚫린 옷 감지용."""
    img = Image.open(io.BytesIO(ov_png)).convert("RGBA")
    a = img.getchannel("A")
    bbox = a.getbbox()
    if not bbox:
        return 0.0
    x0, y0, x1, y1 = bbox
    cx0 = x0 + int((x1 - x0) * 0.25)
    cx1 = x0 + int((x1 - x0) * 0.75)
    cy0 = y0 + int((y1 - y0) * 0.45)
    cy1 = y0 + int((y1 - y0) * 0.90)
    ad = a.load()
    total = vis = 0
    for y in range(cy0, cy1):
        for x in range(cx0, cx1):
            total += 1
            if ad[x, y] > 0:
                vis += 1
    return vis / total if total else 0.0


def cmd_overlay(args):
    """아이템 overlay — base 시트를 '아이템을 입힌 모습'으로 편집 생성(시트 1요청)하고
    base와의 픽셀 diff로 아이템 레이어만 추출. 모델이 일부 패널에 아이템을 빠뜨리면
    (고스트 감지) 해당 base만 단일 편집으로 폴백 재생성한다."""
    items = {i["code"]: i for i in load_items()}
    if args.code not in items:
        sys.exit(f"items.json에 없는 코드: {args.code}")
    item = items[args.code]
    for g in args.genders:
        sheet = v2_sheet_path(g)
        if not sheet.exists():
            sys.exit(f"base 시트가 없습니다: {sheet} — 먼저 `python3 assetgen.py bases` 실행")
        raw = sheet.read_bytes()
        print(f"[overlay {item['code']}:{g}] 착용 시트 생성 중…")
        wear = gen_image(wear_edit_prompt(item, multi=True), ref_images=[raw])
        (V2_ROOT / g / f"sheet_wear_{item['code']}.png").write_bytes(wear)
        base_parts = slice3(raw)
        wear_parts = slice3(wear)
        for i in range(3):
            ov = diff_overlay(base_parts[i], wear_parts[i])
            if is_ghost(ov):
                # 폴백: 이 base 한 장만 단일 편집 → diff
                print(f"  [b{i + 1}] 시트에서 누락 감지 — 단일 base로 재생성")
                single = gen_image(wear_edit_prompt(item, multi=False), ref_images=[base_parts[i]])
                (V2_ROOT / g / f"wear_{item['code']}_b{i + 1}.png").write_bytes(single)
                ov = diff_overlay(base_parts[i], single)
                if is_ghost(ov):
                    print(f"  ⚠ b{i + 1} 재생성도 실패 — 수동 확인 필요")
            # 품질 게이트: 상의는 몸통이 충분히 덮여야 함 (뚫린 옷 → 자동 재생성)
            if item["slot"] == "top":
                best, best_cov = ov, torso_coverage(ov)
                tries = 0
                while best_cov < 0.85 and tries < 3:
                    tries += 1
                    print(f"  [b{i + 1}] 몸통 커버리지 {best_cov:.2f} < 0.85 — 재생성 {tries}/3")
                    single = gen_image(wear_edit_prompt(item, multi=False), ref_images=[base_parts[i]])
                    cand = diff_overlay(base_parts[i], single)
                    cov = torso_coverage(cand)
                    if cov > best_cov:
                        best, best_cov = cand, cov
                        (V2_ROOT / g / f"wear_{item['code']}_b{i + 1}.png").write_bytes(single)
                ov = best
                print(f"  [b{i + 1}] 최종 몸통 커버리지 {best_cov:.2f}")
            p = V2_ROOT / g / f"overlay_{item['code']}_b{i + 1}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(ov)
            print(f"  → {p.relative_to(OUT_ROOT.parent)}")


def cmd_compose(args):
    """QA용 — base{n} 위에 overlay들을 합성한 미리보기 생성."""
    g = args.genders[0]
    base = V2_ROOT / g / f"base{args.base}.png"
    if not base.exists():
        sys.exit(f"없음: {base}")
    img = Image.open(base).convert("RGBA")
    for code in args.codes:
        ov_path = V2_ROOT / g / f"overlay_{code}_b{args.base}.png"
        if not ov_path.exists():
            sys.exit(f"overlay 없음: {ov_path}")
        ov = Image.open(ov_path).convert("RGBA").resize(img.size)
        img = Image.alpha_composite(img, ov)
    out = V2_ROOT / g / f"preview_b{args.base}_{'_'.join(args.codes)}.png"
    img.save(out)
    print(f"  → {out.relative_to(OUT_ROOT.parent)}")


def cmd_promote(args):
    """v2 산출물을 client public으로 승격 — 아바타 표준 규격으로 정규화.
    표준(작은 아바타 룩 = 남 b1/b3 기준): 캔버스 320x480, 머리폭(헤어 포함 상단 최대폭) 195px,
    콘텐츠 상단을 y=88에 고정(top-anchor, 위 88px는 왕관/모자 여유), 하단 초과분은 잘림(버스트컷).
    base 1세트(베이스+overlay)는 같은 배율·오프셋으로 변환해 레이어 정렬을 보존한다."""
    STD_W, STD_H = 320, 480
    STD_HEAD_W = 195
    TOP_Y = 88
    pub_root = HERE.parent.parent / "apps" / "client" / "public" / "avatar"
    for g in args.genders:
        gdir = V2_ROOT / g
        for i in (1, 2, 3):
            base_p = gdir / f"base{i}.png"
            if not base_p.exists():
                continue
            layers = [("base", base_p)] + [
                (p.stem.replace("overlay_", "").replace(f"_b{i}", ""), p)
                for p in sorted(gdir.glob(f"overlay_*_b{i}.png"))
            ]
            imgs = {}
            for name, p in layers:
                img = Image.open(p).convert("RGBA")
                W, H = img.size
                px = img.load()
                ad = img.getchannel("A").load()
                # 슬라이스 경계의 패널 라인 잔재 제거
                for x in list(range(min(16, W))) + list(range(max(0, W - 16), W)):
                    cnt = sum(1 for y in range(H) if ad[x, y] > 0)
                    if cnt > H * 0.6:
                        for y in range(H):
                            px[x, y] = (0, 0, 0, 0)
                imgs[name] = img
            base_img = imgs["base"]
            a = base_img.getchannel("A").load()
            W, H = base_img.size
            rows = [sum(1 for x in range(W) if a[x, y] > 0) for y in range(H)]
            cols = [sum(1 for y in range(H) if a[x, y] > 0) for x in range(W)]
            ys = [y for y in range(H) if rows[y] >= 12]
            xs = [x for x in range(W) if cols[x] >= 12]
            if not ys or not xs:
                print(f"  ⚠ {g}/b{i}: base 콘텐츠 없음 — 건너뜀")
                continue
            y0, y1, x0, x1 = min(ys), max(ys) + 1, min(xs), max(xs) + 1
            ch = y1 - y0
            head_w = max(rows[y] for y in range(y0 + int(ch * 0.08), y0 + int(ch * 0.30)))
            s = STD_HEAD_W / head_w
            cx = ((x0 + x1) / 2) * s
            ox = round(STD_W / 2 - cx)
            oy = round(TOP_Y - y0 * s)
            out_dir = pub_root / g / f"b{i}"
            out_dir.mkdir(parents=True, exist_ok=True)
            for name, img in imgs.items():
                scaled = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.NEAREST)
                canvas = Image.new("RGBA", (STD_W, STD_H), (0, 0, 0, 0))
                canvas.paste(scaled, (ox, oy), scaled)
                canvas.save(out_dir / f"{name}.png")
            print(f"  → public/avatar/{g}/b{i}/ ({len(imgs)}개, head_w {head_w}→{STD_HEAD_W} scale={s:.2f})")


# 게임 카탈로그 키비주얼 (방 만들기 카드용) — 캐릭터 톤과 같은 레트로 도트 일러스트
GAME_CARDS = {
    "ox-quiz": "A quiz game key visual: a giant blue O panel and a red X panel on a game-show stage, "
               "spotlights, tense crowd silhouettes below",
    "common-quiz": "A quiz game key visual: four colorful answer cards (1,2,3,4) floating over a podium, "
                   "a glowing light bulb above, confetti",
    "speed-quiz": "A typing speed-quiz key visual: a lightning bolt striking a retro keyboard, "
                  "racing speech bubbles with Korean consonant hints, speed lines",
    "mafia": "A mafia party game key visual: a noir night city, full moon, a mysterious fedora-wearing "
             "silhouette holding a knife behind his back, dramatic shadows",
}


def cmd_gamecard(args):
    """게임 키비주얼 생성 — public/games/<type>.png 로 쓸 카드 아트 (배경 유지, 투명화 없음)."""
    out_dir = OUT_ROOT / "games"
    for t, desc in GAME_CARDS.items():
        if args.code and args.code != t:
            continue
        prompt = (
            desc + ". Retro early-2000s Korean online game illustration in detailed pixel art (dot art) style, "
            "vivid saturated colors, dark bold outlines, dynamic composition, landscape orientation, "
            "no text, no logo, no watermark, fills the entire frame edge to edge."
        )
        print(f"[gamecard {t}] 생성 중…")
        png = gen_image(prompt)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"{t}.png").write_bytes(png)
        print(f"  → assets_gen/games/{t}.png")


def cmd_refine(args):
    """보관된 착용 시트(sheet_wear_*)에서 overlay를 재추출 — API 비용 없이 깨짐 보정 적용.
    시트에 없던 패널(단일 폴백으로 만든 것)은 기존 파일을 유지한다."""
    for g in args.genders:
        sheet = v2_sheet_path(g)
        if not sheet.exists():
            continue
        base_parts = slice3(sheet.read_bytes())
        for wear_p in sorted((V2_ROOT / g).glob("sheet_wear_*.png")):
            code = wear_p.stem.replace("sheet_wear_", "")
            if args.code and args.code != code:
                continue
            wear_parts = slice3(wear_p.read_bytes())
            for i in range(3):
                # 단일 폴백 착용샷이 있으면 그것을 우선 사용 (시트보다 그 base에 정확)
                single_p = V2_ROOT / g / f"wear_{code}_b{i + 1}.png"
                src = single_p.read_bytes() if single_p.exists() else wear_parts[i]
                ov = diff_overlay(base_parts[i], src)
                p = V2_ROOT / g / f"overlay_{code}_b{i + 1}.png"
                if is_ghost(ov):
                    print(f"  [{code}:{g} b{i + 1}] 아이템 없음 — 기존 overlay 유지")
                    continue
                p.write_bytes(ov)
                print(f"  → {p.relative_to(OUT_ROOT.parent)} (재추출)")


def is_ghost(overlay_png: bytes) -> bool:
    """아이템이 실제로 그려졌는지 판별 — 고스트(윤곽 노이즈)는 바운딩박스 대비 픽셀 밀도가 낮다."""
    img = Image.open(io.BytesIO(overlay_png)).convert("RGBA")
    alpha = img.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        return True  # 완전 빈 overlay
    visible = sum(1 for a in alpha.getdata() if a > 0)
    if visible < 800:
        return True  # 사실상 빈 overlay
    area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    return area == 0 or visible / area < 0.12


def wear_edit_prompt(item: dict, multi: bool) -> str:
    target = (
        "It contains 3 character portraits in 3 vertical panels. "
        "Put this on ALL 3 characters — every single panel MUST clearly show the item: "
        if multi
        else "It contains one character portrait. Put this on the character: "
    )
    return (
        "Edit the reference image. " + target + f"{item['prompt']}. "
        "CRITICAL: keep everything else EXACTLY identical to the reference — same canvas size, "
        "same layout, same character positions, same faces, same bodies, same colors, "
        "same flat magenta background (#FF00FF). Change nothing except adding the item. "
        "Same retro pixel art style. No text."
    )



def torso_coverage(ov_png: bytes) -> float:
    """상의 overlay의 몸통 중앙부(폭 25~75%, 높이 45~90%) 불투명 비율 — 뚫린 옷 감지용."""
    img = Image.open(io.BytesIO(ov_png)).convert("RGBA")
    a = img.getchannel("A")
    bbox = a.getbbox()
    if not bbox:
        return 0.0
    x0, y0, x1, y1 = bbox
    cx0 = x0 + int((x1 - x0) * 0.25)
    cx1 = x0 + int((x1 - x0) * 0.75)
    cy0 = y0 + int((y1 - y0) * 0.45)
    cy1 = y0 + int((y1 - y0) * 0.90)
    ad = a.load()
    total = vis = 0
    for y in range(cy0, cy1):
        for x in range(cx0, cx1):
            total += 1
            if ad[x, y] > 0:
                vis += 1
    return vis / total if total else 0.0


def cmd_overlay(args):
    """아이템 overlay — base 시트를 '아이템을 입힌 모습'으로 편집 생성(시트 1요청)하고
    base와의 픽셀 diff로 아이템 레이어만 추출. 모델이 일부 패널에 아이템을 빠뜨리면
    (고스트 감지) 해당 base만 단일 편집으로 폴백 재생성한다."""
    items = {i["code"]: i for i in load_items()}
    if args.code not in items:
        sys.exit(f"items.json에 없는 코드: {args.code}")
    item = items[args.code]
    for g in args.genders:
        sheet = v2_sheet_path(g)
        if not sheet.exists():
            sys.exit(f"base 시트가 없습니다: {sheet} — 먼저 `python3 assetgen.py bases` 실행")
        raw = sheet.read_bytes()
        print(f"[overlay {item['code']}:{g}] 착용 시트 생성 중…")
        wear = gen_image(wear_edit_prompt(item, multi=True), ref_images=[raw])
        (V2_ROOT / g / f"sheet_wear_{item['code']}.png").write_bytes(wear)
        base_parts = slice3(raw)
        wear_parts = slice3(wear)
        for i in range(3):
            ov = diff_overlay(base_parts[i], wear_parts[i])
            if is_ghost(ov):
                # 폴백: 이 base 한 장만 단일 편집 → diff
                print(f"  [b{i + 1}] 시트에서 누락 감지 — 단일 base로 재생성")
                single = gen_image(wear_edit_prompt(item, multi=False), ref_images=[base_parts[i]])
                (V2_ROOT / g / f"wear_{item['code']}_b{i + 1}.png").write_bytes(single)
                ov = diff_overlay(base_parts[i], single)
                if is_ghost(ov):
                    print(f"  ⚠ b{i + 1} 재생성도 실패 — 수동 확인 필요")
            # 품질 게이트: 상의는 몸통이 충분히 덮여야 함 (뚫린 옷 → 자동 재생성)
            if item["slot"] == "top":
                best, best_cov = ov, torso_coverage(ov)
                tries = 0
                while best_cov < 0.85 and tries < 3:
                    tries += 1
                    print(f"  [b{i + 1}] 몸통 커버리지 {best_cov:.2f} < 0.85 — 재생성 {tries}/3")
                    single = gen_image(wear_edit_prompt(item, multi=False), ref_images=[base_parts[i]])
                    cand = diff_overlay(base_parts[i], single)
                    cov = torso_coverage(cand)
                    if cov > best_cov:
                        best, best_cov = cand, cov
                        (V2_ROOT / g / f"wear_{item['code']}_b{i + 1}.png").write_bytes(single)
                ov = best
                print(f"  [b{i + 1}] 최종 몸통 커버리지 {best_cov:.2f}")
            p = V2_ROOT / g / f"overlay_{item['code']}_b{i + 1}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(ov)
            print(f"  → {p.relative_to(OUT_ROOT.parent)}")


def cmd_compose(args):
    """QA용 — base{n} 위에 overlay들을 합성한 미리보기 생성."""
    g = args.genders[0]
    base = V2_ROOT / g / f"base{args.base}.png"
    if not base.exists():
        sys.exit(f"없음: {base}")
    img = Image.open(base).convert("RGBA")
    for code in args.codes:
        ov_path = V2_ROOT / g / f"overlay_{code}_b{args.base}.png"
        if not ov_path.exists():
            sys.exit(f"overlay 없음: {ov_path}")
        ov = Image.open(ov_path).convert("RGBA").resize(img.size)
        img = Image.alpha_composite(img, ov)
    out = V2_ROOT / g / f"preview_b{args.base}_{'_'.join(args.codes)}.png"
    img.save(out)
    print(f"  → {out.relative_to(OUT_ROOT.parent)}")


def acc_position_ok(code: str, base_png: bytes, ov_png: bytes) -> bool:
    """작은 액세서리의 위치 검증 — 왕관은 머리 위, 선글라스는 눈높이대."""
    b = Image.open(io.BytesIO(base_png)).convert("RGBA")
    bb = content_bbox(b)
    o = Image.open(io.BytesIO(ov_png)).convert("RGBA")
    ob = o.getchannel("A").getbbox()
    if not bb or not ob:
        return False
    bh = bb[3] - bb[1]
    cy = (ob[1] + ob[3]) / 2
    rel = (cy - bb[1]) / bh  # base 콘텐츠 기준 상대 높이 (0=정수리)
    if code == "acc_crown":
        return rel < 0.18
    if code == "acc_sunglasses":
        return 0.05 < rel < 0.40
    return True


def cmd_audit(args):
    """전 overlay 품질 감사 — 고스트/몸통 커버리지/액세서리 위치. 재생성 대기 목록 출력."""
    bad = []
    for g in args.genders:
        sheet = v2_sheet_path(g)
        if not sheet.exists():
            continue
        base_parts = slice3(sheet.read_bytes())
        for p in sorted((V2_ROOT / g).glob("overlay_*.png")):
            code = p.stem.replace("overlay_", "")[:-3]
            bi = int(p.stem[-1])
            data = p.read_bytes()
            reasons = []
            if is_ghost(data):
                reasons.append("ghost")
            if code.startswith("top_") and torso_coverage(data) < 0.7:
                reasons.append(f"coverage={torso_coverage(data):.2f}")
            if code.startswith("acc_") and not acc_position_ok(code, base_parts[bi - 1], data):
                reasons.append("position")
            mark = "FAIL " + ",".join(reasons) if reasons else "pass"
            print(f"  {g}/{p.name:38s} {mark}")
            if reasons:
                bad.append(f"{g}:{code}:b{bi}")
    print()
    print("재생성 필요:", len(bad), "→", " ".join(bad) if bad else "없음")



# 머리 위 액세서리 배치 규칙 — (head_w 대비 폭비, 머리와 세로 겹침 = 아이템 높이 비)
ACC_PLACE_RULES = {
    "acc_crown": {"w_ratio": 0.60, "overlap": 0.25},
}


def cmd_accplace(args):
    """'재해석형' 착용샷(diff 불가)에서 머리 위 액세서리만 분리해 base에 규칙 배치.
    분리: 콘텐츠 상단에서 행 폭이 급증(머리 시작)하기 전까지를 아이템으로 본다."""
    rule = ACC_PLACE_RULES.get(args.code)
    if not rule:
        sys.exit(f"배치 규칙 없음: {args.code} (보유: {', '.join(ACC_PLACE_RULES)})")
    for g in args.genders:
        for i in (1, 2, 3):
            wear_p = V2_ROOT / g / f"wear_{args.code}_b{i}.png"
            base_p = V2_ROOT / g / f"base{i}.png"
            if not wear_p.exists() or not base_p.exists():
                print(f"  [{g} b{i}] 착용샷 없음 — 건너뜀")
                continue
            wear = Image.open(io.BytesIO(chroma_key(wear_p.read_bytes()))).convert("RGBA")
            wa = wear.getchannel("A").load()
            WW, WH = wear.size
            roww = [sum(1 for x in range(WW) if wa[x, y] > 0) for y in range(WH)]
            ys = [y for y in range(WH) if roww[y] >= 4]
            if not ys:
                print(f"  [{g} b{i}] 콘텐츠 없음")
                continue
            y_t = min(ys)
            # 머리 시작 지점: 행 폭이 전체 최대폭(어깨)의 35%를 넘는 첫 행
            wmax = max(roww)
            y_jump = None
            for y in range(y_t, min(WH, y_t + WH // 2)):
                if roww[y] > wmax * 0.35:
                    y_jump = y
                    break
            if not y_jump or y_jump <= y_t + 4:
                print(f"  [{g} b{i}] 아이템/머리 경계 못 찾음")
                continue
            xs_item = [x for x in range(WW) for y in range(y_t, y_jump) if wa[x, y] > 0]
            ib = (min(xs_item), y_t, max(xs_item) + 1, y_jump)
            item = wear.crop(ib)
            # base 머리 정보
            base = Image.open(base_p).convert("RGBA")
            ba = base.getchannel("A").load()
            BW, BH = base.size
            brow = [sum(1 for x in range(BW) if ba[x, y] > 0) for y in range(BH)]
            bys = [y for y in range(BH) if brow[y] >= 12]
            if not bys:
                continue
            b_top = min(bys)
            ch = max(bys) - b_top
            head_zone = range(b_top + int(ch * 0.05), b_top + int(ch * 0.30))
            head_w = max(brow[y] for y in head_zone)
            # 머리 중심 x: head_zone에서 가장 넓은 행의 콘텐츠 중심
            best_y = max(head_zone, key=lambda y: brow[y])
            bxs = [x for x in range(BW) if ba[x, best_y] > 0]
            head_cx = (min(bxs) + max(bxs)) / 2
            # 스케일·배치
            sc = (head_w * rule["w_ratio"]) / item.width
            item_s = item.resize((max(1, round(item.width * sc)), max(1, round(item.height * sc))), Image.NEAREST)
            ox = round(head_cx - item_s.width / 2)
            oy = round(b_top + item_s.height * rule["overlap"] - item_s.height)
            canvas = Image.new("RGBA", (BW, BH), (0, 0, 0, 0))
            canvas.paste(item_s, (ox, oy), item_s)
            out = V2_ROOT / g / f"overlay_{args.code}_b{i}.png"
            out.write_bytes(__import__("io").BytesIO().getvalue() or b"") if False else None
            buf = io.BytesIO()
            canvas.save(buf, format="PNG")
            out.write_bytes(buf.getvalue())
            print(f"  → {out.relative_to(OUT_ROOT.parent)} (item {item.width}x{item.height}, scale={sc:.2f})")


def cmd_rekey(_args):
    """기존 산출물에 크로마키를 다시 적용 (키 로직 개선 후 일괄 재처리용)."""
    for p in sorted(OUT_ROOT.rglob("*.png")):
        p.write_bytes(chroma_key(p.read_bytes()))
        print(f"  rekey → {p.relative_to(OUT_ROOT.parent)}")


def cmd_check(_args):
    png = gen_image("A single red apple, simple flat icon, plain solid magenta background (#FF00FF).")
    p = OUT_ROOT / "check.png"
    save(p, png, transparent=True)
    print("OK — API 키와 모델이 정상 동작합니다.")


def cmd_base(args):
    for g in args.genders:
        print(f"[base:{g}] 생성 중…")
        png = gen_image(BASE_PROMPTS[g])
        save(base_path(g), png, not args.keep_bg)


def gen_item(item: dict, gender: str, keep_bg: bool):
    bp = base_path(gender)
    if not bp.exists():
        sys.exit(f"베이스 캐릭터가 없습니다: {bp} — 먼저 `python3 assetgen.py base` 를 실행하세요.")
    ref = bp.read_bytes()
    prompt = (
        "Use the provided reference character EXACTLY: same face, same hair (unless told to change), "
        "same proportions, same pose, same retro pixel art (dot art) style. "
        f"Change ONLY this: {item['prompt']}. Keep everything else identical. "
        "Bust-up portrait, facing front, centered. Background must be one perfectly flat uniform "
        "magenta color (#FF00FF) with no dithering and no noise. No text."
    )
    print(f"[{item['code']}:{gender}] 생성 중…")
    png = gen_image(prompt, ref_images=[ref])
    save(OUT_ROOT / gender / f"wear_{item['code']}.png", png, not keep_bg)


def cmd_item(args):
    items = {i["code"]: i for i in load_items()}
    if args.code not in items:
        sys.exit(f"items.json에 없는 코드: {args.code} (보유: {', '.join(items)})")
    for g in args.genders:
        gen_item(items[args.code], g, args.keep_bg)


def cmd_all(args):
    for item in load_items():
        if args.slot and item["slot"] != args.slot:
            continue
        for g in args.genders:
            out = OUT_ROOT / g / f"wear_{item['code']}.png"
            if out.exists() and not args.force:
                print(f"[{item['code']}:{g}] 이미 있음 — 건너뜀 (--force 로 재생성)")
                continue
            gen_item(item, g, args.keep_bg)
            time.sleep(1)  # rate limit 완화


def main():
    ap = argparse.ArgumentParser(description="DOPL 애셋 생성기 (나노바나나)")
    ap.add_argument("--gender", choices=["m", "f", "both"], default="both")
    ap.add_argument("--keep-bg", action="store_true", help="마젠타 배경 유지(크로마키 생략)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    sub.add_parser("base")
    sub.add_parser("rekey")
    sub.add_parser("audit")  # 품질 감사(고스트/커버리지/위치)
    p_ap = sub.add_parser("accplace")  # 착용샷에서 액세서리 분리→규칙 배치
    p_ap.add_argument("code")
    sub.add_parser("promote")  # v2: public 승격(정렬 크롭)
    p_rf = sub.add_parser("refine")  # 보관 시트에서 overlay 재추출(깨짐 보정)
    p_rf.add_argument("code", nargs="?", default=None)
    p_gc = sub.add_parser("gamecard")  # 게임 카탈로그 키비주얼
    p_gc.add_argument("code", nargs="?", default=None)
    sub.add_parser("bases")  # v2: base 3종 시트
    p_ov = sub.add_parser("overlay")  # v2: 아이템 overlay 시트
    p_ov.add_argument("code")
    p_cp = sub.add_parser("compose")  # v2: base+overlay 합성 미리보기
    p_cp.add_argument("base", type=int)
    p_cp.add_argument("codes", nargs="+")
    p_item = sub.add_parser("item")
    p_item.add_argument("code")
    p_all = sub.add_parser("all")
    p_all.add_argument("--slot", choices=["body", "face", "hair", "top", "acc"])
    p_all.add_argument("--force", action="store_true")
    args = ap.parse_args()
    args.genders = ["m", "f"] if args.gender == "both" else [args.gender]

    {
        "check": cmd_check, "base": cmd_base, "item": cmd_item, "all": cmd_all, "rekey": cmd_rekey,
        "bases": cmd_bases, "overlay": cmd_overlay, "compose": cmd_compose, "promote": cmd_promote, "gamecard": cmd_gamecard, "refine": cmd_refine, "audit": cmd_audit, "accplace": cmd_accplace,
    }[args.cmd](args)


if __name__ == "__main__":
    main()
