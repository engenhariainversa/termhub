/**
 * The two monitors of an occupied desk, drawn over the desk sheet's dark screens (TER-1048): each
 * screen is a 24×16 grid of fat pixels, mapped onto the monitor's skewed face, that plays the
 * animation of the tab's state (deskLook.ts). Redrawn only when its 10 fps frame changes.
 */
import { Container, Graphics, Matrix } from 'pixi.js';
import { SCREEN_COLOR, type DeskLook, type Game } from './deskLook';

export const GRID_W = 24;
export const GRID_H = 16;
/** Animation frames per second: stepped, like the pixel art around it. */
export const SCREEN_FPS = 10;
/** How long "terminou" shows its check before the screensaver takes over. */
export const DONE_CHECK_S = 6;

/**
 * The visible face of each monitor on the desk sheet (desk-v-off-2.png, 512 px), a few pixels inside
 * its bezel: top-left, top-right and bottom-left corners. The sides are vertical, so three corners
 * are the whole parallelogram.
 */
const FACES = {
  left: { tl: [82, 162], tr: [172, 126], bl: [82, 221] },
  right: { tl: [200, 116], tr: [290, 82], bl: [200, 177] },
} as const;

/** Grid cell → sheet pixel, for one monitor face. */
function faceMatrix(face: (typeof FACES)['left' | 'right']): Matrix {
  const [x0, y0] = face.tl;
  return new Matrix((face.tr[0] - x0) / GRID_W, (face.tr[1] - y0) / GRID_W, (face.bl[0] - x0) / GRID_H, (face.bl[1] - y0) / GRID_H, x0, y0);
}

const BG = { code: 0x0d1526, game: 0x0a0f1a, error: 0x3a0d10, done: 0x0c2014, saver: 0x05070c, clock: 0x1f2229 } as const;
const CODE_COLORS = [SCREEN_COLOR.accent, 0x7ee787, 0xd2a8ff, 0x9aa1b1, SCREEN_COLOR.accent, 0xffa657];
const WHITE = 0xe6e8ee;
const BOLT = 0xf2cc60;

/** 0 → span → 0 → …: a value bouncing between `a` and `b`, one step per frame. */
export function bounce(f: number, a: number, b: number): number {
  const span = b - a;
  if (span <= 0) return a;
  const v = ((f % (2 * span)) + 2 * span) % (2 * span);
  return a + (v <= span ? v : 2 * span - v);
}

/** Small bitmaps, '#' = lit. */
const GLYPH = {
  '?': [' ### ', '#   #', '    #', '   # ', '  #  ', '     ', '  #  '],
  '!': ['  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '     ', '  #  '],
  bolt: ['  ##', ' ## ', '####', ' ## ', '##  '],
  pad: ['  #     ##', ' ### ## ##', '  #  ##   '],
  z: ['###', '  #', ' # ', '#  ', '###'],
} as const;

/** The check's pixels, in drawing order: a short stroke down, then the long one up. */
const CHECK: Array<[number, number]> = [
  [6, 8], [7, 9], [8, 10], [9, 11], [10, 10], [11, 9], [12, 8], [13, 7], [14, 6], [15, 5], [16, 4], [17, 3],
];

/** The snake's track: the inside rectangle of the screen, clockwise. */
const SNAKE_PATH: Array<[number, number]> = (() => {
  const path: Array<[number, number]> = [];
  for (let x = 3; x < 20; x++) path.push([x, 3]);
  for (let y = 3; y < 12; y++) path.push([20, y]);
  for (let x = 20; x > 3; x--) path.push([x, 12]);
  for (let y = 12; y > 3; y--) path.push([3, y]);
  return path;
})();

class Pixels {
  constructor(private readonly g: Graphics) {}
  rect(x: number, y: number, w: number, h: number, color: number): void {
    this.g.rect(x, y, w, h).fill(color);
  }
  px(x: number, y: number, color: number, size = 1): void {
    this.g.rect(x, y, size, size).fill(color);
  }
  glyph(rows: readonly string[], x: number, y: number, color: number, size = 1): void {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) if (row[i] === '#') this.px(x + i * size, y + j * size, color, size);
    });
  }
  border(color: number): void {
    this.rect(0, 0, GRID_W, 1, color);
    this.rect(0, GRID_H - 1, GRID_W, 1, color);
    this.rect(0, 0, 1, GRID_H, color);
    this.rect(GRID_W - 1, 0, 1, GRID_H, color);
  }
  /** A line of fat pixels from the centre outwards, for the clock's hands. */
  ray(cx: number, cy: number, angle: number, length: number, color: number): void {
    for (let r = 0; r <= length; r += 0.5) this.px(Math.round(cx + Math.cos(angle) * r), Math.round(cy + Math.sin(angle) * r), color);
  }
}

