/**
 * Architectural wall nameplate on the right side of each building's back wall. Same type and colours
 * as the overlay's identity; skewed onto the iso wall so it reads as a hung plaque, not HUD.
 */
import { Container, Graphics, Text } from 'pixi.js';
import type { PlacedFloor } from '../layout/floor';
import { depthOf, TILE_H, TILE_W, toScreen, type Point } from '../layout/iso';
import { ID } from './identity';
import { WALL_H } from './RoomView';
import { localOf, quad, type Local } from './wallQuad';

/** Iso shear of the right back wall — baselines follow the wall, stems stay upright. */
export const WALL_SKEW = Math.atan(TILE_H / TILE_W);

export type WallPlaquePose = {
  cx: number;
  gy: number;
  halfW: number;
  z0: number;
  z1: number;
  center: Point;
};

/** Solid horizontal plaque on the right of the back wall, clear of the floor. */
export function wallPlaquePose(floor: PlacedFloor): WallPlaquePose {
  const { gx: ox, gy: oy } = floor.origin;
  const w = floor.layout.width;
  const edge = 0.5;
  const halfW = Math.min(1.3, Math.max(0.95, w * 0.36), (w - edge * 2) / 2);
  const cx = ox + w - edge - halfW;
  const gy = oy + 0.12;
  // robust nameplate height, raised off the floor/trim
  const halfH = WALL_H * 0.27;
  const mid = WALL_H * 0.58;
  return { cx, gy, halfW, z0: mid - halfH, z1: mid + halfH, center: toScreen(cx, gy, mid) };
}

/** A rectangle on the back wall (`gy` fixed) from `x0` to `x1` and from `z0` up to `z1`. */
function wallRect(g: Graphics, local: Local, gy: number, x0: number, x1: number, z0: number, z1: number, color: number, alpha = 1): void {
  quad(g, local, [[x0, gy, z0], [x1, gy, z0], [x1, gy, z1], [x0, gy, z1]], color, alpha);
}

export function plaqueScreenSize(pose: WallPlaquePose): { w: number; h: number } {
  const bl = toScreen(pose.cx - pose.halfW, pose.gy, pose.z0);
  const br = toScreen(pose.cx + pose.halfW, pose.gy, pose.z0);
  const tl = toScreen(pose.cx - pose.halfW, pose.gy, pose.z1);
  return { w: Math.hypot(br.x - bl.x, br.y - bl.y), h: Math.hypot(tl.x - bl.x, tl.y - bl.y) };
}

type Inset = { gx: number; z: number };

/** Framed floor nameplate — matches the floating card's type, sits in the wall as architecture. */
export class RoomWallPlaque {
  readonly root = new Container();
  private readonly plate = new Graphics();
  private readonly label: Text;

  constructor(floor: PlacedFloor, model: { label: string; lit: boolean }) {
    // the identity face (see identity.ts): sans, 600, natural casing
    this.label = new Text({
      text: '',
      style: {
        fontSize: 13,
        fill: ID.fg,
        fontWeight: '600',
        fontFamily: ID.font,
        letterSpacing: 0.2,
      },
    });
    this.label.anchor.set(0.5);
    this.root.addChild(this.plate, this.label);
    this.root.eventMode = 'none';
    this.apply(floor, model);
  }

  apply(floor: PlacedFloor, model: { label: string; lit: boolean }): void {
    const pose = wallPlaquePose(floor);
    this.root.position.set(pose.center.x, pose.center.y);
    this.root.zIndex = depthOf({ gx: pose.cx, gy: pose.gy });
    const inset = this.paintFrame(pose, model.lit);
    this.fitLabel(model.label, model.lit, pose, inset);
  }

  private paintFrame(pose: WallPlaquePose, lit: boolean): Inset {
    const { cx, gy, halfW, z0, z1 } = pose;
    const local = localOf(pose.center);
    const rect = (x0: number, x1: number, zLo: number, zHi: number, color: number, alpha = 1) => wallRect(this.plate, local, gy, x0, x1, zLo, zHi, color, alpha);
    const h = z1 - z0;
    // card colours: dark face, line moulding, soft depth
    const moulding = lit ? ID.lineBright : ID.line;
    const well = lit ? 0x0c0e14 : 0x080a10;
    const face = lit ? 0x161920 : 0x12151c;
    this.plate.clear();
    rect(cx - halfW + 0.05, cx + halfW + 0.09, z0 - 2, z1 - 2, 0x000000, 0.32);
    // outer frame
    rect(cx - halfW, cx + halfW, z0, z1, moulding);
    // top highlight / bottom shade on the frame
    rect(cx - halfW, cx + halfW, z1 - h * 0.08, z1, lit ? 0x4a5368 : 0x2a3140);
    rect(cx - halfW, cx + halfW, z0, z0 + h * 0.08, lit ? 0x1a1e28 : 0x10141a);
    // recessed well + inner face (even padding)
    const g1 = halfW * 0.1;
    const z1i = h * 0.12;
    rect(cx - halfW + g1, cx + halfW - g1, z0 + z1i, z1 - z1i, well);
    const gx = halfW * 0.16;
    const z = h * 0.2;
    rect(cx - halfW + gx, cx + halfW - gx, z0 + z, z1 - z, face);
    return { gx, z };
  }

  private fitLabel(text: string, lit: boolean, pose: WallPlaquePose, inset: Inset): void {
    const mid = localOf(pose.center)(pose.cx, pose.gy, (pose.z0 + pose.z1) / 2);
    this.label.text = text;
    this.label.style.fill = lit ? ID.fg : ID.dim;
    this.label.alpha = lit ? 1 : 0.55;
    this.label.rotation = 0;
    this.label.skew.set(0, WALL_SKEW);
    this.label.scale.set(1);
    this.label.anchor.set(0.5);
    this.label.pivot.set(0, 0);
    const size = plaqueScreenSize(pose);
    const faceW = size.w * (1 - inset.gx / pose.halfW);
    const faceH = size.h * (1 - (2 * inset.z) / (pose.z1 - pose.z0));
    const sx = this.label.width > faceW * 0.82 ? (faceW * 0.82) / this.label.width : 1;
    const sy = this.label.height > faceH * 0.5 ? (faceH * 0.5) / this.label.height : 1;
    this.label.scale.set(Math.min(sx, sy));
    this.label.position.set(mid.x, mid.y);
  }
}
