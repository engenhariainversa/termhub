import { describe, expect, it } from 'vitest';
import { layoutCity } from '../layout/city';
import { drawBlock, tileTone } from './RoomView';

describe('drawBlock', () => {
  it('paints a tiled platform for the building block, not a flat fill', () => {
    const city = layoutCity([{ id: 'a', desks: 2 }]);
    const g = drawBlock(city.blocks[0]!, true);
    const b = g.getBounds();
    expect(b.isEmpty()).toBe(false);
    expect(b.width).toBeGreaterThan(32);
    expect(b.height).toBeGreaterThan(16);
  });

  it('still paints when the building is unlit', () => {
    const city = layoutCity([{ id: 'a', desks: 1 }]);
    const g = drawBlock(city.blocks[0]!, false);
    expect(g.getBounds().isEmpty()).toBe(false);
  });
});

describe('tileTone', () => {
  it('keeps most horizontal neighbours on the same tone (no checkerboard)', () => {
    let same = 0;
    let total = 0;
    for (let x = 0; x < 30; x++) {
      for (let y = 0; y < 30; y++) {
        if (tileTone(x, y, 1, 2, 3) === tileTone(x + 1, y, 1, 2, 3)) same++;
        total++;
      }
    }
    expect(same / total).toBeGreaterThan(0.7);
  });

  it('is not a strict alternating lattice', () => {
    let alternating = 0;
    for (let x = 0; x < 20; x++) {
      const t0 = tileTone(x, 0, 1, 2, 3);
      const t1 = tileTone(x + 1, 0, 1, 2, 3);
      if (t0 !== t1) alternating++;
    }
    expect(alternating).toBeLessThan(12);
  });

  it('still has soft variation across a wide field', () => {
    const tones = new Set<number>();
    for (let x = 0; x < 40; x++) for (let y = 0; y < 40; y++) tones.add(tileTone(x, y, 10, 20, 30));
    expect(tones.size).toBeGreaterThanOrEqual(2);
  });
});