/** Code scrolling up: rows of tokens whose widths come from the row's number, a cursor at the end. */
function drawCode(p: Pixels, f: number): void {
  const scroll = Math.floor(f / 2);
  for (let row = 0; row < 7; row++) {
    const n = row + scroll;
    const indent = 1 + ((n * 7) % 4) * 2;
    let x = indent;
    const tokens = 1 + ((n * 13) % 3);
    for (let k = 0; k < tokens && x < GRID_W - 2; k++) {
      const w = Math.min(2 + ((n * 5 + k * 3) % 5), GRID_W - 1 - x);
      p.rect(x, 1 + row * 2, w, 1, CODE_COLORS[(n + k) % CODE_COLORS.length]);
      x += w + 1;
    }
    if (row === 6 && f % 6 < 3) p.px(Math.min(x, GRID_W - 2), 13, WHITE);
  }
}

/** A block sliding back and forth on a track, under a few still lines of "stats". */
function drawProgress(p: Pixels, f: number, bolt: boolean): void {
  p.rect(3, 3, 8, 1, 0x9aa1b1);
  p.rect(3, 5, 12, 1, 0x4b5468);
  p.rect(2, 10, 20, 3, 0x1e2a44);
  p.rect(2 + bounce(f, 0, 14), 10, 6, 3, SCREEN_COLOR.accent);
  if (bolt) p.glyph(GLYPH.bolt, GRID_W - 6, 1, BOLT);
}

function drawGame(p: Pixels, game: Game, f: number): void {
  if (game === 'snake') {
    const L = SNAKE_PATH.length;
    // the food waits on the track ahead and jumps once the head reaches it
    const lap = Math.floor(f / 20);
    const [fx, fy] = SNAKE_PATH[((lap + 1) * 20) % L];
    p.px(fx, fy, SCREEN_COLOR.danger);
    for (let i = 6; i >= 0; i--) {
      const [x, y] = SNAKE_PATH[(((f - i) % L) + L) % L];
      p.px(x, y, i === 0 ? 0xaff5b4 : SCREEN_COLOR.ok);
    }
    return;
  }
  if (game === 'pong') {
    for (let y = 1; y < GRID_H; y += 3) p.px(12, y, 0x2a2f3a);
    const bx = bounce(f, 2, 21);
    const by = bounce(Math.floor(f * 0.7), 1, 14);
    const paddle = (x: number, y: number) => p.rect(x, Math.max(0, Math.min(GRID_H - 4, y - 2)), 1, 4, WHITE);
    paddle(1, bounce(Math.floor((f - 3) * 0.7), 1, 14));
    paddle(22, by);
    p.px(bx, by, 0xf2cc60);
    return;
  }
  // tetris: a well, two settled rows with a gap, a T falling down a column that moves each drop
  p.rect(6, 1, 1, 15, 0x4b5468);
  p.rect(17, 1, 1, 15, 0x4b5468);
  const settled = [0xd2a8ff, SCREEN_COLOR.accent, 0x7ee787, 0xffa657];
  for (let x = 7; x < 17; x++) {
    if (x !== 12) p.px(x, 14, settled[x % 4]);
    if (x % 3 !== 0) p.px(x, 13, settled[(x + 1) % 4]);
  }
  const drop = Math.floor(f / 2) % 12;
  const col = 8 + (Math.floor(f / 24) % 3) * 2;
  const color = settled[Math.floor(f / 24) % 4];
  p.rect(col, 1 + drop, 3, 1, color);
  p.px(col + 1, 2 + drop, color);
}

/** The screensaver: a block bouncing off the edges, changing colour on each lap. */
function drawSaver(p: Pixels, f: number): void {
  const x = bounce(f, 0, GRID_W - 4);
  const y = bounce(Math.floor(f * 0.6), 0, GRID_H - 2);
  p.rect(x, y, 4, 2, CODE_COLORS[Math.floor(f / 20) % CODE_COLORS.length]);
}

/** A round clock whose minute hand turns once every four seconds. */
function drawClock(p: Pixels, f: number): void {
  const cx = 12;
  const cy = 8;
  for (let a = 0; a < 32; a++) p.px(Math.round(cx + Math.cos((a / 32) * 2 * Math.PI) * 6), Math.round(cy + Math.sin((a / 32) * 2 * Math.PI) * 6), 0x9aa1b1);
  p.ray(cx, cy, (f / 40) * 2 * Math.PI - Math.PI / 2, 4.5, WHITE);
  p.ray(cx, cy, (f / 480) * 2 * Math.PI - Math.PI / 2, 3, 0x9aa1b1);
}

/**
 * Paints one frame of both monitors. `f`: the frame number (0 with reduced motion: no motion, only the
 * state's colour and sign); `sinceDone`: seconds since "terminou" began on this desk.
 */
