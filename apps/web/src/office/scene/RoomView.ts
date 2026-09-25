/** The ground of one building's block, and the floor and two back walls of its one floor. Colours only — no art needed. */
import { Graphics } from 'pixi.js';
import { BLOCK_MARGIN, type PlacedBlock } from '../layout/city';
import type { PlacedFloor } from '../layout/floor';
import { toScreen } from '../layout/iso';
import { quad, world } from './wallQuad';

/** Office walls: high enough to read as a building, low enough not to hide the block behind. */
export const WALL_H = 56;
/** Wall thickness in tiles — enough to read a top and an outer face, without crowding the desks. */
const WALL_THICK = 0.22;
/** Hairline only — the grid should whisper, not compete with the walls. */
const SEAM_WIDTH = 0.5;
const SEAM_ALPHA = 0.28;
/** In world units, so that at city zoom the outline lands on about one pixel. */
const BLOCK_LINE = 3;
/** Pixels of wall base trim above the floor — finishes the wall/floor join. */
const WALL_TRIM = 3;

type FloorColors = {
  a: number;
  b: number;
  c: number;
  seam: number;
  wallL: number;
  wallR: number;
  wallLOuter: number;
  wallROuter: number;
  wallTop: number;
  wallEnd: number;
  trimL: number;
  trimR: number;
};

const LIT: FloorColors = {
  // near-neighbours: variation is broad and soft, never tile-flip contrast
  a: 0x3f4758,
  b: 0x3b4354,
  c: 0x434b5c,
  seam: 0x2e3646,
  wallL: 0x2a303c,
  wallR: 0x343b4a,
  wallLOuter: 0x1a1e26,
  wallROuter: 0x222833,
  wallTop: 0x3e4656,
  wallEnd: 0x1e232c,
  trimL: 0x151820,
  trimR: 0x1a1f28,
};

/** Same layout as lit — only a cooler, lower exposure. The lamp carries the on/off story. */
function dimmed(c: FloorColors): FloorColors {
  const d = (n: number) => {
    const r = ((n >> 16) & 0xff) * 0.62;
    const g = ((n >> 8) & 0xff) * 0.62;
    const b = (n & 0xff) * 0.68;
    return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  };
  return {
    a: d(c.a),
    b: d(c.b),
    c: d(c.c),
    seam: d(c.seam),
    wallL: d(c.wallL),
    wallR: d(c.wallR),
    wallLOuter: d(c.wallLOuter),
    wallROuter: d(c.wallROuter),
    wallTop: d(c.wallTop),
    wallEnd: d(c.wallEnd),
    trimL: d(c.trimL),
    trimR: d(c.trimR),
  };
}
/**
 * A dark block still needs a silhouette. Filled alone, an unlit building's ground was four values per
 * channel away from the page background: its footprint, and the street around it, were simply not
 * there. So every block is outlined, which also tells two neighbouring blocks apart.
 */
const BLOCK = {
  lit: { a: 0x131820, b: 0x11161e, c: 0x161c26, seam: 0x0c1018, line: 0x2c3342 },
  dark: { a: 0x0e1218, b: 0x0c1016, c: 0x10141a, seam: 0x080a10, line: 0x1e2430 },
};

/**
 * Broad, soft floor tone — low-frequency field so neighbouring tiles usually match.
 * Not (gx+gy)%2, not small regular plates: large tonal drifts with rare flecks.
 */
export function tileTone(gx: number, gy: number, a: number, b: number, c: number): number {
  // slow waves → islands of similar shade spanning several tiles
  const n = Math.sin(gx * 0.31 + 0.7) * 0.55 + Math.cos(gy * 0.37 - 0.4) * 0.45 + Math.sin((gx + gy) * 0.19) * 0.35;
  if (n > 0.62) return c;
  if (n < -0.55) return b;
  // rare fleck, broken lattice (not every Nth tile)
  const fleck = Math.abs((gx * 19) ^ (gy * 23) ^ 41) % 17;
  if (fleck === 0 && n > 0) return c;
  return a;
}

/** Paint an iso floor field: soft fills, hairline seams that do not dominate. */
function paintFloorField(g: Graphics, x0: number, y0: number, x1: number, y1: number, a: number, b: number, c: number, seam: number): void {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      const p0 = toScreen(x, y);
      const p1 = toScreen(x + 1, y);
      const p2 = toScreen(x + 1, y + 1);
      const p3 = toScreen(x, y + 1);
      g.poly([p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y])
        .fill(tileTone(x, y, a, b, c))
        .stroke({ color: seam, width: SEAM_WIDTH, alpha: SEAM_ALPHA });
    }
  }
}

/**
 * One building's ground: the tiled pavement around its floor. Also the building's click target — it
 * is what is left uncovered around the floor. Pass `into` to repaint it in place, like `drawFloor`.
 */
