/**
 * Wall furniture (shelves, cabinets, a server rack) against a building's two back walls. Which pieces
 * a building gets depends on its terminal count; the draw is seeded by the building id, so a building
 * keeps its furniture across rebuilds.
 */
import { Sprite, type Texture } from 'pixi.js';
import type { PlacedFloor } from '../layout/floor';
import { depthOf, toScreen } from '../layout/iso';
import { fnv1a } from '../model';
import { ART_CANVAS, DESK_ART_SIZE, RACK_ART, sheetToTiles, type RackKey } from '../pack/art';
import { lampPose } from './RoomLamp';
import { wallPlaquePose } from './wallPlaque';

/** Clearance between a piece and the wall, the corner, or its neighbour (tiles). */
export const GAP = 0.1;
/** Half the lamp's width on the wall plus clearance, so no piece hides it (tiles). */
const LAMP_CLEAR = 0.25;
const UNLIT_TINT = 0x8890a0;

/** The id's hash, then a small LCG: stable pseudo-random numbers per building. */
function seeded(id: string): () => number {
  let h = fnv1a(id);
  return () => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 0x100000000;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** 1 terminal: none · 2: h · 3: v-2 or h-2 · 4: v + (h or h-2) · 5+: one of each, in random order. */
export function pickRacks(buildingId: string, terminals: number): RackKey[] {
  const rand = seeded(buildingId);
  const pick = (a: RackKey, b: RackKey): RackKey => (rand() < 0.5 ? a : b);
  if (terminals <= 1) return [];
  if (terminals === 2) return ['rack/h'];
  if (terminals === 3) return [pick('rack/v-2', 'rack/h-2')];
  if (terminals === 4) return ['rack/v', pick('rack/h', 'rack/h-2')];
  return shuffle(['rack/h', 'rack/h-2', 'rack/v', 'rack/v-2'], rand);
}

export interface RackPose {
  key: RackKey;
  /** NW corner of the footprint on the city grid */
  gx: number;
  gy: number;
  /** footprint size in tiles */
  w: number;
  d: number;
}

type Span = { from: number; to: number };

function footprint(key: RackKey): { w: number; d: number } {
  const art = RACK_ART[key];
  return { w: sheetToTiles(art.alongGx), d: sheetToTiles(art.alongGy) };
}

/** Free runs of the back wall: corner → lamp, lamp → plaque. */
function backWallSpans(floor: PlacedFloor, lamp: number): Span[] {
  const plaque = wallPlaquePose(floor);
  return [
    { from: floor.origin.gx + GAP, to: lamp - LAMP_CLEAR },
    { from: lamp + LAMP_CLEAR, to: plaque.cx - plaque.halfW - GAP },
  ];
}

/** First span with floor for `length`; the span is consumed up to the piece. */
function takeFrom(spans: Span[], length: number): number | null {
  for (const span of spans) {
    if (span.to - span.from < length) continue;
    const at = span.from;
    span.from += length + GAP;
    return at;
  }
  return null;
}

/**
 * Back pieces run along the back wall between the corner, the lamp and the plaque; side pieces run
 * down the left wall, starting past the back piece standing in the corner so the two never meet
 * there. A piece with no floor left is dropped rather than drawn over the lamp, the plaque or a
 * neighbour.
 */
export function placeRacks(floor: PlacedFloor, keys: RackKey[]): RackPose[] {
  const { gx: ox, gy: oy } = floor.origin;
  const back = keys.filter((k) => RACK_ART[k].wall === 'back');
  const side = keys.filter((k) => RACK_ART[k].wall === 'side');
  const poses: RackPose[] = [];
  const lamp = lampPose(floor).gx;
  const spans = backWallSpans(floor, lamp);
  for (const key of back) {
    const { w, d } = footprint(key);
    const at = takeFrom(spans, w);
    if (at !== null) poses.push({ key, gx: at, gy: oy + GAP / 2, w, d });
  }
  // only a piece in the corner run (before the lamp) can meet a side piece; one past the lamp cannot
  const cornerDepth = Math.max(0, ...poses.filter((p) => p.gx < lamp).map((p) => p.d));
  const sideSpans = [{ from: oy + (cornerDepth ? cornerDepth + GAP : GAP), to: oy + floor.layout.height - GAP }];
  for (const key of side) {
    const { w, d } = footprint(key);
    const at = takeFrom(sideSpans, d);
    if (at !== null) poses.push({ key, gx: ox + GAP / 2, gy: at, w, d });
  }
  return poses;
}

function rackSprite(pose: RackPose, texture: Texture): Sprite {
  const art = RACK_ART[pose.key];
  const s = new Sprite(texture);
  s.anchor.set(art.foot.x / ART_CANVAS, art.foot.y / ART_CANVAS);
  const scale = DESK_ART_SIZE / Math.max(texture.width, 1);
  s.scale.set(scale, scale);
  const foot = toScreen(pose.gx + pose.w, pose.gy + pose.d);
  s.position.set(foot.x, foot.y);
  s.zIndex = depthOf({ gx: pose.gx + pose.w / 2, gy: pose.gy + pose.d / 2 });
  return s;
}

/** The wall pieces of one floor. Sprites sit straight in the depth-sorted layer, like the desks. */
export class RoomRacks {
  readonly sprites: Sprite[];

  constructor(buildingId: string, floor: PlacedFloor, terminals: number, art: Record<string, Texture>, lit: boolean) {
    const poses = placeRacks(floor, pickRacks(buildingId, terminals));
    this.sprites = poses.filter((p) => art[p.key]).map((p) => rackSprite(p, art[p.key]!));
    for (const s of this.sprites) s.eventMode = 'none';
    this.apply(lit);
  }

  apply(lit: boolean): void {
    for (const s of this.sprites) s.tint = lit ? 0xffffff : UNLIT_TINT;
  }
}
