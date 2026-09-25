import { describe, expect, it } from 'vitest';
import { layoutFloor, type PlacedFloor } from '../layout/floor';
import { WALL_H } from './RoomView';
import { lampPose } from './RoomLamp';

const placed = (desks: number): PlacedFloor => ({ origin: { gx: 0, gy: 0 }, layout: layoutFloor(desks) });

describe('lampPose', () => {
  it('mounts a wall lantern on the right back wall, mid-height', () => {
    const room = placed(4);
    const pose = lampPose(room);
    expect(pose.gy).toBeCloseTo(room.origin.gy + 0.04);
    expect(pose.gx).toBeGreaterThan(room.origin.gx);
    expect(pose.gx).toBeLessThan(room.origin.gx + room.layout.width);
    expect(pose.z).toBeGreaterThan(WALL_H * 0.4);
    expect(pose.z).toBeLessThan(WALL_H * 0.7);
  });

  it('sits close enough to the corner that wash must wrap onto the left wall', () => {
    const room = placed(2);
    const pose = lampPose(room);
    // widest layer reach 2.25 — without wrap this would spill past ox
    expect(pose.gx - 2.25).toBeLessThan(room.origin.gx);
  });
});
