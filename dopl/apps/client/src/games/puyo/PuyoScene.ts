// 뿌요뿌요 Phaser 씬 — 실시간 낙하/연쇄 로컬 시뮬을 클라가 전부 돌린다.
// 서버는 THIN 릴레이(시드 배포 + 방해뿌요 공격 중계 + topout 승패).
// 시드 기반 결정적 PRNG(mulberry32)로 뿌요 페어 시퀀스를 생성 → 공정/재현 가능.
//
// 보드: 6열 × 12행(+ 상단 히든 2행). 낙하 피스 = 2개 뿌요 쌍(축 + 위성).
// 조작: ←→ 이동, ↓ 소프트드롭, ↑/X 시계, Z 반시계. 일정 간격 자동 낙하.
// 연쇄: 같은 색 4개 이상 연결되면 터짐 + 인접 방해뿌요(회색)도 같이 제거 →
//       중력 적용 후 재검사(연쇄 콤보). 연쇄력으로 보낼 방해뿌요 수 계산.
import Phaser from 'phaser';
import type { RoomState } from '@dopl/protocol';
import { bgm } from '../../bgm';

const COLS = 6;
const ROWS = 12; // 가시 행
const HIDDEN = 2; // 상단 히든 행 (스폰 영역)
const TOTAL_ROWS = ROWS + HIDDEN;
const CELL = 28; // 셀 픽셀 크기
const BOARD_X = 16; // 내 보드 좌상단 x
const BOARD_Y = 70; // 내 보드 좌상단 y (가시 영역 기준)

// 뿌요 색: 0=빈칸, 1~5=컬러, 9=방해(회색)
const EMPTY = 0;
const GARBAGE = 9;
const COLORS = 4; // 사용 색 수 (1~4) — 클래식 4색
const COLOR_HEX: Record<number, number> = {
  1: 0xef4444, // red
  2: 0x22c55e, // green
  3: 0x3b82f6, // blue
  4: 0xeab308, // yellow
  5: 0xa855f7, // purple
  9: 0x9ca3af, // garbage
};

// 자동 낙하 간격(ms) / 소프트드롭 간격
const FALL_MS = 700;
const SOFT_MS = 45;
const POP_THRESHOLD = 4;

// mulberry32 — 결정적 PRNG (양 클라 시드 동일 시 동일 시퀀스)
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Piece {
  ax: number; // 축 뿌요 열
  ay: number; // 축 뿌요 행
  rot: 0 | 1 | 2 | 3; // 위성 방향: 0=위 1=오른 2=아래 3=왼
  ac: number; // 축 색
  bc: number; // 위성 색
}

// 위성 오프셋 (rot 기준)
const ROT_DX = [0, 1, 0, -1];
const ROT_DY = [-1, 0, 1, 0];

export class PuyoScene extends Phaser.Scene {
  sendAction!: (a: { kind: string; count?: number; score?: number; chain?: number }) => void;
  private latest: RoomState | null = null;
  private ready = false;

  // 시뮬 상태
  private grid: number[][] = []; // [row][col]
  private rng: () => number = Math.random;
  private queue: [number, number][] = []; // 다음 페어 색 큐 (시드 결정적)
  private piece: Piece | null = null;
  private score = 0;
  private chainShown = 0; // 마지막 연쇄 수(표시)
  private topped = false;
  private started = false;

  // 방해뿌요
  private lastGarbageSeen = 0; // 서버 누적 카운터 마지막 본 값
  private pendingGarbage = 0; // 떨어뜨릴 방해뿌요 대기

  // 타이밍
  private fallTimer = 0;
  private resolving = false; // 연쇄 처리 중(입력/낙하 정지)

  // 입력 키
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private prevKey: Record<string, boolean> = {};

  // 렌더 그래픽스
  private gfx!: Phaser.GameObjects.Graphics;
  private hud!: Phaser.GameObjects.Text;
  private oppHud!: Phaser.GameObjects.Text;
  private msgText!: Phaser.GameObjects.Text;

  constructor() {
    super('puyo');
  }

