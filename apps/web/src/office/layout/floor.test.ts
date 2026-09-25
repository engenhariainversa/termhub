import { describe, expect, it } from 'vitest';
import { layoutFloor } from './floor';

describe('layoutFloor', () => {
  // city-by-project §3.2: no rooms any more — every desk of a building on one floor
  it('puts every desk of a building on its one floor, row by row, none outside it', () => {
    const floor = layoutFloor(7);
    expect(floor.desks).toHaveLength(7);
    expect(new Set(floor.desks.map((d) => `${d.gx},${d.gy}`)).size).toBe(7);
    for (const d of floor.desks) {
      expect(d.gx).toBeGreaterThan(0);
      expect(d.gy).toBeGreaterThan(0);
      expect(d.gx).toBeLessThan(floor.width);
      expect(d.gy).toBeLessThan(floor.height);
    }
    expect(floor.desks.slice(0, 2)).toEqual([{ gx: 1.5, gy: 2 }, { gx: 3.5, gy: 2 }]);
  });

  it('grows with the desks and keeps a small floor for a building with none', () => {
    expect(layoutFloor(0)).toEqual({ width: 5, height: 4, desks: [] });
    const area = (n: number) => layoutFloor(n).width * layoutFloor(n).height;
    expect(area(40)).toBeGreaterThan(area(4));
  });
});

