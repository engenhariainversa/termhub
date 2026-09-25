import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SoundPanel, useCitySound } from '../city/CitySound';
import { useAuth } from '../lib/auth';
import { useCityLink } from '../lib/city-link';
import { useFocusMode } from '../lib/focus';
import { useMonitor } from '../lib/monitor';
import { cityLinkFor } from '../lib/public-city';
import type { Project } from '../lib/types';
import { PageHeader } from '../components/PageHeader';
import { buildCityModel, missingTabIds, resolveFocus, sameFocus, type BuildingModel, type CityModel, type FocusTarget } from '../office/model';
import { OfficeScene } from '../office/scene/OfficeScene';
import { useOfficeCity } from '../office/useOfficeCity';

const EMPTY_CITY: CityModel = { buildings: [], needsYou: 0 };

/** The query string without `room` — a key of the office by machine that means nothing any more. */
function withoutRoom(params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.delete('room');
  const query = next.toString();
  return query ? `?${query}` : '';
}

/**
 * The office: the whole account as a city, live, one building per project (city-by-project §3). The
 * URL is the state, and each of its rests is a place the camera stands — /office the city,
 * /office/:projectId a building, ?focus=1 focus mode. Moving between rests only moves the camera:
 * one scene is built per visit and kept, so the canvas never blanks on the way down or up. A machine
 * is a detail of a desk here, never a place.
 */
