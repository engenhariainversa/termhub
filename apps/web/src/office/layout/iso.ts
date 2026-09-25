/**
 * Isometric geometry and the generated room layout for the office view.
 * Pure functions, no renderer — this is the part that would survive a renderer change.
 */

export const TILE_W = 64;
export const TILE_H = 32;

export interface Cell {
  gx: number;
  gy: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Grid → screen, 2:1 isometric. `(gx, gy)` may be fractional; `z` is height in pixels.
 * The point returned for an integer cell is the top vertex of that tile's diamond.
 */
export function toScreen(gx: number, gy: number, z = 0): Point {
  return { x: ((gx - gy) * TILE_W) / 2, y: ((gx + gy) * TILE_H) / 2 - z };
}

/** Painter's order: whatever is further down the screen is drawn later. */
export function depthOf(cell: Cell): number {
  return cell.gx + cell.gy;
}

export interface RoomLayout {
  /** room size in tiles */
  width: number;
  height: number;
  /** one cell per desk, in the order the desks were given */
  desks: Cell[];
}

/**
 * Lays out `count` desks in rows with a one-tile aisle around each, in a room a bit wider than
 * deep. The room grows with the count, so nothing here is hand-placed. A single desk sits near
 * the bay centre so the station reads as centred in a 1-terminal office.
 * After sizing, grows one tile on the shorter side and moves the desks a whole tile off that back
 * wall, which leaves a strip for the wall furniture.
 */
export function layoutRoom(count: number): RoomLayout {
  const n = Math.max(0, count);
  if (n === 0) return growMinSide({ width: 5, height: 3, desks: [] });
  if (n === 1) return growMinSide({ width: 5, height: 3, desks: [{ gx: 2, gy: 1 }] });
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.6)));
  const rows = Math.ceil(n / cols);
  const desks: Cell[] = [];
  for (let i = 0; i < n; i++) {
    desks.push({ gx: 1 + (i % cols) * 2, gy: 1 + Math.floor(i / cols) * 2 });
  }
  return growMinSide({ width: cols * 2 + 1, height: rows * 2 + 1, desks });
}

/**
 * +1 tile on the shorter axis (height when tied). On that axis the desks move a whole tile away
 * from the back wall — the strip the wall furniture stands in — and on the other half a tile, off
 * the longer wall.
 */
function growMinSide(layout: RoomLayout): RoomLayout {
  const growX = layout.width < layout.height;
  const ox = growX ? 1 : 0.5;
  const oy = growX ? 0.5 : 1;
  return {
    width: layout.width + (growX ? 1 : 0),
    height: layout.height + (growX ? 0 : 1),
    desks: layout.desks.map((d) => ({ gx: d.gx + ox, gy: d.gy + oy })),
  };
}

/** Screen-space bounding box of a room's floor, walls included (`wallH` pixels above the floor). */
export function roomBounds(layout: RoomLayout, wallH: number): { x: number; y: number; w: number; h: number } {
  const left = toScreen(0, layout.height).x;
  const right = toScreen(layout.width, 0).x;
  const bottom = toScreen(layout.width, layout.height).y;
  return { x: left, y: -wallH, w: right - left, h: bottom + wallH };
}
