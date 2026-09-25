import { describe, expect, it } from 'vitest';
import { layoutFloor, type PlacedFloor } from '../layout/floor';
import { TILE_H, TILE_W } from '../layout/iso';
import { WALL_H } from './RoomView';
import { plaqueScreenSize, WALL_SKEW, wallPlaquePose } from './wallPlaque';

const placed = (desks: number): PlacedFloor => ({ origin: { gx: 0, gy: 0 }, layout: layoutFloor(desks) });

describe('wallPlaquePose', () => {
  it('hangs a solid plaque on the right side of the wall, clear of the floor', () => {
    const room = placed(4);
    const pose = wallPlaquePose(room);
    const mid = room.origin.gx + room.layout.width / 2;

    expect(pose.cx).toBeGreaterThan(mid);
    expect(pose.z0).toBeGreaterThan(WALL_H * 0.28);
    expect(pose.z1 - pose.z0).toBeGreaterThan(WALL_H * 0.45);
    expect(pose.z1 - pose.z0).toBeLessThan(WALL_H * 0.65);
  });

  it('keeps the plaque inside the right edge of the wall', () => {
    const room = placed(1);
    const pose = wallPlaquePose(room);
    expect(pose.cx + pose.halfW).toBeLessThanOrEqual(room.origin.gx + room.layout.width - 0.2);
    expect(pose.cx - pose.halfW).toBeGreaterThanOrEqual(room.origin.gx);
  });

  it('reads as a nameplate with real height, not a caption strip', () => {
    const size = plaqueScreenSize(wallPlaquePose(placed(4)));
    expect(size.h).toBeGreaterThan(24);
    expect(size.h).toBeLessThan(45);
    expect(size.w).toBeGreaterThan(size.h * 0.75);
  });

  it('shears the name to the right-wall iso slope', () => {
    expect(WALL_SKEW).toBeCloseTo(Math.atan(TILE_H / TILE_W));
  });
});