  create(): void {
    this.gfx = this.add.graphics();
    this.hud = this.add.text(BOARD_X, 10, '', { fontSize: '13px', color: '#e2e8f0' });
    const oppX = BOARD_X + COLS * CELL + 40;
    this.oppHud = this.add.text(oppX, 10, '', { fontSize: '13px', color: '#94a3b8' });
    this.msgText = this.add
      .text(BOARD_X + (COLS * CELL) / 2, BOARD_Y + (ROWS * CELL) / 2, '', {
        fontSize: '20px', color: '#fde68a', fontStyle: 'bold', align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(10);

    const kb = this.input.keyboard;
    if (kb) {
      this.keys = {
        left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
        right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
        down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
        up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
        z: kb.addKey(Phaser.Input.Keyboard.KeyCodes.Z),
        x: kb.addKey(Phaser.Input.Keyboard.KeyCodes.X),
      };
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      bgm.stop();
    });

    this.ready = true;
    if (this.latest) this.applyState(this.latest);
  }

  pushState(s: RoomState): void {
    this.latest = s;
    if (this.ready) this.applyState(s);
  }

  private applyState(s: RoomState): void {
    const g = s.game as Record<string, unknown> | undefined;
    if (!g) return;

    // 시드 받으면 게임 보드 1회 초기화
    if (s.phase === 'playing' && !this.started && typeof g.seed === 'number') {
      this.initBoard(g.seed);
    }

    // 방해뿌요 누적 카운터 diff → 대기열로
    const total = (g.myTotalGarbageReceived as number) ?? 0;
    if (total > this.lastGarbageSeen) {
      this.pendingGarbage += total - this.lastGarbageSeen;
      this.lastGarbageSeen = total;
    }

    // HUD
    const opp = g.opponent as { name?: string; score?: number; chain?: number; topped?: boolean } | null;
    if (opp) {
      this.oppHud.setText(`🆚 ${opp.name ?? '상대'}\n점수 ${opp.score ?? 0}\n연쇄 ${opp.chain ?? 0}${opp.topped ? '\n💀 패배' : ''}`);
    }

    if (s.phase === 'playing') bgm.play('mafiaDay');
    else if (s.phase === 'ended') {
      bgm.stop();
      const win = (g.winnerId as string | null) === s.myId;
      this.msgText.setText(win ? '🏆 승리!' : '💀 패배…');
    }
    this.updateHud();
  }

  private initBoard(seed: number): void {
    this.grid = Array.from({ length: TOTAL_ROWS }, () => Array<number>(COLS).fill(EMPTY));
    this.rng = mulberry32(seed >>> 0);
    this.queue = [];
    this.refillQueue();
    this.score = 0;
    this.chainShown = 0;
    this.topped = false;
    this.pendingGarbage = 0;
    this.lastGarbageSeen = 0;
    this.resolving = false;
    this.fallTimer = 0;
    this.started = true;
    this.spawnPiece();
  }

  private randColor(): number {
    return 1 + Math.floor(this.rng() * COLORS);
  }
  private refillQueue(): void {
    while (this.queue.length < 3) this.queue.push([this.randColor(), this.randColor()]);
  }

  private spawnPiece(): void {
    this.refillQueue();
    const [ac, bc] = this.queue.shift()!;
    // 스폰: 3열(0-index 2), 히든 영역 맨 위 — 축은 아래, 위성은 위(rot=0)
    const ax = 2;
    const ay = 1; // 히든 행 내 (TOTAL 좌표)
    // 스폰 지점이 막혔으면 topout
    if (this.grid[ay]![ax] !== EMPTY || this.grid[ay - 1]![ax] !== EMPTY) {
      this.doTopout();
      return;
    }
    this.piece = { ax, ay, rot: 0, ac, bc };
    this.fallTimer = 0;
  }

  private doTopout(): void {
    if (this.topped) return;
    this.topped = true;
    this.piece = null;
    this.msgText.setText('💀 패배…');
    this.sendAction({ kind: 'topout' });
  }

  // 위성 좌표
  private satPos(p: Piece): [number, number] {
    return [p.ax + ROT_DX[p.rot], p.ay + ROT_DY[p.rot]];
  }
  private cellFree(c: number, r: number): boolean {
    if (c < 0 || c >= COLS || r >= TOTAL_ROWS) return false;
    if (r < 0) return true; // 히든 위쪽은 통과 허용
    return this.grid[r]![c] === EMPTY;
  }
  private pieceFits(p: Piece): boolean {
    const [sx, sy] = this.satPos(p);
    return this.cellFree(p.ax, p.ay) && this.cellFree(sx, sy);
  }

  // ── 입력 처리 (엣지 트리거) ─────────────────────────────────
  private pressed(name: string): boolean {
    const k = this.keys[name];
    if (!k) return false;
    const down = k.isDown;
    const was = this.prevKey[name] ?? false;
    return down && !was;
  }

  private handleInput(): void {
    if (!this.piece) return;
    const p = this.piece;
    if (this.pressed('left')) {
      const np = { ...p, ax: p.ax - 1 };
      if (this.pieceFits(np)) this.piece = np;
    }
    if (this.pressed('right')) {
      const np = { ...p, ax: p.ax + 1 };
      if (this.pieceFits(np)) this.piece = np;
    }
    if (this.pressed('up') || this.pressed('x')) this.rotate(1);
    if (this.pressed('z')) this.rotate(-1);
  }

  // 회전 + 간단 킥(벽/바닥 밀어내기)
  private rotate(dir: 1 | -1): void {
    if (!this.piece) return;
    const p = this.piece;
    const nrot = (((p.rot + dir) % 4) + 4) % 4 as 0 | 1 | 2 | 3;
    let np: Piece = { ...p, rot: nrot };
    if (this.pieceFits(np)) { this.piece = np; return; }
    // 킥: 위성이 향하는 반대로 축을 1칸 밀어 재시도
    const dx = ROT_DX[nrot]!;
    const dy = ROT_DY[nrot]!;
    const kick = { ...np, ax: np.ax - dx, ay: np.ay - dy };
    if (this.pieceFits(kick)) { this.piece = kick; return; }
    // 그래도 안되면 회전 취소
  }

  // ── 메인 루프 ───────────────────────────────────────────────
  update(_t: number, dt: number): void {
    // prevKey 갱신은 매 프레임 끝에
    const live = this.latest?.phase === 'playing' && this.started && !this.topped;
    if (live && !this.resolving && this.piece) {
      this.handleInput();
      // 중력
      const soft = this.keys.down?.isDown;
      this.fallTimer += dt;
      const interval = soft ? SOFT_MS : FALL_MS;
      if (this.fallTimer >= interval) {
        this.fallTimer = 0;
        this.tryFall();
      }
    }
    if (this.keys) for (const n of Object.keys(this.keys)) this.prevKey[n] = this.keys[n]!.isDown;

    this.draw();
  }

  // 한 칸 낙하 시도; 못 내려가면 잠금 유예 후 착지
  private tryFall(): void {
    if (!this.piece) return;
    const p = this.piece;
    const down = { ...p, ay: p.ay + 1 };
    if (this.pieceFits(down)) {
      this.piece = down;
    } else {
      this.lockPiece(); // 더 못 내려가면 즉시 잠금(간소화 — 잠금 유예 생략)
    }
  }

  // 피스 고정 → 보드에 기록 → 중력 settle → 연쇄 처리
  private lockPiece(): void {
    if (!this.piece) return;
    const p = this.piece;
    const [sx, sy] = this.satPos(p);
    // 축/위성 기록 (히든 음수행이면 topout 위험)
    if (p.ay >= 0) this.grid[p.ay]![p.ax] = p.ac;
    if (sy >= 0) this.grid[sy]![sx] = p.bc;
    this.piece = null;
    this.settleGravity();
    void this.resolveChains();
  }

  // 각 열을 독립적으로 아래로 떨어뜨려 빈칸 메움
  private settleGravity(): void {
    for (let c = 0; c < COLS; c++) {
      let write = TOTAL_ROWS - 1;
      for (let r = TOTAL_ROWS - 1; r >= 0; r--) {
        const v = this.grid[r]![c]!;
        if (v !== EMPTY) {
          this.grid[write]![c] = v;
          if (write !== r) this.grid[r]![c] = EMPTY;
          write--;
        }
      }
      for (let r = write; r >= 0; r--) this.grid[r]![c] = EMPTY;
    }
  }

  // 연쇄 처리 (애니메이션 없이 즉시 — 간소화). 콤보 반복.
  private async resolveChains(): Promise<void> {
    this.resolving = true;
    let chain = 0;
    let totalScore = 0;

    for (;;) {
      const { groups, garbageHit } = this.findPops();
      if (groups.length === 0) break;
      chain += 1;

      // 색별 제거 + 색 보너스/그룹 보너스
      let popped = 0;
      const colorsThisStep = new Set<number>();
      for (const g of groups) {
        popped += g.cells.length;
        colorsThisStep.add(g.color);
        for (const [r, c] of g.cells) this.grid[r]![c] = EMPTY;
      }
      // 인접 방해뿌요 제거
      for (const [r, c] of garbageHit) this.grid[r]![c] = EMPTY;

      // 클래식 점수식 (간소화): 10*popped * (chainPower + colorBonus + groupBonus), 최소 1
      const chainPower = chain === 1 ? 0 : Math.pow(2, chain + 1); // 0,8,16,32...
      const colorBonus = colorsThisStep.size > 1 ? Math.pow(2, colorsThisStep.size) : 0;
      const groupBonus = groups.reduce((s, g) => s + Math.max(0, g.cells.length - POP_THRESHOLD), 0);
      const mult = Math.max(1, chainPower + colorBonus + groupBonus);
      totalScore += 10 * popped * mult;

      this.settleGravity();
    }

    this.resolving = false;
    if (chain > 0) {
      this.score += totalScore;
      this.chainShown = chain;
      // 보낼 방해뿌요 = floor(점수 / 70)
      const garbage = Math.floor(totalScore / 70);
      // 상쇄: 들어올 방해뿌요와 먼저 상쇄
      let send = garbage;
      if (this.pendingGarbage > 0) {
        const cancel = Math.min(this.pendingGarbage, send);
        this.pendingGarbage -= cancel;
        send -= cancel;
      }
      if (send > 0) this.sendAction({ kind: 'attack', count: send });
      this.sendAction({ kind: 'progress', score: this.score, chain });
      this.updateHud();
    }

    // 연쇄 끝 → 대기 중인 방해뿌요 투하 후 다음 피스
    this.dropGarbage();
    if (!this.topped) this.spawnPiece();
  }

  // 연결된 같은색 그룹(>=4)과 인접 방해뿌요 탐색
  private findPops(): { groups: { color: number; cells: [number, number][] }[]; garbageHit: [number, number][] } {
    const seen = Array.from({ length: TOTAL_ROWS }, () => Array<boolean>(COLS).fill(false));
    const groups: { color: number; cells: [number, number][] }[] = [];
    const garbageSet = new Set<string>();
    const N = [
      [-1, 0], [1, 0], [0, -1], [0, 1],
    ];
    for (let r = 0; r < TOTAL_ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const color = this.grid[r]![c]!;
        if (color === EMPTY || color === GARBAGE || seen[r]![c]) continue;
        // BFS 동색 그룹
        const cells: [number, number][] = [];
        const stack: [number, number][] = [[r, c]];
        seen[r]![c] = true;
        while (stack.length) {
          const [cr, cc] = stack.pop()!;
          cells.push([cr, cc]);
          for (const [dr, dc] of N) {
            const nr = cr + dr;
            const nc = cc + dc;
            if (nr < 0 || nr >= TOTAL_ROWS || nc < 0 || nc >= COLS) continue;
            if (seen[nr]![nc]) continue;
            if (this.grid[nr]![nc] === color) {
              seen[nr]![nc] = true;
              stack.push([nr, nc]);
            }
          }
        }
        if (cells.length >= POP_THRESHOLD) {
          groups.push({ color, cells });
          // 그룹에 인접한 방해뿌요 수집
          for (const [cr, cc] of cells) {
            for (const [dr, dc] of N) {
              const nr = cr + dr;
              const nc = cc + dc;
              if (nr < 0 || nr >= TOTAL_ROWS || nc < 0 || nc >= COLS) continue;
              if (this.grid[nr]![nc] === GARBAGE) garbageSet.add(`${nr},${nc}`);
            }
          }
        }
      }
    }
    const garbageHit = [...garbageSet].map((s) => s.split(',').map(Number) as [number, number]);
    return { groups, garbageHit };
  }

