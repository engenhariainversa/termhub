/**
 * The city soundscape (spec 2026-09-23 §2.5): an office ambience, a recorded keyboard that follows
 * the robots typing, and a soft synthesised ding when a robot raises its hand, through a three-band
 * equaliser. The recordings are in `./audio` (Pixabay Content License, see its README). It always
 * feeds a MediaStream (the video's audio track) and, when the visitor turns the sound on, the
 * speakers too; the mix is the visitor's, kept in this browser (`loadMix`/`saveMix`).
 */
import type { CityModel } from '../../office/model';
import ambienceUrl from './audio/office-ambience.mp3';
import keyboardUrl from './audio/keyboard.mp3';

export type SoundEvent = { kind: 'typing'; typists: number } | { kind: 'ding'; desk: string };

function read(model: CityModel): { typists: number; raised: Set<string> } {
  let typists = 0;
  const raised = new Set<string>();
  for (const building of model.buildings) {
    for (const desk of building.desks) {
      if (desk.pose === 'type') typists += 1;
      // keyed by building too: two buildings may carry desks with the same id
      if (desk.marker === 'input' || desk.marker === 'permission') raised.add(`${building.id}:${desk.id}`);
    }
  }
  return { typists, raised };
}

/** What to play between two snapshots of the model the page draws. `prev` null = the clip starts. */
export function soundEvents(prev: CityModel | null, next: CityModel): SoundEvent[] {
  const now = read(next);
  if (!prev) return now.typists > 0 ? [{ kind: 'typing', typists: now.typists }] : [];
  const before = read(prev);
  const events: SoundEvent[] = [];
  if (now.typists !== before.typists) events.push({ kind: 'typing', typists: now.typists });
  for (const desk of now.raised) if (!before.raised.has(desk)) events.push({ kind: 'ding', desk });
  return events;
}

/** The visitor's mix: levels from 0 to 1 and equaliser gains in dB. */
export interface SoundMix {
  ambience: number;
  keyboard: number;
  ding: number;
  bass: number;
  mid: number;
  treble: number;
}

export const DEFAULT_MIX: SoundMix = { ambience: 0.7, keyboard: 0.4, ding: 1, bass: 0, mid: 0, treble: 0 };
/** How far each equaliser band goes, up or down, in dB. */
export const EQ_RANGE_DB = 12;
const MIX_KEY = 'termhub.city.sound-mix';

/** Any stored or typed mix, made safe: unknown keys dropped, levels in 0..1, bands in ±EQ_RANGE_DB. */
export function cleanMix(raw: unknown): SoundMix {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (k: keyof SoundMix, lo: number, hi: number) => {
    const v = o[k];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_MIX[k];
  };
  return {
    ambience: num('ambience', 0, 1),
    keyboard: num('keyboard', 0, 1),
    ding: num('ding', 0, 1),
    bass: num('bass', -EQ_RANGE_DB, EQ_RANGE_DB),
    mid: num('mid', -EQ_RANGE_DB, EQ_RANGE_DB),
    treble: num('treble', -EQ_RANGE_DB, EQ_RANGE_DB),
  };
}

export function loadMix(): SoundMix {
  try {
    const raw = localStorage.getItem(MIX_KEY);
    return raw ? cleanMix(JSON.parse(raw)) : { ...DEFAULT_MIX };
  } catch {
    return { ...DEFAULT_MIX };
  }
}

export function saveMix(mix: SoundMix): void {
  try {
    localStorage.setItem(MIX_KEY, JSON.stringify(cleanMix(mix)));
  } catch {
    // private window or storage blocked: the mix lasts as long as the page
  }
}

export interface Soundscape {
  readonly stream: MediaStream;
  play(events: SoundEvent[]): void;
  setMix(mix: SoundMix): void;
  stop(): void;
}

/** Keyboard loops layered at once: one per typing robot, up to this many; more only adds mud. */
export const MAX_LAYERS = 3;
/** How long the keyboard takes to follow a change in the number of typists. */
const FADE_S = 0.25;

/** Gain of each keyboard layer for `typists` robots typing: the layers together stay at one loop's loudness. */
export function layerGains(typists: number): number[] {
  const on = Math.min(Math.max(typists, 0), MAX_LAYERS);
  return Array.from({ length: MAX_LAYERS }, (_, i) => (i < on ? 1 / Math.sqrt(on) : 0));
}

