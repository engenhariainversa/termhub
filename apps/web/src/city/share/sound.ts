/**
 * The city soundscape (spec 2026-09-23 §2.5): an office ambience under the whole clip, a recorded
 * keyboard that follows the robots typing, and a soft synthesised ding when a robot raises its
 * hand. The recordings are in `./audio` (Pixabay Content License, see its README). It exists only
 * inside a recording: the output goes to a MediaStreamAudioDestinationNode, never to the speakers,
 * so the page itself stays silent.
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

export interface Soundscape {
  readonly stream: MediaStream;
  play(events: SoundEvent[]): void;
  stop(): void;
}

/** Levels of the two recordings in the mix. */
export const AMBIENCE_LEVEL = 0.4;
export const KEYBOARD_LEVEL = 0.8;
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
 * The recordings download and decode after this returns (recording starts at once); until they do
 * the track is silent, and a typist count played meanwhile is applied when the keyboard arrives.
 * A recording that fails to load is left out rather than failing the video.
 */
export function createSoundscape(ctx: AudioContext): Soundscape {
  const out = ctx.createMediaStreamDestination();
  const master = ctx.createGain();
  master.connect(out);
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
  ambience.gain.value = AMBIENCE_LEVEL;
  ambience.connect(master);
  void load(ctx, ambienceUrl)
    .then((buffer) => !stopped && loop(buffer, ambience, 0))
    .catch(() => {});

  const keyboard = ctx.createGain();
  keyboard.gain.value = KEYBOARD_LEVEL;
  keyboard.connect(master);
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
      g.connect(master);
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
    stop() {
      stopped = true;
      for (const src of sources) src.stop();
      master.disconnect();
    },
  };
}