  // 대기 중 방해뿌요를 열에 분산 투하 (위에서 떨어진 뒤 settle)
  private dropGarbage(): void {
    if (this.pendingGarbage <= 0) return;
    let remain = this.pendingGarbage;
    this.pendingGarbage = 0;
    // 한 번에 최대 30개(5행)까지 — 과투하 방지(간소화)
    remain = Math.min(remain, COLS * 5);
    // 열을 순회하며 한 줄씩 채움
    let col = 0;
    while (remain > 0) {
      // 해당 열의 최상단 빈칸에 방해뿌요
      let placed = false;
      for (let r = 0; r < TOTAL_ROWS; r++) {
        if (this.grid[r]![col] === EMPTY) {
          // 위에서부터 첫 빈칸이지만, 실제로는 맨 위에 얹고 중력 — 여기선 최상단 빈칸에 직접
          this.grid[r]![col] = GARBAGE;
          placed = true;
          break;
        }
      }
      if (placed) remain--;
      col = (col + 1) % COLS;
      // 모든 열이 가득 차면 중단
      if (this.grid[0]!.every((v) => v !== EMPTY)) break;
    }
    this.settleGravity();
    // 투하 후 스폰 지점이 막혔는지는 spawnPiece에서 판정
  }

  // ── 렌더 ────────────────────────────────────────────────────
  private updateHud(): void {
    this.hud.setText(`점수 ${this.score}\n연쇄 ${this.chainShown}\n받을 방해 ${this.pendingGarbage}`);
  }

