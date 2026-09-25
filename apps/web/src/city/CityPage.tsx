import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildCityModel, resolveFocus, sameFocus, type CityModel, type FocusTarget } from '../office/model';
import { OfficeScene } from '../office/scene/OfficeScene';
import type { PublicCity } from '../lib/types';
import { fetchCity, openCitySocket, robotsOf, toBuildingEntries, type CityFrame } from './api';
import { BetaCard, LANDING_URL, useBetaCard } from './BetaCard';
import { SoundPanel, useCitySound } from './CitySound';
import { shareInfoFor } from './share/compose';
import { CopyLinkButton } from './share/CopyLinkButton';
import { clock, RecordingFrame, RecordingResult, useScreenRecorder } from './share/ScreenRecorder';
import { SharePanel } from './share/SharePanel';
import { cityPath, restFromUrl, type Rest } from './url';

/** A snapshot that could not be read is tried again, backing off the same way the socket does. */
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

const readRest = (): Rest => restFromUrl(location.pathname);

/**
 * One socket frame, applied where it lands. The building id in it is the snapshot's own, so a
 * change never costs a second read of the city; a frame for a building this page has never seen is
 * dropped, since there is nowhere to draw it.
 */
function applyRobot(city: PublicCity | null, frame: CityFrame): PublicCity | null {
  if (!city) return city;
  let landed = false;
  // tolerant of a snapshot of an unexpected shape, like toBuildingEntries: a frame never throws
  const buildings = (Array.isArray(city.buildings) ? city.buildings : []).map((building) => {
    if (building?.id !== frame.building) return building;
    landed = true;
    // a tab closed or deleted while somebody watches leaves its desk at once
    if (frame.type === 'robot_gone') return { ...building, robots: robotsOf(building).filter((r) => r.id !== frame.robot) };
    const i = robotsOf(building).findIndex((r) => r.id === frame.robot.id);
    const robots = robotsOf(building).slice();
    // a tab opened while somebody is watching joins the building instead of waiting for a reload
    if (i === -1) robots.push(frame.robot);
    else robots[i] = frame.robot;
    return { ...building, robots };
  });
  return landed ? { ...city, buildings } : city;
}

/**
 * The public city: somebody else's account as a city, live, to a visitor with no account at all.
 * Two rests, like the office — the city and one building (a published project) — and nothing else:
 * no sidebar, no actions, no terminal, no machine. The snapshot is read on arrival and every change
 * after it comes down the socket, so a visit costs one read while the channel holds; the snapshot is
 * read again only when that channel is hung up, which is how a building (or a machine's robots)
 * taken off the street disappears without a reload.
 */
