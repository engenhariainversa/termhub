/** Iso quads for what is painted onto a floor's walls: the walls themselves, the lamp, the plaque. */
import type { Graphics } from 'pixi.js';
import { toScreen, type Point } from '../layout/iso';

/** A point on the grid with a height in pixels: `[gx, gy, z]`. */
export type GridPoint = [gx: number, gy: number, z: number];

/** Grid → screen, in the coordinates of the Graphics being painted. */
export type Local = (gx: number, gy: number, z: number) => Point;

/** For a Graphics positioned at `origin` (a screen point): its quads are drawn relative to it. */
export function localOf(origin: Point): Local {
  return (gx, gy, z) => {
    const p = toScreen(gx, gy, z);
    return { x: p.x - origin.x, y: p.y - origin.y };
  };
}

/** For a Graphics that sits at the world origin. */
export const world: Local = (gx, gy, z) => toScreen(gx, gy, z);

/** Fills the four-sided face through `pts`, in that order. */
export function quad(g: Graphics, local: Local, pts: [GridPoint, GridPoint, GridPoint, GridPoint], color: number, alpha = 1): void {
  const a = local(...pts[0]);
  const b = local(...pts[1]);
  const c = local(...pts[2]);
  const d = local(...pts[3]);
  g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]).fill({ color, alpha });
}
