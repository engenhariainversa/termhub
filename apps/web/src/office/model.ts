/**
 * City read + live monitor state -> what the scene draws. Pure, and the only place where a tab's
 * fields are turned into poses and markers: the scene never reads a `Tab`. A building is a project
 * (city-by-project §3.1); the machine a desk runs on is a detail of that desk.
 */
import { tabNeedsYou } from '../lib/needs-you';
import type { OfficeTab, OfficeTaskCounts, Project, Tab, TabActivity, TabState } from '../lib/types';

/**
 * What the model reads of a tab, and nothing more. `OfficeTab` satisfies it, and so does a robot of
 * the public city once src/city/api.ts adapts it — one model, one scene, both the office and the
 * page a stranger opens. A robot has no machine (the public payload carries none) and its bar has
 * no title (a task's name is not published).
 */
export type ModelTab = Pick<OfficeTab, 'id' | 'project_id' | 'name' | 'kind' | 'position' | 'state' | 'state_text' | 'state_tool' | 'state_at' | 'state_seen_at' | 'activity' | 'activity_verb' | 'alive'> & {
  /** the machine the tab runs on; absent on the public city */
  machine_id?: string;
  progress: { done: number; total: number; title?: string | null } | null;
};

/** One project and its desks, as the model reads it. `OfficeBuilding` satisfies it. */
export interface ModelBuilding {
  project: Pick<Project, 'id' | 'name' | 'status'>;
  tabs: ModelTab[];
  /** null when the board could not be read (no `tasks:read`, or a city with no board at all) */
  tasks: OfficeTaskCounts | null;
}

/** A machine a desk runs on. `OfficeMachine` satisfies it; the public city has none. */
export interface ModelMachine {
  id: string;
  name: string;
  subtitle: string | null;
  online: boolean;
  /** false = its tmux could not be asked; null = not probed */
  reachable: boolean | null;
}

/** The model's whole input: `OfficeCity` satisfies it, and so does the public city through its adapter. */
export interface ModelCity {
  projects: ModelBuilding[];
  machines: ModelMachine[];
}

export type Pose = 'type' | 'raise' | 'sleep' | 'shake' | 'sit' | 'empty';
export type Marker = 'input' | 'permission' | 'error' | null;

/** The machine tag of a desk: what the office tells about where an agent runs. */
export interface DeskMachine {
  name: string;
  subtitle: string | null;
  online: boolean;
}

export interface DeskModel {
  id: string;
  projectId: string;
  /** full tab name (hover) */
  name: string;
  /** what is drawn under the desk */
  label: string;
  kind: 'person' | 'phone';
  pose: Pose;
  marker: Marker;
  /** never reported a state, or its machine is offline or unreachable: drawn faded */
  dimmed: boolean;
  screenOn: boolean;
  state: TabState | null;
  /** what the tool is about to do, under the person while typing; null off `working` or an old agent */
  activity: TabActivity | null;
  /** Claude Code's spinner verb ("Moonwalking"), shown with the activity; null whenever `activity` is */
  verb: string | null;
  /** total = 0: a bound task with no subtasks — a title, no bar */
  progress: { done: number; total: number; title: string } | null;
  /** stable appearance variant, from the tab id */
  look: number;
  /** the machine the desk runs on — office only; null on the public city, which names no machine */
  machine: DeskMachine | null;
}

/** Why a building may not be telling the truth, read from across the city. */
export type BuildingNotice = 'offline' | 'silent' | null;

export interface BuildingModel {
  /** the project id in the office; the building's public id on the street */
  id: string;
  name: string;
  label: string;
  /** someone is at a desk, or someone needs you: an empty or deserted building is drawn dark */
  lit: boolean;
  notice: BuildingNotice;
  needsYou: number;
  /** the board, as the sign prints it (d/t tarefas); null when it is empty or unreadable */
  progress: { done: number; total: number } | null;
  desks: DeskModel[];
}

export interface CityModel {
  buildings: BuildingModel[];
  needsYou: number;
}

export const LOOK_VARIANTS = 6;
const DESK_LABEL_MAX = 18;
const BUILDING_LABEL_MAX = 28;
/** The desk's machine line: name and subtitle together stay this short, or the subtitle goes. */
export const SUBTITLE_CAP = 30;