export function drawBlock(block: PlacedBlock, lit: boolean, into?: Graphics): Graphics {
  const c = lit ? BLOCK.lit : BLOCK.dark;
  const g = into ?? new Graphics();
  g.clear();
  const x0 = block.origin.gx - BLOCK_MARGIN;
  const y0 = block.origin.gy - BLOCK_MARGIN;
  const x1 = block.origin.gx + block.width + BLOCK_MARGIN;
  const y1 = block.origin.gy + block.height + BLOCK_MARGIN;
  paintFloorField(g, x0, y0, x1, y1, c.a, c.b, c.c, c.seam);
  const n = toScreen(x0, y0);
  const e = toScreen(x1, y0);
  const s = toScreen(x1, y1);
  const w = toScreen(x0, y1);
  g.poly([n.x, n.y, e.x, e.y, s.x, s.y, w.x, w.y]).stroke({ color: c.line, width: BLOCK_LINE });
  g.eventMode = 'static';
  g.cursor = 'pointer';
  return g;
}

/** Vertical face from floor to WALL_H between two floor points. */
function wallFace(g: Graphics, ax: number, ay: number, bx: number, by: number, color: number): void {
  quad(g, world, [[ax, ay, 0], [bx, by, 0], [bx, by, WALL_H], [ax, ay, WALL_H]], color);
}

/** Top cap of a thick wall between the outer and inner edges. */
function wallTop(g: Graphics, ix0: number, iy0: number, ix1: number, iy1: number, ox0: number, oy0: number, ox1: number, oy1: number, color: number): void {
  quad(g, world, [[ox0, oy0, WALL_H], [ox1, oy1, WALL_H], [ix1, iy1, WALL_H], [ix0, iy0, WALL_H]], color);
}

/**
 * One back wall with thickness extruded outward (into the pavement), drawn far→near:
 * outer face, end cap, top, then inner face.
 */
function paintThickWall(
  g: Graphics,
  ix0: number,
  iy0: number,
  ix1: number,
  iy1: number,
  ox0: number,
  oy0: number,
  ox1: number,
  oy1: number,
  inner: number,
  outer: number,
  top: number,
  end: number,
): void {
  wallFace(g, ox0, oy0, ox1, oy1, outer);
  wallFace(g, ix1, iy1, ox1, oy1, end);
  wallTop(g, ix0, iy0, ix1, iy1, ox0, oy0, ox1, oy1, top);
  wallFace(g, ix0, iy0, ix1, iy1, inner);
}

/** Outer corner post where the two thick walls meet (outside the floor). */
function paintWallCorner(g: Graphics, ox: number, oy: number, c: FloorColors): void {
  const t = WALL_THICK;
  wallFace(g, ox - t, oy - t, ox, oy - t, c.wallROuter);
  wallFace(g, ox - t, oy - t, ox - t, oy, c.wallLOuter);
  quad(g, world, [[ox - t, oy - t, WALL_H], [ox, oy - t, WALL_H], [ox, oy, WALL_H], [ox - t, oy, WALL_H]], c.wallTop);
}

function paintWalls(g: Graphics, ox: number, oy: number, width: number, height: number, c: FloorColors): void {
  const t = WALL_THICK;
  // Corner first (farthest), then each run: outer → end → top → inner.
  paintWallCorner(g, ox, oy, c);
  paintThickWall(g, ox, oy, ox + width, oy, ox, oy - t, ox + width, oy - t, c.wallR, c.wallROuter, c.wallTop, c.wallEnd);
  paintThickWall(g, ox, oy, ox, oy + height, ox - t, oy, ox - t, oy + height, c.wallL, c.wallLOuter, c.wallTop, c.wallEnd);
}

function paintTiles(g: Graphics, ox: number, oy: number, width: number, height: number, c: FloorColors): void {
  paintFloorField(g, ox, oy, ox + width, oy + height, c.a, c.b, c.c, c.seam);
}

/** Dark strip along each back wall at floor level — finishes the wall/floor join. */
function paintWallTrim(g: Graphics, ox: number, oy: number, width: number, height: number, c: FloorColors): void {
  const o = toScreen(ox, oy);
  const r = toScreen(ox + width, oy);
  const l = toScreen(ox, oy + height);
  g.poly([o.x, o.y, r.x, r.y, r.x, r.y - WALL_TRIM, o.x, o.y - WALL_TRIM]).fill(c.trimR);
  g.poly([o.x, o.y, l.x, l.y, l.x, l.y - WALL_TRIM, o.x, o.y - WALL_TRIM]).fill(c.trimL);
}

/**
 * Tiles and the two back walls of a building's floor; nothing in front, so people are never covered.
 * Also a click target for the building. Unlit keeps the same shapes — only a dimmer exposure; the
 * wall lamp is the on/off cue. Pass `into` to repaint it in place — a light going out keeps its handlers.
 */
export function drawFloor(floor: PlacedFloor, lit: boolean, into?: Graphics): Graphics {
  const c = lit ? LIT : dimmed(LIT);
  const { gx: ox, gy: oy } = floor.origin;
  const { width, height } = floor.layout;
  const g = into ?? new Graphics();
  g.clear();
  paintWalls(g, ox, oy, width, height, c);
  paintTiles(g, ox, oy, width, height, c);
  paintWallTrim(g, ox, oy, width, height, c);
  g.eventMode = 'static';
  g.cursor = 'pointer';
  return g;
}
