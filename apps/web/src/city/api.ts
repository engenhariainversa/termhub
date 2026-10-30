/**
 * Everything the public city says to the server, and the only thing in this bundle that talks to it:
 * a plain fetch and a plain socket, no session, no credentials, nothing shared with the app's api
 * client. Both surfaces are open to anyone with the link (apps/server/src/routes/public-city.ts).
 */
import type { ModelCity } from '../office/model';
import type { PublicBuilding, PublicCity, PublicRobot } from '../lib/types';
import type { LegalConfig } from './LegalFooter';

/** One change of one robot of a published building, as /ws/public sends it. `building` is a snapshot id: they join. */
export interface RobotFrame {
  type: 'robot';
  building: string;
  robot: PublicRobot;
}

/** A tab of a published building was closed or deleted: its robot leaves. `robot` is the robot's id. */
export interface RobotGoneFrame {
  type: 'robot_gone';
  building: string;
  robot: string;
}

/** Everything /ws/public sends. */
export type CityFrame = RobotFrame | RobotGoneFrame;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * The snapshot, or null when there is no such city. A nickname nobody took and one whose owner
 * published nothing answer the same 404 on purpose, so there is nothing here to tell apart — but
 * "we could not read it right now" is a different answer and throws instead, because drawing it as
 * "this city does not exist" would be a lie the visitor could not get out of. `credentials: 'omit'`
 * so that nothing of a visitor who happens to have a session is ever attached to a public read.
 */
export async function fetchCity(nickname: string): Promise<PublicCity | null> {
  const r = await fetch(`/api/public/city/${encodeURIComponent(nickname)}`, { credentials: 'omit' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`public city: ${r.status}`);
  return (await r.json()) as PublicCity;
}

let legal: Promise<LegalConfig | null> | null = null;

/**
 * This instance's legal footer (terms, policy, operator) for the beta sign-up, read once per page.
 * Best effort: a failed read shows no footer rather than an error, and is tried again next time.
 */
export function fetchLegal(): Promise<LegalConfig | null> {
  legal ??= fetch('/api/public/legal', { credentials: 'omit' })
    .then((r) => (r.ok ? (r.json() as Promise<LegalConfig>) : null))
    .catch(() => null)
    .then((v) => {
      if (!v) legal = null;
      return v;
    });
  return legal;
}

/**
 * The live channel, reconnecting on close with a backoff that doubles up to 30 s. `onClosed` fires
 * on every close the page did not ask for: the server hangs this socket up whenever something it
 * showed leaves the street, and a reconnect refused at the upgrade looks exactly the same from
 * here — only a fresh read of the snapshot can tell the two apart, so that is the caller's job.
 * Returns the close.
 */
export function openCitySocket(nickname: string, handlers: { onRobot: (frame: CityFrame) => void; onClosed: () => void }): () => void {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wait = RECONNECT_MIN_MS;
  let stopped = false;
  const open = () => {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/public/${encodeURIComponent(nickname)}`);
    ws.onopen = () => {
      wait = RECONNECT_MIN_MS;
    };
    ws.onmessage = (ev) => {
      let frame: CityFrame;
      try {
        frame = JSON.parse(String(ev.data)) as CityFrame;
      } catch {
        return;
      }
      if (frame?.type === 'robot' && frame.robot) handlers.onRobot(frame);
      else if (frame?.type === 'robot_gone' && typeof frame.robot === 'string') handlers.onRobot(frame);
    };
    ws.onclose = () => {
      ws = null;
      if (stopped) return;
      timer = setTimeout(open, wait);
      wait = Math.min(wait * 2, RECONNECT_MAX_MS);
      handlers.onClosed();
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

/**
 * The public payload as the office model's input. The server mirrors the office's field names
 * (apps/server/src/public/city.ts), so from here on the model, the scene, the overlay and the
 * activity label are the very code the app runs. Nothing here is a machine: the public shape has
 * none, so the model gets none — every desk reads as online and reachable, and none carries a
 * machine line.
 */
export function toBuildingEntries(city: PublicCity): ModelCity {
  // a payload of a shape this bundle does not know (a deploy in between) reads as an empty street
  // rather than throwing: missing arrays are empty, and what is not a building is left out
  const buildings = (Array.isArray(city?.buildings) ? city.buildings : []).filter((b): b is PublicBuilding => !!b && typeof b === 'object' && typeof b.id === 'string');
  return {
    machines: [],
    projects: buildings.map((building) => ({
      project: { id: building.id, name: building.name, status: 'active' as const },
      // the board is not published: a building sign on the street carries a name, never a task count
      tasks: null,
      tabs: robotsOf(building).map((robot, i) => ({
        id: robot.id,
        project_id: building.id,
        name: robot.name,
        kind: robot.kind,
        // the payload keeps the server's order and nothing else orders the desks
        position: i,
        state: robot.state,
        // the tool's own message and the tool's name are not published
        state_text: null,
        state_tool: null,
        state_at: robot.state_at,
        // whether the owner has looked is the owner's business: on the street a raised hand stays raised
        state_seen_at: null,
        activity: robot.activity,
        activity_verb: robot.activity_verb,
        alive: robot.alive,
        progress: robot.progress,
      })),
    })),
  };
}

/** A building's robots, or none when the payload has no array there (see toBuildingEntries). */
export function robotsOf(building: PublicBuilding): PublicRobot[] {
  return Array.isArray(building.robots) ? building.robots : [];
}
