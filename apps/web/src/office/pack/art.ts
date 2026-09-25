/** Pixel-art desks, agents and displays that live beside the generated pack (PNG files in `./art`). */
import agentVUrl from './art/agent-v.png';
import chairEmptyHUrl from './art/chair-empty-h.png';
import deskNotebookHOffUrl from './art/desk-notebook-h-off.png';
import deskVOff2Url from './art/desk-v-off-2.png';
import displayVOn2Url from './art/display-v-on-2.png';
import rackH2Url from './art/hack-h-2.png';
import rackHUrl from './art/hack-h.png';
import rackV2Url from './art/hack-v-2.png';
import rackVUrl from './art/hack-v.png';
import { TILE_W } from '../layout/iso';

/** Vite URL for each art file we ship. Keys match sprite ids used by the scene. */
export const ART_URLS: Record<string, string> = {
  'desk/side-v-2': deskVOff2Url,
  'desk/side-h': deskNotebookHOffUrl,
  'display/v-2': displayVOn2Url,
  'agent/side-v': agentVUrl,
  'chair/h': chairEmptyHUrl,
  'rack/h': rackHUrl,
  'rack/h-2': rackH2Url,
  'rack/v': rackVUrl,
  'rack/v-2': rackV2Url,
};

/**
 * Shared station registration — the layers of a desk share one canvas, so one anchor places them all.
 * Foot sits near the desk legs.
 */
export const STATION_ANCHOR = { x: 0.5, y: 0.84 };

/** On-screen width of a station sheet (all layers share this scale). */
export const DESK_ART_SIZE = 72 * 0.9;
/** Every art sheet is a square canvas of this many pixels, drawn at the same scale. */
export const ART_CANVAS = 512;

export type RackKey = 'rack/h' | 'rack/h-2' | 'rack/v' | 'rack/v-2';

/**
 * A wall piece's footprint, measured on its sheet: `foot` is the bottom corner of the footprint
 * (nearest the viewer), `alongGx` / `alongGy` the sheet pixels from that corner to the left / right
 * extreme. `back` pieces face +gy and stand on the back wall (along gx); `side` pieces face +gx and
 * stand on the left wall (along gy).
 */
export interface RackArt {
  wall: 'back' | 'side';
  foot: { x: number; y: number };
  alongGx: number;
  alongGy: number;
}

export const RACK_ART: Record<RackKey, RackArt> = {
  'rack/h': { wall: 'back', foot: { x: 306, y: 471 }, alongGx: 180, alongGy: 95 },
  'rack/h-2': { wall: 'back', foot: { x: 380, y: 495 }, alongGx: 195, alongGy: 33 },
  'rack/v': { wall: 'side', foot: { x: 198, y: 501 }, alongGx: 86, alongGy: 100 },
  'rack/v-2': { wall: 'side', foot: { x: 150, y: 495 }, alongGx: 66, alongGy: 174 },
};

/** Sheet pixels → tiles along one grid axis (one tile spans TILE_W / 2 screen px sideways). */
export function sheetToTiles(px: number): number {
  return (px * (DESK_ART_SIZE / ART_CANVAS)) / (TILE_W / 2);
}

export type DeskArtKeys = {
  desk: string;
  /** person+chair when occupied; null when empty / phone */
  agent: string | null;
  /** empty chair when no agent; drawn above the empty desk */
  chair: string | null;
  /** lit monitors under the agent; null when the seat is empty */
  display: string | null;
};

/**
 * Occupied: desk-v-2 → display → agent (same place).
 * Empty: desk-h → chair-h on top (same place).
 */
export function deskArtKeys(showAgent: boolean): DeskArtKeys {
  if (showAgent) {
    return {
      desk: 'desk/side-v-2',
      agent: 'agent/side-v',
      chair: null,
      display: 'display/v-2',
    };
  }
  return {
    desk: 'desk/side-h',
    agent: null,
    chair: 'chair/h',
    display: null,
  };
}