export function OfficePage() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { can, user, publicCityUrl } = useAuth();
  // the city's short link, when the instance makes one: only the city depth uses it (a building has none)
  const cityLink = useCityLink(!!user?.nickname);
  const { items, tabState, connected } = useMonitor();
  const { focus, setFocus } = useFocusMode();
  const allowed = can('projects', 'read') && can('terminals', 'read');
  const { city: office, failed: readFailed, stale, reload } = useOfficeCity(allowed);
  // a callback ref, not useRef: the host <div> is absent on the first render (loading/permission
  // branches return early below), and a ref alone would never re-trigger the mount effect once it
  // finally renders — which left the scene blank on a direct load or reload of the URL.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const [failed, setFailed] = useState(false);

  // tabState reads a ref (lib/monitor.tsx), so it never changes identity; `items` is what actually
  // changes on a live push — keep it as a dep, or the model stops updating on monitor pushes.
  const city = useMemo(() => (office ? buildCityModel(office, tabState) : EMPTY_CITY), [office, tabState, items]);
  // the same soundscape as the public city: on by default, started by the first gesture on the page
  const sound = useCitySound(city);
  const [soundOpen, setSoundOpen] = useState(false);

  // mirrors `city` for the scene-mount effect below: a scene created there must be seeded with
  // whatever is already known, not sit blank waiting for this effect to fire again.
  const cityRef = useRef<CityModel>(city);
  useEffect(() => {
    cityRef.current = city;
    sceneRef.current?.setModel(city);
  }, [city]);

  // What the URL asks the camera to frame, against what exists: an unknown project (an old machine
  // bookmark too) is the city (office/model.ts), so it can never throw here.
  const target = resolveFocus(city, projectId);
  // mirrors the target; the object is rebuilt on every render, so the scene is only told when the
  // target changed BY VALUE: re-framing an equal target would undo a camera the person moved by hand.
  const targetRef = useRef<FocusTarget>(target);
  useEffect(() => {
    if (sameFocus(target, targetRef.current)) return;
    targetRef.current = target;
    sceneRef.current?.focus(target);
  });

  // Every move keeps the rest of the query string — ?focus=1 above all: a screen left in focus mode
  // must stay in it through a building and the way back up.
  const go = useCallback(
    (id: string | null, replace = false) => navigate(`/office${id ? `/${encodeURIComponent(id)}` : ''}${withoutRoom(params)}`, { replace }),
    [navigate, params],
  );
  const count = city.buildings.length;

  /**
   * The ladder: building -> city -> out of focus mode. Going up replaces, or Back would walk
   * straight back into the building that was just left. With a single project the city rung is
   * skipped: /office would auto-drill straight back into it. `camera` is set only by the scene's
   * own zoom-out gesture: it never takes the last rung — leaving focus mode is a deliberate act (Esc,
   * the "sair do foco" button), not something a zoom gesture should do by itself.
   */
  const up = (opts: { camera?: boolean } = {}) => {
    if (projectId && count > 1) go(null, true);
    else if (!opts.camera && focus) setFocus(false);
  };

  // `navigate` and `useSearchParams` change identity on every move, and so does everything built on
  // them. The scene and the key listener call through this ref, re-synced after every render, which
  // is what lets the scene-mount effect below depend on the host element ALONE.
  const actions = {
    onPickDesk: (tabId: string, pid: string) => window.open(`/projects/${pid}?tab=${tabId}`, '_blank', 'noopener'),
    onPickBuilding: (id: string) => go(id),
    onPickSign: (id: string) => navigate(`/projects/${id}`),
    onGoUp: () => up({ camera: true }),
    onEscape: () => up(),
    toggleFocus: () => setFocus(!focus),
  };
  const handlers = useRef(actions);
  useEffect(() => {
    handlers.current = actions;
  });

  // a tab the monitor knows and the city lacks (opened since the last read): read the city again,
  // fresh, once per newly-missing id that really started a read — a re-read that bounced off one
  // in flight must not be marked "asked", or that tab is stuck until the next minute's read
  const notified = useRef(new Set<string>());
  useEffect(() => {
    const projectOf = (tabId: string) => items.find((i) => i.tab.id === tabId)?.project.id;
    const missing = missingTabIds(office, items.map((i) => i.tab.id), projectOf);
    if (missing.length === 0) return;
    if (missing.some((id) => !notified.current.has(id)) && reload()) for (const id of missing) notified.current.add(id);
  }, [items, office, reload]);

  // Auto-drill: what is not a choice is not asked — /office with a single project IS that building.
  // Only from the city rest, and with one project the ladder never goes back there.
  useEffect(() => {
    if (!projectId && office?.projects.length === 1) go(office.projects[0].project.id, true);
  }, [projectId, office, go]);

  useEffect(() => {
    if (!host) return;
    setFailed(false);
    const scene = new OfficeScene({
      onPickDesk: (tabId, pid) => handlers.current.onPickDesk(tabId, pid),
      onPickBuilding: (id) => handlers.current.onPickBuilding(id),
      onPickSign: (id) => handlers.current.onPickSign(id),
      onGoUp: () => handlers.current.onGoUp(),
    });
    sceneRef.current = scene;
    // setModel/focus are safe to call before mount() resolves — the scene stores them and replays
    // them once it can draw, so a scene created here is never left blank
    scene.setModel(cityRef.current);
    scene.focus(targetRef.current, true);
    // Pixi falls back from WebGL to canvas by itself; this only fires when neither could start
    scene.mount(host).catch(() => setFailed(true));
    return () => {
      scene.destroy();
      sceneRef.current = null;
    };
  }, [host]);

  // Esc walks up the ladder, F toggles focus mode. Subscribed once: what the keys do is read
  // through the same ref the scene's handlers use, so no move re-subscribes this listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // a dialog already handled it — don't also kick out of the building
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.key === 'Escape') handlers.current.onEscape();
      else if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) handlers.current.toggleFocus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!allowed) return <Navigate to="/" replace />;
  if (!office) return <Message>{readFailed ? 'Não foi possível carregar o escritório. Tentando de novo…' : 'Carregando…'}</Message>;
  if (office.projects.length === 0) {
    return (
      <Message>
        Nenhum projeto ainda. <Link className="text-accent hover:underline" to="/">Crie o primeiro</Link> para ver o escritório.
      </Message>
    );
  }
  // an unknown project — a /office/:machineId bookmark of the office by machine, too — is the city
  if (projectId && !office.projects.some((b) => b.project.id === projectId)) return <Navigate to={`/office${withoutRoom(params)}`} replace />;

  // the building the camera is standing at, as the city drew it: null in the city
  const here = target.kind === 'building' ? (city.buildings.find((b) => b.id === target.projectId) ?? null) : null;
  const trail: Array<{ label: string; go?: () => void }> = [];
  if (count > 1) trail.push({ label: 'Cidade', go: () => go(null, true) });
  if (here) trail.push({ label: here.name });
  const shareResult = shareResultFor(target, user?.id, user?.nickname ?? null, publicCityUrl, cityLink.link?.short_url ?? null, office.projects.map((b) => b.project));

  return (
    <div className="flex h-full flex-col">
      {!focus && (
        <PageHeader
          title="Escritório"
          extra={<Trail parts={trail} />}
          actions={
            <span className="flex items-center gap-3 text-xs text-fg-muted">
              <StatusNotices building={here} connected={connected} stale={stale} />
              <ShareButton result={shareResult} />
              <button className={`rounded px-2 py-1 hover:bg-bg-3 hover:text-fg ${sound.on ? 'text-fg' : ''}`} aria-expanded={soundOpen} onClick={() => setSoundOpen((open) => !open)}>
                {sound.on ? 'som ligado' : 'som desligado'}
              </button>
              <button className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => setFocus(true)} title="Modo foco (F)">
                modo foco
              </button>
            </span>
          }
        />
      )}
      <div className="relative min-h-0 flex-1">
        {/* an unlit building is dimmed by the scene itself, so the canvas is never dimmed on top of it */}
        <div ref={setHost} className="absolute inset-0 overflow-hidden" />
        {focus && (
          <div className="absolute right-3 top-3 flex items-center gap-3 rounded bg-bg-2/80 px-2 py-1 text-xs text-fg-muted">
            <StatusNotices building={here} connected={connected} stale={stale} />
            <ShareButton result={shareResult} />
            <button className={`rounded hover:text-fg ${sound.on ? 'text-fg' : ''}`} aria-expanded={soundOpen} onClick={() => setSoundOpen((open) => !open)}>
              {sound.on ? 'som ligado' : 'som desligado'}
            </button>
            <button className="rounded hover:text-fg" onClick={() => setFocus(false)}>
              sair do foco (Esc)
            </button>
          </div>
        )}
        {soundOpen && (
          <div className={`absolute inset-x-0 z-20 max-h-full overflow-y-auto sm:left-auto sm:right-4 sm:w-[22rem] ${focus ? 'top-12' : 'top-0 sm:top-4'}`}>
            <SoundPanel on={sound.on} onToggle={sound.toggle} mix={sound.mix} onChange={sound.setMix} onClose={() => setSoundOpen(false)} videos={false} />
          </div>
        )}
        {failed && <Overlay>Seu navegador não conseguiu desenhar o escritório.</Overlay>}
      </div>
    </div>
  );
}