  private draw(): void {
    if (!this.gfx || !this.started) return;
    const g = this.gfx;
    g.clear();

    // 보드 배경
    g.fillStyle(0x111827, 1).fillRect(BOARD_X - 2, BOARD_Y - 2, COLS * CELL + 4, ROWS * CELL + 4);
    g.lineStyle(2, 0x334155, 1).strokeRect(BOARD_X - 2, BOARD_Y - 2, COLS * CELL + 4, ROWS * CELL + 4);

    // 그리드 셀 (가시 영역만: HIDDEN~TOTAL)
    for (let r = HIDDEN; r < TOTAL_ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = this.grid[r]![c]!;
        if (v === EMPTY) continue;
        this.drawPuyo(c, r, v);
      }
    }

    // 낙하 피스
    if (this.piece) {
      const p = this.piece;
      this.drawPuyo(p.ax, p.ay, p.ac);
      const [sx, sy] = this.satPos(p);
      this.drawPuyo(sx, sy, p.bc);
    }

    // 다음 페어 미리보기
    const previewX = BOARD_X + COLS * CELL + 8;
    g.fillStyle(0x1f2937, 1).fillRect(previewX, BOARD_Y + 90, CELL + 8, CELL * 2 + 12);
    const next = this.queue[0];
    if (next) {
      this.drawPuyoAt(previewX + 4, BOARD_Y + 94, next[1]); // 위성
      this.drawPuyoAt(previewX + 4, BOARD_Y + 94 + CELL, next[0]); // 축
    }

    // 들어올 방해뿌요 인디케이터
    if (this.pendingGarbage > 0) {
      g.fillStyle(0x9ca3af, 1);
      const n = Math.min(this.pendingGarbage, 6);
      for (let i = 0; i < n; i++) g.fillCircle(BOARD_X + 8 + i * 16, BOARD_Y - 14, 6);
    }
  }

  private drawPuyo(col: number, rowTotal: number, v: number): void {
    const visRow = rowTotal - HIDDEN;
    if (visRow < 0) return; // 히든 행은 안 그림
    this.drawPuyoAt(BOARD_X + col * CELL, BOARD_Y + visRow * CELL, v);
  }
  private drawPuyoAt(px: number, py: number, v: number): void {
    const g = this.gfx;
    const cx = px + CELL / 2;
    const cy = py + CELL / 2;
    g.fillStyle(COLOR_HEX[v] ?? 0xffffff, 1).fillCircle(cx, cy, CELL / 2 - 2);
    g.lineStyle(1, 0x0f172a, 0.6).strokeCircle(cx, cy, CELL / 2 - 2);
    // 하이라이트 점
    g.fillStyle(0xffffff, 0.5).fillCircle(cx - 4, cy - 4, 2.5);
  }
}
