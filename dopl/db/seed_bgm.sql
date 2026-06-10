-- 배경음악 메타 시드. 곡 제목 = 원본 파일명 기준. 재적용 시 메타 갱신(UPSERT).
INSERT INTO bgm_track (key, title, descr, file, sort) VALUES
  ('main',       '점프 점프',               '🏠 메인(로그인) 화면 — DOPL의 첫인상',          'main_bgm.mp3',        1),
  ('lobby',      'Before the Clock Starts', '🎮 로비 — 게임이 시작되기 전의 설렘',           'lobby_bgm.mp3',       2),
  ('shop',       'Before The Clock Stops',  '🛍 상점 — 시간 가는 줄 모르는 쇼핑',            'shop_bgm.mp3',        3),
  ('dress',      'Velvet Stitch',           '👗 분장실 — 한 땀 한 땀 나만의 스타일',         'dress_bgm.mp3',       4),
  ('quiz',       'Golden Ticket Shuffle',   '⚡ 퀴즈게임 방 — 경쾌한 두뇌 대결',             'quiz_bgm.mp3',        5),
  ('mafiaDay',   'The Third Alibi',         '☀️ 마피아 · 낮 — 누가 거짓말을 하는가',         'mafia_day_bgm.mp3',   6),
  ('mafiaNight', 'Measured Breath',         '🌙 마피아 · 밤 — 숨죽인 긴장의 시간',           'mafia_night_bgm.mp3', 7),
  ('bang',       'Seven Seconds to Draw',   '🔫 Bang (출시 예정) — 미리 듣는 테마곡',        'bang_bgm.mp3',        8)
ON CONFLICT (key) DO UPDATE
  SET title = EXCLUDED.title, descr = EXCLUDED.descr, file = EXCLUDED.file, sort = EXCLUDED.sort;
