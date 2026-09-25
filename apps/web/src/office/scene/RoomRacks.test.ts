import { describe, expect, it } from 'vitest';
import { layoutFloor, type PlacedFloor } from '../layout/floor';
import { lampPose } from './RoomLamp';
import { GAP, pickRacks, placeRacks, type RackPose } from './RoomRacks';
import { wallPlaquePose } from './wallPlaque';

const ids = Array.from({ length: 40 }, (_, i) => `room-${i}`);
const room = (desks: number): PlacedFloor => ({ origin: { gx: 0, gy: 0 }, layout: layoutFloor(desks) });
const overlap = (a: RackPose, b: RackPose) => a.gx < b.gx + b.w && b.gx < a.gx + a.w && a.gy < b.gy + b.d && b.gy < a.gy + a.d;

describe('pickRacks', () => {
  it('gives a 1-terminal office nothing and a 2-terminal office the low cabinet', () => {
    expect(pickRacks('a', 1)).toEqual([]);
    expect(pickRacks('a', 2)).toEqual(['rack/h']);
  });
  it('gives 3 terminals one of v-2 / h-2, and draws both across rooms', () => {
    const seen = new Set(ids.map((id) => pickRacks(id, 3)[0]));
    expect(seen).toEqual(new Set(['rack/v-2', 'rack/h-2']));
  });
  it('gives 4 terminals the server rack plus one of h / h-2', () => {
    for (const id of ids) {
      const [v, h] = pickRacks(id, 4);
      expect(v).toBe('rack/v');
      expect(['rack/h', 'rack/h-2']).toContain(h);
    }
  });
  it('gives 5+ terminals one of each', () => {
    for (const n of [5, 12]) expect([...pickRacks('a', n)].sort()).toEqual(['rack/h', 'rack/h-2', 'rack/v', 'rack/v-2']);
  });
  it('is stable for a room id', () => {
    expect(pickRacks('same', 6)).toEqual(pickRacks('same', 6));
  });
});

describe('placeRacks', () => {
  it('fits every piece in the room without overlaps, clear of the lamp and the plaque', () => {
    for (const desks of [2, 3, 4, 5, 9]) {
      for (const id of ids.slice(0, 10)) {
        const r = room(desks);
        const keys = pickRacks(id, desks);
        const poses = placeRacks(r, keys);
        expect(poses).toHaveLength(keys.length);
        const lamp = lampPose(r).gx;
        const plaque = wallPlaquePose(r);
        for (const p of poses) {
          expect(p.gx).toBeGreaterThanOrEqual(r.origin.gx);
          expect(p.gy).toBeGreaterThanOrEqual(r.origin.gy);
          expect(p.gx + p.w).toBeLessThanOrEqual(r.origin.gx + r.layout.width);
          expect(p.gy + p.d).toBeLessThanOrEqual(r.origin.gy + r.layout.height);
          if (p.key.startsWith('rack/h')) {
            expect(lamp > p.gx && lamp < p.gx + p.w).toBe(false);
            expect(p.gx + p.w).toBeLessThanOrEqual(plaque.cx - plaque.halfW);
          }
        }
        for (const a of poses) for (const b of poses) if (a !== b) expect(overlap(a, b)).toBe(false);
      }
    }
  });
  it('starts the side pieces past the piece standing in the corner, not past the deepest back piece', () => {
    const r = room(5);
    // the shallow bookshelf takes the corner run, the deep cabinet lands past the lamp
    const [shelf, cabinet, rack] = placeRacks(r, ['rack/h-2', 'rack/h', 'rack/v']);
    expect(shelf!.gx).toBeLessThan(lampPose(r).gx);
    expect(cabinet!.gx).toBeGreaterThan(lampPose(r).gx);
    expect(shelf!.d).toBeLessThan(cabinet!.d);
    expect(rack!.gy).toBeCloseTo(r.origin.gy + shelf!.d + GAP);
  });
  it('keeps pieces off the desks', () => {
    for (const desks of [2, 3, 4, 5, 9]) {
      const r = room(desks);
      const poses = placeRacks(r, pickRacks('r', desks));
      for (const p of poses) {
        for (const d of r.layout.desks) {
          // a desk sheet covers about ±0.6 tile around its cell
          const desk = { key: 'rack/h' as const, gx: d.gx - 0.6, gy: d.gy - 0.6, w: 1.2, d: 1.2 };
          expect(overlap({ ...p, gx: p.gx - r.origin.gx, gy: p.gy - r.origin.gy }, desk)).toBe(false);
        }
      }
    }
  });
});
