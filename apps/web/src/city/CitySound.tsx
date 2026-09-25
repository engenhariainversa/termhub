import { useCallback, useEffect, useRef, useState } from 'react';
import type { CityModel } from '../office/model';
import { createSoundscape, DEFAULT_MIX, EQ_RANGE_DB, loadMix, saveMix, soundEvents, type SoundMix, type Soundscape } from './share/sound';

/**
 * The city's sound on the page: off until the visitor turns it on (browsers only start audio from a
 * click), then the same soundscape the videos carry, out loud and following the city as it changes.
 * The mix is the visitor's and is kept in this browser; the videos record with it too.
 */
export function useCitySound(model: CityModel) {
  const [on, setOn] = useState(false);
  const [mix, setMixState] = useState<SoundMix>(loadMix);
  const audio = useRef<{ ctx: AudioContext; sound: Soundscape } | null>(null);
  const heard = useRef<CityModel | null>(null);

  const stop = useCallback(() => {
    audio.current?.sound.stop();
    void audio.current?.ctx.close();
    audio.current = null;
    heard.current = null;
  }, []);

  // called from the click itself: an AudioContext made outside a gesture starts suspended
  const toggle = useCallback(() => {
    if (audio.current) {
      stop();
      setOn(false);
      return;
    }
    try {
      const ctx = new AudioContext();
      audio.current = { ctx, sound: createSoundscape(ctx, loadMix(), { speakers: true }) };
      void ctx.resume();
      setOn(true);
    } catch {
      setOn(false);
    }
  }, [stop]);

  useEffect(() => {
    if (!on || !audio.current) return;
    if (model === heard.current) return;
    audio.current.sound.play(soundEvents(heard.current, model));
    heard.current = model;
  }, [on, model]);

  useEffect(() => stop, [stop]);

  const setMix = useCallback((next: SoundMix) => {
    setMixState(next);
    saveMix(next);
    audio.current?.sound.setMix(next);
  }, []);

  return { on, toggle, mix, setMix };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const db = (v: number) => `${v > 0 ? '+' : ''}${v} dB`;

/** One line that says the whole mix, to read out or paste back ("ambiente 70% · teclado 80% · …"). */
export function describeMix(m: SoundMix): string {
  return `ambiente ${pct(m.ambience)} · teclado ${pct(m.keyboard)} · aviso ${pct(m.ding)} · graves ${db(m.bass)} · médios ${db(m.mid)} · agudos ${db(m.treble)}`;
}

export function SoundPanel({ on, onToggle, mix, onChange, onClose }: { on: boolean; onToggle(): void; mix: SoundMix; onChange(mix: SoundMix): void; onClose(): void }) {
  const level = (key: 'ambience' | 'keyboard' | 'ding', label: string) => (
    <label className="grid grid-cols-[5.5rem_1fr_3rem] items-center gap-2 text-xs text-fg-muted">
      {label}
      <input type="range" min={0} max={100} step={5} value={Math.round(mix[key] * 100)} onChange={(e) => onChange({ ...mix, [key]: Number(e.target.value) / 100 })} />
      <span className="text-right tabular-nums text-fg">{pct(mix[key])}</span>
    </label>
  );
  const band = (key: 'bass' | 'mid' | 'treble', label: string) => (
    <label className="grid grid-cols-[5.5rem_1fr_3rem] items-center gap-2 text-xs text-fg-muted">
      {label}
      <input type="range" min={-EQ_RANGE_DB} max={EQ_RANGE_DB} step={1} value={mix[key]} onChange={(e) => onChange({ ...mix, [key]: Number(e.target.value) })} />
      <span className="text-right tabular-nums text-fg">{db(mix[key])}</span>
    </label>
  );
  return (
    <div role="dialog" aria-label="Som da cidade" className="space-y-3 rounded-b-xl border border-line bg-bg-2 p-4 shadow-xl sm:rounded-lg">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">Som</h2>
        <button type="button" aria-label="Fechar" className="rounded px-2 text-fg-muted hover:text-fg" onClick={onClose}>
          ×
        </button>
      </div>
      <button type="button" onClick={onToggle} aria-pressed={on} className="w-full rounded-md border border-line bg-bg-3 px-3 py-2 text-left text-sm text-fg hover:bg-bg-4">
        {on ? 'Som ligado · desligar' : 'Som desligado · ligar'}
      </button>
      <div className="space-y-2">
        {level('ambience', 'Ambiente')}
        {level('keyboard', 'Teclado')}
        {level('ding', 'Aviso')}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-semibold text-fg-muted">Equalização</p>
        {band('bass', 'Graves')}
        {band('mid', 'Médios')}
        {band('treble', 'Agudos')}
      </div>
      <p className="select-all rounded bg-bg-3 px-2 py-1.5 text-xs text-fg-dim">{describeMix(mix)}</p>
      <div className="flex justify-between gap-2">
        <p className="text-xs text-fg-dim">Os vídeos gravam com esta mixagem.</p>
        <button type="button" className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-fg hover:bg-bg-3" onClick={() => onChange({ ...DEFAULT_MIX })}>
          Restaurar
        </button>
      </div>
    </div>
  );
}
