/**
 * Wall lantern on each building's right back wall. A lit building gets a directional warm wash on
 * the wall and floor. At the back corner the wash turns onto the left wall instead of spilling outside.
 */
import { Container, Graphics } from 'pixi.js';
import type { PlacedFloor } from '../layout/floor';
import { toScreen } from '../layout/iso';
import { WALL_H } from './RoomView';
import { localOf, quad, type Local } from './wallQuad';

const METAL = 0x4a5366;
const METAL_DIM = 0x2a3140;
const METAL_HI = 0x6a7388;
const GLASS_ON = 0xffe09a;
const GLASS_CORE = 0xfff6d0;
const GLASS_OFF = 0x1e2430;
const WASH = 0xf0c878;
const WASH_HOT = 0xffe6b0;

export type LampPose = {
  gx: number;
  gy: number;
  z: number;
};

/** Wall-mounted lantern on the right back wall, near the inner corner. */
export function lampPose(floor: PlacedFloor): LampPose {
  const { gx: ox, gy: oy } = floor.origin;
  const w = floor.layout.width;
  const gx = ox + Math.min(1.35, Math.max(0.9, w * 0.28));
  return { gx, gy: oy + 0.04, z: WALL_H * 0.52 };
}

/**
 * Built-in wall lantern. `apply(false)` keeps the fixture, kills the wash. Painted with the walls,
 * under the depth-sorted things: the wash lands behind the furniture and the desks, never on them.
 */
export class RoomLamp {
  readonly root = new Container();
  private readonly wash = new Graphics();
  private readonly fixture = new Graphics();
  private lit = true;
  private pose: LampPose = { gx: 0, gy: 0, z: 0 };
  private floor: PlacedFloor;

  constructor(floor: PlacedFloor, lit: boolean) {
    this.floor = floor;
    this.root.addChild(this.wash, this.fixture);
    this.root.eventMode = 'none';
    this.place(floor);
    this.apply(lit);
  }

  place(floor: PlacedFloor): void {
    this.floor = floor;
    this.pose = lampPose(floor);
    const at = toScreen(this.pose.gx, this.pose.gy, 0);
    this.root.position.set(at.x, at.y);
  }

  private local(): Local {
    return localOf(toScreen(this.pose.gx, this.pose.gy, 0));
  }

  apply(lit: boolean): void {
    this.lit = lit;
    this.paintWash();
    this.paintFixture();
  }

  private paintWash(): void {
    this.wash.clear();
    this.wash.visible = this.lit;
    if (!this.lit) return;
    const loc = this.local();
    this.paintWallWash(loc);
    this.paintFloorWash(loc);
  }

  /**
   * Wash on the right wall, clipped at the back corner. Whatever would have spilled past the left
   * edge continues onto the left wall — the light turns the corner with the architecture.
   */
  private paintWallWash(loc: Local): void {
    const { gx, gy, z } = this.pose;
    const { gx: ox, gy: oy } = this.floor.origin;
    const gMax = ox + this.floor.layout.width - 0.04;
    const zLo = z - WALL_H * 0.28;
    const zHi = Math.min(WALL_H * 0.92, z + WALL_H * 0.32);
    for (const { s, a } of [
      { s: 0.55, a: 0.2 },
      { s: 1.05, a: 0.12 },
      { s: 1.65, a: 0.07 },
      { s: 2.25, a: 0.04 },
    ]) {
      const left = Math.max(ox + 0.04, gx - s);
      const right = Math.min(gMax, gx + s);
      if (right > left) {
        quad(this.wash, loc, [
          [left, gy, zLo],
          [right, gy, zLo],
          [right, gy, zHi],
          [left, gy, zHi],
        ], WASH, a);
      }
      // spill past the corner → wrap onto the left wall (along +gy)
      const overflow = ox + 0.04 - (gx - s);
      if (overflow > 0.05) {
        const gy1 = Math.min(oy + this.floor.layout.height - 0.04, oy + 0.04 + overflow);
        const wallGx = ox + 0.04;
        if (gy1 > oy + 0.08) {
          quad(this.wash, loc, [
            [wallGx, oy + 0.04, zLo],
            [wallGx, gy1, zLo],
            [wallGx, gy1, zHi],
            [wallGx, oy + 0.04, zHi],
          ], WASH, a * 0.9);
        }
      }
    }
    const coreL = Math.max(ox + 0.04, gx - 0.22);
    const coreR = Math.min(gMax, gx + 0.22);
    if (coreR > coreL) {
      quad(this.wash, loc, [
        [coreL, gy, z - 8],
        [coreR, gy, z - 8],
        [coreR, gy, z + 10],
        [coreL, gy, z + 10],
      ], WASH_HOT, 0.28);
    }
  }