const POSE: Record<TabState, Pose> = { working: 'type', waiting_input: 'raise', waiting_permission: 'raise', idle: 'sleep', error: 'shake' };

const ACTIVITY_LABEL: Record<TabActivity, string> = { coding: 'codando', reading: 'lendo arquivos', researching: 'pesquisando', planning: 'planejando', terminal: 'no terminal', working: 'trabalhando' };
/** What a working person is doing, under them on the floor — pt-BR, or null when nothing is known. */
export function activityLabel(activity: TabActivity | null): string | null {
  return activity ? ACTIVITY_LABEL[activity] : null;
}

/** A verb and an activity label side by side stay about as wide as the longest desk label plus a word. */
const WORKING_LABEL_MAX = 28;
/**
 * The label under a working person: "Moonwalking… · codando" with a spinner verb (cut to fit, so a
 * customised 24-letter verb cannot run over the next desk), the activity alone without one.
 */
export function workingLabel(activity: TabActivity | null, verb: string | null): string | null {
  const label = activityLabel(activity);
  if (!verb) return label;
  return truncateLabel(label ? `${verb}… · ${label}` : `${verb}…`, WORKING_LABEL_MAX);
}

/** Collapses whitespace and cuts by code point (never inside an emoji), ending in an ellipsis. */
export function truncateLabel(text: string, max: number): string {
  const chars = Array.from(text.trim().replace(/\s+/g, ' '));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

/** FNV-1a over a string, as an unsigned 32-bit number: the same id always hashes the same. */
export function fnv1a(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The same tab is always the same person. */
export function lookOf(id: string, variants: number): number {
  return fnv1a(id) % variants;
}

const oneLine = (s: string) => s.trim().replace(/\s+/g, ' ');

/**
 * The muted line under a desk's name in the office (spec §3.2): the machine's name, with its
 * subtitle when the two fit SUBTITLE_CAP, or "offline" in the subtitle's place when the machine is;
 * '' without a machine — the public city, which names none.
 */
export function deskMachineLine(machine: DeskMachine | null): string {
  if (!machine) return '';
  const name = oneLine(machine.name);
  if (!machine.online) return `${truncateLabel(name, SUBTITLE_CAP - ' · offline'.length)} · offline`;
  const subtitle = machine.subtitle ? oneLine(machine.subtitle) : '';
  const both = subtitle ? `${name} · ${subtitle}` : '';
  return both && Array.from(both).length <= SUBTITLE_CAP ? both : truncateLabel(name, SUBTITLE_CAP);
}

const time = (iso: string | null): number | null => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Which side's state fields to draw. The monitor is normally ahead of the city read, but with the
 * WebSocket down its items go stale (it resyncs every 3 min) while a 60 s read keeps coming — so the
 * newer `state_at` wins, and on a tie only a fresher `state_seen_at` (the hand was lowered
 * elsewhere) moves the tab.
 */
function withLiveState(tab: ModelTab, live: Tab | undefined): ModelTab {
  if (!live) return tab;
  const fromLive = (): ModelTab => ({ ...tab, state: live.state, state_text: live.state_text, state_tool: live.state_tool, state_at: live.state_at, state_seen_at: live.state_seen_at, activity: live.activity, activity_verb: live.activity_verb });
  const liveAt = time(live.state_at);
  const tabAt = time(tab.state_at);
  if (liveAt !== tabAt) return (liveAt ?? -Infinity) > (tabAt ?? -Infinity) ? fromLive() : tab;
  return (time(live.state_seen_at) ?? -Infinity) > (time(tab.state_seen_at) ?? -Infinity) ? fromLive() : tab;
}

/** `machine`: where the tab runs; undefined on the public city, which reads as online and reachable. */
function deskOf(tab: ModelTab, live: Tab | undefined, machine: ModelMachine | undefined): DeskModel {
  const t = withLiveState(tab, live);
  // a machine that could not be asked answers `alive: false` for every terminal tab, which is not
  // evidence that anyone left: keep the last known state (and its raised hand), faded
  const reachable = machine?.reachable !== false;
  const down = !!machine && (!machine.online || machine.reachable === false);
  const base = {
    id: t.id,
    projectId: t.project_id,
    name: t.name,
    label: truncateLabel(t.name, DESK_LABEL_MAX),
    look: lookOf(t.id, LOOK_VARIANTS),
    progress: t.progress ? { done: t.progress.done, total: t.progress.total, title: t.progress.title ?? '' } : null,
    machine: machine ? { name: machine.name, subtitle: machine.subtitle, online: machine.online } : null,
  };
  // a simulator's `alive` comes from the simulator manager, so tmux being unreachable says nothing about it
  if (t.kind === 'simulator') return { ...base, kind: 'phone', pose: 'empty', marker: null, dimmed: down, screenOn: t.alive, state: null, activity: null, verb: null };
  if (!t.alive && reachable) return { ...base, kind: 'person', pose: 'empty', marker: null, dimmed: down, screenOn: false, state: t.state, activity: null, verb: null };
  const needs = tabNeedsYou(t);
  const marker: Marker = t.state === 'error' ? 'error' : !needs ? null : t.state === 'waiting_permission' ? 'permission' : 'input';
  return { ...base, kind: 'person', pose: t.state ? POSE[t.state] : 'sit', marker, dimmed: !t.state || down, screenOn: t.state === 'working', state: t.state, activity: t.state === 'working' ? t.activity : null, verb: t.state === 'working' ? t.activity_verb : null };
}

function buildingOf(b: ModelBuilding, machines: Map<string, ModelMachine>, liveTab: (tabId: string) => Tab | undefined): BuildingModel {
  const machineOf = (t: ModelTab) => (t.machine_id ? machines.get(t.machine_id) : undefined);
  const desks = [...b.tabs].sort((x, y) => x.position - y.position).map((t) => deskOf(t, liveTab(t.id), machineOf(t)));
  const needsYou = desks.filter((d) => d.marker === 'input' || d.marker === 'permission').length;
  const used = [...new Set(b.tabs.map(machineOf).filter((m): m is ModelMachine => !!m))];
  const notice: BuildingNotice = used.length > 0 && used.every((m) => !m.online) ? 'offline' : used.some((m) => m.reachable === false) ? 'silent' : null;
  const total = b.tasks ? b.tasks.todo + b.tasks.doing + b.tasks.done : 0;
  return {
    id: b.project.id,
    name: b.project.name,
    label: truncateLabel(b.project.name, BUILDING_LABEL_MAX),
    lit: b.tabs.some((t) => t.alive) || needsYou > 0,
    notice,
    needsYou,
    progress: b.tasks && total > 0 ? { done: b.tasks.done, total } : null,
    desks,
  };
}

/** One building per project, in the order given (the server's: by name, like the sidebar), empty ones kept. */
export function buildCityModel(city: ModelCity, liveTab: (tabId: string) => Tab | undefined): CityModel {
  const machines = new Map(city.machines.map((m) => [m.id, m]));
  const buildings = city.projects.map((b) => buildingOf(b, machines, liveTab));
  return { buildings, needsYou: buildings.reduce((n, b) => n + b.needsYou, 0) };
}

/** Ids the monitor knows for one of the city's projects that the city itself lacks: time to re-read it. */
export function missingTabIds(city: ModelCity | null, monitorTabIds: string[], projectOf: (tabId: string) => string | undefined): string[] {
  if (!city) return [];
  const projects = new Set(city.projects.map((b) => b.project.id));
  const known = new Set(city.projects.flatMap((b) => b.tabs.map((t) => t.id)));
  return monitorTabIds.filter((id) => !known.has(id) && projects.has(projectOf(id) ?? ''));
}

export type FocusTarget = { kind: 'city' } | { kind: 'building'; projectId: string };

/** What the URL asks the camera to frame, against what exists: an unknown id (an old machine id, too) is the city. */
export function resolveFocus(city: CityModel | null, projectId: string | undefined): FocusTarget {
  return projectId && city?.buildings.some((b) => b.id === projectId) ? { kind: 'building', projectId } : { kind: 'city' };
}

export function sameFocus(a: FocusTarget, b: FocusTarget): boolean {
  return a.kind === 'city' ? b.kind === 'city' : b.kind === 'building' && a.projectId === b.projectId;
}