/**
 * Where the camera stands, as the ladder Esc walks: Cidade › projeto. Every part but the last one
 * goes to that rest, replacing rather than pushing (going up must not pile history up). With a
 * single project there is no city to go back to, so that part is not rendered at all.
 */
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

/**
 * Why the scene may not be telling the truth right now. Rendered in the top bar and, in focus mode
 * (where there is no top bar), in the corner: a second monitor left open all day must never show a
 * frozen picture that looks live. A building's own trouble is only said at its rest — in the city
 * its sign carries the notice.
 */
const TMUX_SILENT = 'sem resposta do tmux: estado pode estar desatualizado';
/** A re-read failed: the city on screen is the last one read, kept rather than blanked. */
const STALE = 'Escritório desatualizado: não foi possível atualizar';

/** The distinct machines of a building's desks that are offline, by name, in desk order. */
function offlineMachines(building: BuildingModel): string[] {
  return [...new Set(building.desks.flatMap((d) => (d.machine && !d.machine.online ? [d.machine.name] : [])))];
}

function StatusNotices({ building, connected, stale }: { building: BuildingModel | null; connected: boolean; stale: boolean }) {
  const offline = building?.notice === 'offline' ? offlineMachines(building) : [];
  // counted in the header, named on hover and for screen readers: the names can be long
  const offlineLabel = offline.length > 1 ? `máquinas offline: ${offline.join(', ')}` : `máquina offline: ${offline.join(', ')}`;
  return (
    <>
      {stale && (
        <span className="flex items-center gap-1 whitespace-nowrap text-warn" role="status" aria-label={STALE} title={STALE}>
          <TriangleAlert size={14} aria-hidden="true" />
          desatualizado
        </span>
      )}
      {building?.notice === 'offline' && (
        <span className="whitespace-nowrap text-warn" aria-label={offlineLabel} title={offlineLabel}>
          {offline.length > 1 ? `${offline.length} máquinas offline` : 'máquina offline'}
        </span>
      )}
      {building?.notice === 'silent' && (
        // compact: the header's actions must fit a narrow window; the whole sentence is on hover and for screen readers
        <span className="flex items-center gap-1 whitespace-nowrap text-warn" role="status" aria-label={TMUX_SILENT} title={TMUX_SILENT}>
          <TriangleAlert size={14} aria-hidden="true" />
          tmux sem resposta
        </span>
      )}
      {!connected && <span className="text-warn">reconectando…</span>}
    </>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-muted">{children}</div>;
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-fg-muted">{children}</div>;
}

/**
 * `unpublished`: nothing in view has been made public (or the viewer has no nickname yet, which can
 * only be true before anything of theirs was ever published). `foreign`: something IS published
 * here, but it is a project somebody else owns (view-as/view-all only) — there is no link this
 * viewer's own nickname could build for it.
 */
type ShareResult = { kind: 'link'; url: string } | { kind: 'unpublished' } | { kind: 'foreign' };

/**
 * The public city a nickname points to is that nickname's OWNER's city: their own published
 * projects, one building each (city-by-project §2.4) — never the signed-in viewer's view. The two
 * only agree while someone looks at their own work; under the view-as/view-all admin scope the
 * office can carry other people's projects, and building the link from the viewer's own nickname
 * would then point at a city that does not contain them. So the check is on the PROJECT's owner.
 * Which machines the agents run on no longer matters: a published project is always on the street.
 */
function shareResultFor(
  target: FocusTarget,
  userId: string | undefined,
  nickname: string | null,
  publicCityUrl: string | null,
  /** the owner's short link (77a.it/…), used at the city depth only */
  shortUrl: string | null,
  projects: Array<Pick<Project, 'id' | 'owner_id' | 'is_public' | 'public_id'>>,
): ShareResult {
  const mine = (p: Pick<Project, 'owner_id'>) => !!userId && p.owner_id === userId;
  const base = cityLinkFor(publicCityUrl, nickname);
  if (target.kind === 'city') {
    if (base && projects.some((p) => p.is_public && mine(p))) return { kind: 'link', url: shortUrl ?? base };
    if (projects.some((p) => p.is_public && !mine(p))) return { kind: 'foreign' };
    return { kind: 'unpublished' };
  }
  const project = projects.find((p) => p.id === target.projectId);
  if (!project?.is_public) return { kind: 'unpublished' };
  if (!mine(project)) return { kind: 'foreign' };
  if (!base) return { kind: 'unpublished' };
  return { kind: 'link', url: `${base}/${encodeURIComponent(project.public_id)}` };
}

type ShareStatus = 'idle' | 'copied' | 'failed';

/**
 * Copies the current rest's public link. When there is nothing to copy, the button explains why
 * instead of pretending there is something to copy — nothing published yet, or something published
 * that belongs to a city this viewer's own nickname cannot address (view-as/view-all).
 */
function ShareButton({ result }: { result: ShareResult }) {
  const [status, setStatus] = useState<ShareStatus>('idle');

  useEffect(() => {
    if (status === 'idle') return;
    const id = setTimeout(() => setStatus('idle'), 2500);
    return () => clearTimeout(id);
  }, [status]);

  if (result.kind === 'unpublished') {
    return (
      <span className="rounded px-2 py-1 text-fg-dim" title="Publique um projeto para gerar o link público">
        nada publicado aqui ainda
      </span>
    );
  }
  if (result.kind === 'foreign') {
    return (
      <span className="rounded px-2 py-1 text-fg-dim" title="Só o dono de um projeto pode compartilhar o link dele">
        pertence a outra pessoa
      </span>
    );
  }

  const link = result.url;
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard API');
      await navigator.clipboard.writeText(link);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <button className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => void copy()} title={link}>
      {status === 'copied' ? 'link copiado' : status === 'failed' ? 'selecione e copie' : 'compartilhar'}
    </button>
  );
}