export function paintScreens(left: Graphics, right: Graphics, look: DeskLook, f: number, sinceDone: number, reducedMotion: boolean): void {
  left.clear();
  right.clear();
  const L = new Pixels(left);
  const R = new Pixels(right);
  // the slow blink of "esperando você": 0.8 s on, 0.8 s off; always on without motion
  const blinkOn = reducedMotion || Math.floor(f / 8) % 2 === 0;
  left.visible = look.screen !== 'off';
  right.visible = look.screen !== 'off' && look.screen !== 'saver' && !(look.screen === 'done' && sinceDone >= DONE_CHECK_S);
  switch (look.screen) {
    case 'off':
      return;
    case 'code':
      L.rect(0, 0, GRID_W, GRID_H, BG.code);
      drawCode(L, f);
      R.rect(0, 0, GRID_W, GRID_H, BG.code);
      drawProgress(R, f, look.bolt);
      return;
    case 'game':
      L.rect(0, 0, GRID_W, GRID_H, BG.game);
      drawGame(L, look.game, f);
      if (look.attention && blinkOn) L.border(SCREEN_COLOR.attention);
      R.rect(0, 0, GRID_W, GRID_H, BG.game);
      if (look.attention) {
        if (blinkOn) {
          // a speech balloon with its tail down-left, a "?" inside
          R.rect(6, 2, 11, 10, SCREEN_COLOR.attention);
          R.rect(7, 12, 3, 1, SCREEN_COLOR.attention);
          R.px(7, 13, SCREEN_COLOR.attention);
          R.glyph(GLYPH['?'], 9, 3, 0x0f1115);
        }
      } else R.glyph(GLYPH.pad, 7, 6, 0x6b7280);
      return;
    case 'error': {
      const flash = reducedMotion || f % 10 < 6;
      L.rect(0, 0, GRID_W, GRID_H, BG.error);
      L.border(SCREEN_COLOR.danger);
      if (flash) L.glyph(GLYPH['!'], 7, 1, WHITE, 2);
      R.rect(0, 0, GRID_W, GRID_H, BG.error);
      for (let row = 0; row < 6; row++) {
        const w = 4 + (((row + Math.floor(f / 3)) * 7) % 14);
        R.rect(1 + ((row * 5 + f) % 3), 2 + row * 2, w, 1, row % 2 ? SCREEN_COLOR.danger : 0xffa198);
      }
      return;
    }
    case 'done':
      if (sinceDone < DONE_CHECK_S) {
        L.rect(0, 0, GRID_W, GRID_H, BG.done);
        const shown = reducedMotion ? CHECK.length : Math.min(CHECK.length, Math.floor(sinceDone * SCREEN_FPS) + 1);
        for (const [x, y] of CHECK.slice(0, shown)) L.px(x - 1, y, SCREEN_COLOR.ok, 2);
        R.rect(0, 0, GRID_W, GRID_H, BG.done);
        R.rect(3, 4, 10, 1, SCREEN_COLOR.ok);
        R.rect(3, 7, 14, 1, 0x2e6b3c);
        R.rect(3, 10, 8, 1, 0x2e6b3c);
        return;
      }
      L.rect(0, 0, GRID_W, GRID_H, BG.saver);
      if (!reducedMotion) drawSaver(L, f);
      // what tells "concluído" from "terminou" once the saver is on: a small check that stays
      for (const [x, y] of CHECK.slice(4)) if (x % 2 === 0) L.px(Math.floor(x / 2) + 13, Math.floor(y / 2) + 9, SCREEN_COLOR.ok);
      return;
    case 'saver':
      L.rect(0, 0, GRID_W, GRID_H, BG.saver);
      if (reducedMotion) L.rect(10, 7, 4, 2, SCREEN_COLOR.dim);
      else drawSaver(L, f);
      return;
    case 'clock':
      L.rect(0, 0, GRID_W, GRID_H, BG.clock);
      drawClock(L, f);
      R.rect(0, 0, GRID_W, GRID_H, BG.clock);
      for (let i = 0; i < 3; i++) R.rect(6 + i * 5, 7, 2, 2, !reducedMotion && Math.floor(f / 4) % 3 === i ? SCREEN_COLOR.accent : 0x6b7280);
      return;
  }
}

/** Both monitor faces of a desk, in desk-sheet pixels (the caller places them like the sheet). */
export class DeskScreens {
  readonly root = new Container();
  readonly left = new Graphics();
  readonly right = new Graphics();

  constructor() {
    this.left.setFromMatrix(faceMatrix(FACES.left));
    this.right.setFromMatrix(faceMatrix(FACES.right));
    this.root.addChild(this.left, this.right);
  }
}

/** "z z z" rising over a dozing head, in sheet pixels: one z every 0.8 s, each fading as it rises. */
export function paintZs(g: Graphics, f: number, at: { x: number; y: number }): void {
  g.clear();
  const p = new Pixels(g);
  for (let k = 0; k < 2; k++) {
    const age = (f + k * 12) % 24;
    const size = 3 + Math.floor(age / 8);
    p.glyph(GLYPH.z, at.x + age * 1.5, at.y - age * 3, 0xe6e8ee, size);
  }
}