export function CityPage({ nickname }: { nickname: string }) {
  const [city, setCity] = useState<PublicCity | null>(null);
  /** the server said there is no such city: a 404 is final, and nothing here knocks again after it */
  const [missing, setMissing] = useState(false);
  const [rest, setRest] = useState<Rest>(readRest);
  // a callback ref, not useRef: the host <div> is absent while the snapshot is on its way, and a
  // ref alone would never re-trigger the mount effect once it finally renders
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [betaOpen, setBetaOpen] = useBetaCard();
  const [shareOpen, setShareOpen] = useState(false);
  const shareButton = useRef<HTMLButtonElement>(null);
  /** the panel closed (its ×, Esc): the focus goes back to the button that opened it */
  const closeShare = useCallback(() => {
    setShareOpen(false);
    shareButton.current?.focus();
  }, []);
  const sceneRef = useRef<OfficeScene | null>(null);

  const gone = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryIn = useRef(RETRY_MIN_MS);

  /**
   * One read of the snapshot: on mount, and again every time the socket is hung up — that is the
   * only way to tell a city taken off the street from a channel that merely dropped. A read that
   * could not be made at all keeps whatever is drawn and comes back, because "we could not read it"
   * is not "it is not there".
   */
  const load = useCallback(async () => {
    if (gone.current) return;
    try {
      const answer = await fetchCity(nickname);
      if (gone.current) return;
      retryIn.current = RETRY_MIN_MS;
      if (answer) setCity(answer);
      else setMissing(true);
    } catch {
      if (gone.current) return;
      retry.current = setTimeout(() => void load(), retryIn.current);
      retryIn.current = Math.min(retryIn.current * 2, RETRY_MAX_MS);
    }
  }, [nickname]);

  useEffect(() => {
    gone.current = false;
    void load();
    return () => {
      gone.current = true;
      if (retry.current) clearTimeout(retry.current);
    };
  }, [load]);

  useEffect(() => {
    // a city that is not there has no channel to watch, and the upgrade would be refused the same
    // 404 over and over: once the snapshot has said so, this page stops knocking for good
    if (missing) return;
    return openCitySocket(nickname, {
      onRobot: (frame) => setCity((prev) => applyRobot(prev, frame)),
      onClosed: () => void load(),
    });
  }, [nickname, missing, load]);

  useEffect(() => {
    const onPop = () => setRest(readRest());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const entries = useMemo(() => (city ? toBuildingEntries(city) : { projects: [], machines: [] }), [city]);
  // no monitor on the street: the socket already wrote every change into `city` above
  const model = useMemo(() => buildCityModel(entries, () => undefined), [entries]);

  // mirrors `model` for the scene-mount effect below: a scene created there must be seeded with
  // whatever is already known, not sit blank waiting for this effect to fire again
  const modelRef = useRef<CityModel>(model);
  useEffect(() => {
    modelRef.current = model;
    sceneRef.current?.setModel(model);
  }, [model]);

  // an unknown building — an old machine id, say — falls back to the city on its own (office/model.ts)
  const target = resolveFocus(model, rest.building ?? undefined);
  // the target is rebuilt on every render, so the scene is only told when it changed BY VALUE:
  // re-framing an equal target would undo a camera the visitor moved by hand
  const targetRef = useRef<FocusTarget>(target);
  useEffect(() => {
    if (sameFocus(target, targetRef.current)) return;
    targetRef.current = target;
    sceneRef.current?.focus(target);
  });

  const go = useCallback(
    (building: string | null, replace = false) => {
      history[replace ? 'replaceState' : 'pushState'](null, '', cityPath(nickname, { building }));
      setRest({ building });
    },
    [nickname],
  );

  /** The ladder Esc and the zoom-out gesture walk: building -> city. Going up replaces, or Back would walk straight back in. */
  const up = () => {
    if (target.kind === 'building') go(null, true);
  };

  // the scene and the key listener call through this ref, re-synced after every render, which is
  // what lets the mount effect below depend on the host element ALONE
  const actions = {
    onPickBuilding: (building: string) => go(building),
    onGoUp: () => up(),
  };
  const handlers = useRef(actions);
  useEffect(() => {
    handlers.current = actions;
  });

  useEffect(() => {
    if (!host) return;
    setFailed(false);
    const scene = new OfficeScene({
      // a desk leads somewhere only for the person who owns it: on the street it is scenery, and
      // this bundle knows no route that could open one
      onPickDesk: () => {},
      onPickBuilding: (building) => handlers.current.onPickBuilding(building),
      // the sign names the building, so it leads into it, like its ground
      onPickSign: (building) => handlers.current.onPickBuilding(building),
      onGoUp: () => handlers.current.onGoUp(),
    });
    sceneRef.current = scene;
    // setModel/focus are safe to call before mount() resolves — the scene replays them once it can draw
    scene.setModel(modelRef.current);
    scene.focus(targetRef.current, true);
    // Pixi falls back from WebGL to canvas by itself; this only fires when neither could start
    scene.mount(host).catch(() => setFailed(true));
    return () => {
      scene.destroy();
      sceneRef.current = null;
    };
  }, [host]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc in the beta form is the person editing a field, not asking the camera to step back
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') handlers.current.onGoUp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sound = useCitySound(model);
  const [soundOpen, setSoundOpen] = useState(false);
  const cityRef = useRef(city);
  cityRef.current = city;
  const recorder = useScreenRecorder({
    scene: () => sceneRef.current,
    nickname,
    info: () => shareInfoFor(cityRef.current!, modelRef.current, `${location.origin}${cityPath(nickname, { building: null })}`),
    model: () => modelRef.current,
  });
  const recordingNow = recorder.state.kind === 'recording';

  if (missing) {
    return (
      // nothing else to show here, so the card is the page: open, and not something to put away
      <div className="flex min-h-full flex-col items-center justify-center gap-4 px-4 py-8 text-center">
        <p className="text-sm text-fg-muted">Cidade não encontrada.</p>
        <div className="w-full max-w-sm">
          <BetaCard ownerName={null} />
        </div>
      </div>
    );
  }

  // the city's own address: the media footers print it when there is no short link
  const cityUrl = `${location.origin}${cityPath(nickname, { building: null })}`;
  // "Copiar link": only the city has a short link; a building keeps its long address
  const restUrl = target.kind === 'city' ? null : `${location.origin}${cityPath(nickname, { building: target.projectId })}`;
  const copyUrl = restUrl ?? city?.short_url ?? cityUrl;
  // media are made from the scene: nothing to share before it has a city to draw
  const canShare = !!city && model.buildings.length > 0;

  // only a building that exists gets a trail: an old link that fell back to the city shows none
  const here = target.kind === 'building' ? (model.buildings.find((b) => b.id === target.projectId) ?? null) : null;
  const trail: Array<{ label: string; go?: () => void }> = [];
  if (here) trail.push({ label: 'Cidade', go: () => go(null, true) }, { label: here.name });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-bg-2 px-3 py-2 text-xs text-fg-muted">
        <span className="text-sm font-semibold text-fg">Cidade de {city?.owner_name ?? '…'}</span>
        <Trail parts={trail} />
        <span className="ml-auto flex items-center gap-3">
          {failed ? (
            <CopyLinkButton url={copyUrl} className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" />
          ) : (
            <button
              ref={shareButton}
              type="button"
              disabled={!canShare}
              aria-expanded={shareOpen}
              onClick={() => setShareOpen((open) => !open)}
              className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              Compartilhar
            </button>
          )}
          {!failed && recorder.supported && (
            <button
              type="button"
              disabled={!canShare && !recordingNow}
              onClick={() => (recordingNow ? recorder.stop() : void recorder.start())}
              className={`inline-flex items-center gap-1.5 rounded px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50 ${recordingNow ? 'bg-danger/15 text-danger hover:bg-danger/25' : 'hover:bg-bg-3 hover:text-fg'}`}
            >
              <span aria-hidden="true" className={recordingNow ? 'h-2 w-2 rounded-[2px] bg-danger' : 'h-2 w-2 rounded-full bg-danger'} />
              {recordingNow ? `Parar ${clock(recorder.state.kind === 'recording' ? recorder.state.elapsedMs : 0)}` : 'Gravar'}
            </button>
          )}
          <button type="button" aria-expanded={soundOpen} onClick={() => setSoundOpen((open) => !open)} className={`rounded px-2 py-1 hover:bg-bg-3 hover:text-fg ${sound.on ? 'text-fg' : ''}`}>
            {sound.on ? 'Som ligado' : 'Som desligado'}
          </button>
          <a className="hidden hover:text-fg sm:inline" href={LANDING_URL}>
            O que é o termhub?
          </a>
          <button
            type="button"
            onClick={() => setBetaOpen(true)}
            aria-expanded={betaOpen}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white shadow-md shadow-accent/30 ring-1 ring-accent/60 transition-colors hover:bg-accent-hover"
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            Participar do beta grátis
          </button>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={setHost} className="absolute inset-0 overflow-hidden" />
        {failed && <Overlay>Seu navegador não conseguiu desenhar a cidade.</Overlay>}
        {!failed && !city && <Overlay>Carregando a cidade…</Overlay>}
        {betaOpen && (
          // a bottom sheet on a phone, a card in the corner from `sm` up; only its own box takes the
          // pointer, so the rest of the scene stays as draggable and clickable as without it
          <div className="absolute inset-x-0 bottom-0 z-10 max-h-[75%] overflow-y-auto sm:bottom-4 sm:left-4 sm:right-auto sm:w-[22rem] sm:max-h-[calc(100%-2rem)]">
            <BetaCard ownerName={city?.owner_name ?? null} onCollapse={() => setBetaOpen(false)} className="rounded-t-xl border-t sm:rounded-lg sm:border" />
          </div>
        )}
        {recordingNow && host && <RecordingFrame host={host} />}
        {soundOpen && (
          <div className="absolute inset-x-0 top-0 z-20 max-h-full overflow-y-auto sm:left-auto sm:right-4 sm:top-4 sm:w-[22rem]">
            <SoundPanel on={sound.on} onToggle={sound.toggle} mix={sound.mix} onChange={sound.setMix} onClose={() => setSoundOpen(false)} />
          </div>
        )}
        {recorder.state.kind === 'done' && (
          <div className="absolute inset-x-0 top-0 z-30 max-h-full overflow-y-auto sm:left-auto sm:right-4 sm:top-4 sm:w-[26rem]">
            <RecordingResult file={recorder.state.file} preview={recorder.state.preview} warn={recorder.state.warn} onClose={recorder.dismiss} />
          </div>
        )}
        {recorder.state.kind === 'failed' && (
          <div className="absolute inset-x-0 top-0 z-30 sm:left-auto sm:right-4 sm:top-4 sm:w-[22rem]">
            <div role="status" className="flex items-center justify-between gap-2 rounded-b-xl border border-line bg-bg-2 p-3 text-sm text-fg-muted shadow-xl sm:rounded-lg">
              Não foi possível gravar a tela.
              <button type="button" className="rounded px-2 text-fg-muted hover:text-fg" aria-label="Fechar" onClick={recorder.dismiss}>
                ×
              </button>
            </div>
          </div>
        )}
        {shareOpen && !failed && canShare && city && sceneRef.current && (
          // full width under the bar on a phone, a card in the top-right corner from `sm` up
          <div className="absolute inset-x-0 top-0 z-20 max-h-full overflow-y-auto sm:left-auto sm:right-4 sm:top-4 sm:w-[22rem]">
            <SharePanel scene={sceneRef.current} city={city} model={model} cityUrl={cityUrl} copyUrl={copyUrl} onClose={closeShare} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Where the camera stands, as the ladder Esc walks: Cidade › projeto. */
function Trail({ parts }: { parts: Array<{ label: string; go?: () => void }> }) {
  return (
    <nav aria-label="Trilha" className="flex items-center gap-1">
      {parts.map((part, i) => (
        <span key={`${i}:${part.label}`} className="flex items-center gap-1">
          {i > 0 && (
            <span aria-hidden="true" className="text-fg-muted/60">
              ›
            </span>
          )}
          {i === parts.length - 1 ? (
            <span className="text-fg">{part.label}</span>
          ) : (
            <button className="rounded px-1 py-0.5 hover:bg-bg-3 hover:text-fg" onClick={part.go}>
              {part.label}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-fg-muted">{children}</div>;
}