async function load(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio ${res.status}`);
  return ctx.decodeAudioData(await res.arrayBuffer());
}

/**
 * The recordings download and decode after this returns (a recording starts at once); until they
 * do the track is silent, and a typist count played meanwhile is applied when the keyboard arrives.
 * A recording that fails to load is left out rather than failing the video. `speakers`: also play
 * it out loud (the page's sound button), not only into the stream.
 */
export function createSoundscape(ctx: AudioContext, mix: SoundMix = DEFAULT_MIX, opts: { speakers?: boolean } = {}): Soundscape {
  const out = ctx.createMediaStreamDestination();
  // master → bass → mid → treble → out (and the speakers)
  const master = ctx.createGain();
  const bass = ctx.createBiquadFilter();
  bass.type = 'lowshelf';
  bass.frequency.value = 200;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1000;
  mid.Q.value = 0.8;
  const treble = ctx.createBiquadFilter();
  treble.type = 'highshelf';
  treble.frequency.value = 4000;
  master.connect(bass);
  bass.connect(mid);
  mid.connect(treble);
  treble.connect(out);
  if (opts.speakers) treble.connect(ctx.destination);

  const sources: AudioBufferSourceNode[] = [];
  let stopped = false;
  const loop = (buffer: AudioBuffer, gain: GainNode, offset: number, rate = 1) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    src.connect(gain);
    src.start(ctx.currentTime, offset % buffer.duration);
    sources.push(src);
  };

  const ambience = ctx.createGain();
  ambience.connect(master);
  const keyboard = ctx.createGain();
  keyboard.connect(master);
  const dings = ctx.createGain();
  dings.connect(master);

  const setMix = (m: SoundMix) => {
    const c = cleanMix(m);
    const t = ctx.currentTime;
    ambience.gain.setTargetAtTime(c.ambience, t, 0.03);
    keyboard.gain.setTargetAtTime(c.keyboard, t, 0.03);
    dings.gain.setTargetAtTime(c.ding, t, 0.03);
    bass.gain.setTargetAtTime(c.bass, t, 0.03);
    mid.gain.setTargetAtTime(c.mid, t, 0.03);
    treble.gain.setTargetAtTime(c.treble, t, 0.03);
  };
  // the first mix lands at once, not faded in from the nodes' defaults
  const first = cleanMix(mix);
  ambience.gain.value = first.ambience;
  keyboard.gain.value = first.keyboard;
  dings.gain.value = first.ding;
  bass.gain.value = first.bass;
  mid.gain.value = first.mid;
  treble.gain.value = first.treble;

  void load(ctx, ambienceUrl)
    .then((buffer) => !stopped && loop(buffer, ambience, 0))
    .catch(() => {});

  // one gain per layer, all silent until a typist count arrives
  const layers = Array.from({ length: MAX_LAYERS }, () => {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(keyboard);
    return g;
  });
  let typists = 0;
  const applyTypists = () => {
    layerGains(typists).forEach((level, i) => layers[i].gain.setTargetAtTime(level, ctx.currentTime, FADE_S / 3));
  };
  void load(ctx, keyboardUrl)
    .then((buffer) => {
      if (stopped) return;
      // each layer starts at a different point of the loop and a hair off speed, so two robots are
      // two people typing rather than one recording doubled
      layers.forEach((g, i) => loop(buffer, g, (i * buffer.duration) / MAX_LAYERS, 1 + (i - 1) * 0.03));
      applyTypists();
    })
    .catch(() => {});

  const ding = () => {
    const t = ctx.currentTime;
    for (const [freq, level] of [[880, 0.16], [1320, 0.06]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      osc.connect(g);
      g.connect(dings);
      osc.start(t);
      osc.stop(t + 1);
    }
  };

  return {
    stream: out.stream,
    play(events) {
      for (const e of events) {
        if (e.kind === 'typing') {
          typists = e.typists;
          applyTypists();
        } else ding();
      }
    },
    setMix,
    stop() {
      stopped = true;
      for (const src of sources) src.stop();
      master.disconnect();
      treble.disconnect();
    },
  };
}
