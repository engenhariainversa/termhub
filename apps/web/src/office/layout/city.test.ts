import { describe, expect, it } from 'vitest';
import { BLOCK_MARGIN, blockBounds, cityBounds, floorOnCity, layoutCity, STREET } from './city';

const block = (id: string, desks: number) => ({ id, desks });
const overlap = (a: { origin: { gx: number; gy: number }; width: number; height: number }, b: typeof a) =>
  a.origin.gx < b.origin.gx + b.width && b.origin.gx < a.origin.gx + a.width && a.origin.gy < b.origin.gy + b.height && b.origin.gy < a.origin.gy + a.height;

describe('layoutCity', () => {
  it('keeps the order given and separates blocks by a street', () => {
    const city = layoutCity([block('a', 2), block('b', 2)], 60);
    expect(city.blocks.map((b) => b.id)).toEqual(['a', 'b']);
    expect(city.blocks[1].origin).toEqual({ gx: city.blocks[0].width + STREET, gy: 0 });
  });
  it('never overlaps blocks of very different sizes, and stays inside its own size', () => {
    const city = layoutCity([block('a', 13), block('b', 40), block('c', 0), block('d', 18), block('e', 7)]);
    for (let i = 0; i < city.blocks.length; i++) for (let j = i + 1; j < city.blocks.length; j++) expect(overlap(city.blocks[i], city.blocks[j])).toBe(false);
    for (const b of city.blocks) {
      expect(b.origin.gx + b.width).toBeLessThanOrEqual(city.width);
      expect(b.origin.gy + b.height).toBeLessThanOrEqual(city.height);
    }
  });
  it('gives a building with no desk a minimal block, so its sign has ground to stand on', () => {
    const city = layoutCity([block('empty', 0)]);
    expect([city.blocks[0].width, city.blocks[0].height]).toEqual([5, 4]);
    expect(city.blocks[0].floor.desks).toEqual([]);
  });
  it('is an empty, finite city for no buildings', () => {
    const city = layoutCity([]);
    expect(city).toEqual({ blocks: [], width: 0, height: 0 });
    expect(Object.values(cityBounds(city, 28)).every(Number.isFinite)).toBe(true);
  });
  it('keeps an earlier block where it was when a later one grows', () => {
    const before = layoutCity([block('a', 3), block('b', 3)], 80);
    const after = layoutCity([block('a', 3), block('b', 30)], 80);
    expect(after.blocks[0].origin).toEqual(before.blocks[0].origin);
  });
});

describe('floorOnCity / bounds', () => {
  it("puts a block's floor at the block's own origin, leaving its layout alone", () => {
    const city = layoutCity([block('a', 2), block('b', 4)], 60);
    const placed = floorOnCity(city.blocks[1]);
    expect(placed.origin).toEqual(city.blocks[1].origin);
    expect(placed.layout).toBe(city.blocks[1].floor);
  });
  it('frames the pavement the block is drawn with, not only its floor', () => {
    const city = layoutCity([block('a', 2)]);
    const b = city.blocks[0];
    expect([b.origin, b.width, b.height]).toEqual([{ gx: 0, gy: 0 }, 5, 4]);
    // drawBlock paints the footprint grown by BLOCK_MARGIN on every side: 64 px per tile across, 32 down, 28 px of walls on top
    expect(BLOCK_MARGIN).toBe(1);
    expect(blockBounds(b, 28)).toEqual({ x: -192, y: -60, w: 416, h: 236 });
    expect(cityBounds(city, 28)).toEqual(blockBounds(b, 28));
  });
  it('puts a later block of the same row to the right of an earlier one, and the city spans both', () => {
    const city = layoutCity([block('a', 2), block('b', 2)], 60);
    const [a, b] = city.blocks.map((x) => blockBounds(x, 28));
    expect(b.x).toBeGreaterThan(a.x);
    const all = cityBounds(city, 28);
    expect(all.x).toBeLessThanOrEqual(a.x);
    expect(all.x + all.w).toBeGreaterThanOrEqual(b.x + b.w);
  });
});