  private paintFloorWash(loc: Local): void {
    const { gx } = this.pose;
    const { gx: ox, gy: oy } = this.floor.origin;
    const gMin = ox + 0.05;
    const gMax = ox + this.floor.layout.width - 0.05;
    const gyMax = oy + this.floor.layout.height - 0.05;
    const floorGy0 = oy + 0.08;
    for (const { d, s0, s1, a } of [
      { d: 0.7, s0: 0.7, s1: 0.45, a: 0.14 },
      { d: 1.35, s0: 1.1, s1: 0.55, a: 0.08 },
      { d: 2.0, s0: 1.4, s1: 0.5, a: 0.04 },
    ]) {
      const left0 = Math.max(gMin, gx - s0);
      const right0 = Math.min(gMax, gx + s0);
      const left1 = Math.max(gMin, gx - s1);
      const right1 = Math.min(gMax, gx + s1);
      const gy1 = Math.min(gyMax, floorGy0 + d);
      if (right0 <= left0 || right1 <= left1) continue;
      quad(this.wash, loc, [
        [left0, floorGy0, 0],
        [right0, floorGy0, 0],
        [right1, gy1, 0],
        [left1, gy1, 0],
      ], WASH, a);
    }
  }

  private paintFixture(): void {
    this.fixture.clear();
    const loc = this.local();
    this.paintMount(loc);
    this.paintLantern(loc);
  }

  private paintMount(loc: Local): void {
    const { gx, gy, z } = this.pose;
    const metal = this.lit ? METAL : METAL_DIM;
    quad(this.fixture, loc, [
      [gx - 0.08, gy, z - 7],
      [gx + 0.08, gy, z - 7],
      [gx + 0.08, gy, z + 9],
      [gx - 0.08, gy, z + 9],
    ], metal, 1);
    const gy2 = gy + 0.12;
    quad(this.fixture, loc, [
      [gx - 0.03, gy, z - 1],
      [gx + 0.03, gy, z - 1],
      [gx + 0.03, gy2, z - 1],
      [gx - 0.03, gy2, z - 1],
    ], metal, 1);
    quad(this.fixture, loc, [
      [gx - 0.03, gy, z + 2],
      [gx + 0.03, gy, z + 2],
      [gx + 0.03, gy2, z + 2],
      [gx - 0.03, gy2, z + 2],
    ], METAL_HI, 0.7);
  }

  private paintLantern(loc: Local): void {
    const { gx, gy, z } = this.pose;
    const metal = this.lit ? METAL : METAL_DIM;
    const glass = this.lit ? GLASS_ON : GLASS_OFF;
    const g0 = gy + 0.08;
    const g1 = gy + 0.22;
    const z0 = z - 5;
    const z1 = z + 7;
    quad(this.fixture, loc, [[gx - 0.11, g0, z0], [gx - 0.11, g1, z0], [gx - 0.11, g1, z1], [gx - 0.11, g0, z1]], glass, this.lit ? 0.9 : 1);
    quad(this.fixture, loc, [[gx + 0.11, g0, z0], [gx + 0.11, g1, z0], [gx + 0.11, g1, z1], [gx + 0.11, g0, z1]], glass, this.lit ? 0.75 : 1);
    quad(this.fixture, loc, [[gx - 0.11, g1, z0], [gx + 0.11, g1, z0], [gx + 0.11, g1, z1], [gx - 0.11, g1, z1]], glass, this.lit ? 0.95 : 1);
    if (this.lit) {
      quad(this.fixture, loc, [
        [gx - 0.06, g0 + 0.02, z - 2],
        [gx + 0.06, g0 + 0.02, z - 2],
        [gx + 0.06, g1 - 0.02, z + 4],
        [gx - 0.06, g1 - 0.02, z + 4],
      ], GLASS_CORE, 0.65);
    }
    quad(this.fixture, loc, [
      [gx - 0.14, g0 - 0.02, z1],
      [gx + 0.14, g0 - 0.02, z1],
      [gx + 0.1, g1 + 0.02, z1 + 3],
      [gx - 0.1, g1 + 0.02, z1 + 3],
    ], metal, 1);
    quad(this.fixture, loc, [[gx - 0.12, g0, z0], [gx + 0.12, g0, z0], [gx + 0.12, g1, z0], [gx - 0.12, g1, z0]], METAL_DIM, 1);
    quad(this.fixture, loc, [
      [gx - 0.03, g0 + 0.04, z1 + 3],
      [gx + 0.03, g0 + 0.04, z1 + 3],
      [gx + 0.02, g1 - 0.02, z1 + 6],
      [gx - 0.02, g1 - 0.02, z1 + 6],
    ], METAL_HI, 1);
  }
}
