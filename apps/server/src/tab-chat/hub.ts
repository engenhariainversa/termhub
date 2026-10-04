import type { EventEmitter } from 'node:events';
import type { TTabChatFrame } from '@termhub/mobile-api';
import type { FastifyBaseLogger } from 'fastify';
import { agents } from '../agent/registry.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { monitorBus, type TabStateChange } from '../monitor/bus.js';
import { availabilityOf, decodeCursor, readForward, type AgentView, type Cursor, type TabChatAvailability } from './reader.js';
import { tabSummaryOf } from './view.js';

/**
 * Who is watching which tab (spec 2026-10-01 tab chat §5.3): one follower per watched tab, created by
 * the first socket and dropped with the last. It reads the transcript forward once when a socket joins,
 * on every hook event of the tab (`poke`), and once a second while the tab works, and sends what is new
 * to its sockets. Items are relayed and forgotten: nothing is kept after a frame is sent, nothing of an
 * item is logged.
 *
 * Every socket keeps its own cursor. Sockets at the same offset share one read; a socket that joined
 * behind the others is read forward from its own cursor until it reaches the end of the file, where it
 * meets them. So a late socket is caught up and no socket ever gets an item twice.
 */

export interface TabChatSubscriber {
  send(frame: TTabChatFrame): void;
}

export type HubRepos = {
  tabs: Pick<Repositories['tabs'], 'findById'>;
  machines: Pick<Repositories['machines'], 'findById'>;
  projects: Pick<Repositories['projects'], 'findById'>;
};

type Read = (machine: Machine, tab: Tab, after: Cursor) => ReturnType<typeof readForward>;

export interface TabChatHubDeps {
  repos: HubRepos;
  log: FastifyBaseLogger;
  read?: Read;
  /** the monitor's fan-out of tab state changes */
  bus?: { subscribe(listener: (change: TabStateChange) => void): () => void };
  agent?: AgentView;
  /** emits `online` (machine id) when an agent connects */
  agentEvents?: Pick<EventEmitter, 'on' | 'off'>;
  tickMs?: number;
}

/** Failed reads in a row after which the ticking stops until the next poke. */
const MAX_FAILURES = 3;
/** Reads in one pass at most, should a file keep growing faster than it is read. */
const MAX_READS_PER_PASS = 50;
/** Forward from past the end of any file: the agent answers with the end of the file and no line. */
const END: number = Number.MAX_SAFE_INTEGER;

interface Sub {
  sub: TabChatSubscriber;
  /** where this socket is in the transcript; null: start at the end of the file */
  cursor: Cursor | null;
}

interface Follower {
  tabId: string;
  subs: Set<Sub>;
  /** the session the follower last read; a different one on the tab row is a `/clear` or a swap */
  session: string | null;
  state: Tab['state'];
  machine: Machine | null;
  project: Project | null;
  reading: boolean;
  again: boolean;
  running: Promise<void> | null;
  failures: number;
  /** the last availability sent in an `unavailable` frame; null while readable */
  unavailable: TabChatAvailability | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  unsubscribeBus: () => void;
  closed: boolean;
}

export class TabChatHub {
  private readonly followers = new Map<string, Follower>();
  private readonly read: Read;
  private readonly agent: AgentView;
  private readonly tickMs: number;
  private readonly onAgentOnline = (machineId: string) => {
    for (const f of this.followers.values()) {
      if (f.machine?.id !== machineId) continue;
      f.failures = 0;
      this.pump(f);
    }
  };

  constructor(private readonly deps: TabChatHubDeps) {
    this.read = deps.read ?? readForward;
    this.agent = deps.agent ?? agents;
    this.tickMs = deps.tickMs ?? 1000;
    (deps.agentEvents ?? agents).on('online', this.onAgentOnline);
  }

  /** Starts following for this subscriber from `after` (null or malformed: from the end of the file). Returns the release. */
  subscribe(tabId: string, after: string | null, sub: TabChatSubscriber): () => void {
    const f = this.followers.get(tabId) ?? this.create(tabId);
    const entry: Sub = { sub, cursor: decodeCursor(after) };
    f.subs.add(entry);
    this.pump(f);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      f.subs.delete(entry);
      if (f.subs.size === 0) this.drop(f);
    };
  }

  /** A hook event of the tab arrived: read now. No follower for the tab: nothing happens. */
  poke(tabId: string): void {
    const f = this.followers.get(tabId);
    if (!f) return;
    f.failures = 0;
    this.pump(f);
  }

  /** Resolves when the tab's read in flight (if any) is done. For tests and the shutdown. */
  async whenIdle(tabId: string): Promise<void> {
    await this.followers.get(tabId)?.running;
  }

  close(): void {
    for (const f of [...this.followers.values()]) this.drop(f);
    (this.deps.agentEvents ?? agents).off('online', this.onAgentOnline);
  }

  private create(tabId: string): Follower {
    const f: Follower = {
      tabId,
      subs: new Set(),
      session: null,
      state: null,
      machine: null,
      project: null,
      reading: false,
      again: false,
      running: null,
      failures: 0,
      unavailable: null,
      timer: undefined,
      unsubscribeBus: () => {},
      closed: false,
    };
    f.unsubscribeBus = (this.deps.bus ?? monitorBus).subscribe((change) => {
      if (change.tab.id !== tabId || f.closed) return;
      f.state = change.tab.state;
      void this.sendState(f, change.tab);
      if (!f.reading && !f.timer) this.schedule(f);
    });
    this.followers.set(tabId, f);
    return f;
  }

  private drop(f: Follower): void {
    f.closed = true;
    clearTimeout(f.timer);
    f.timer = undefined;
    f.unsubscribeBus();
    if (this.followers.get(f.tabId) === f) this.followers.delete(f.tabId);
  }

  /** Reads now, or once more right after the read in flight. */
  private pump(f: Follower): void {
    if (f.closed) return;
    clearTimeout(f.timer);
    f.timer = undefined;
    if (f.reading) {
      f.again = true;
      return;
    }
    f.reading = true;
    f.running = (async () => {
      try {
        do {
          f.again = false;
          await this.pass(f);
        } while (f.again && !f.closed);
      } catch (err) {
        // `pass` handles its own failures; this only keeps a bug from becoming an unhandled rejection.
        this.deps.log.warn({ tabId: f.tabId, err: err instanceof Error ? err.message : String(err) }, 'tab chat: pass failed');
      } finally {
        f.reading = false;
        this.schedule(f);
      }
    })();
  }

  private schedule(f: Follower): void {
    clearTimeout(f.timer);
    f.timer = undefined;
    if (f.closed || f.subs.size === 0 || f.state !== 'working' || f.failures >= MAX_FAILURES) return;
    f.timer = setTimeout(() => {
      f.timer = undefined;
      this.pump(f);
    }, this.tickMs);
    f.timer.unref?.();
  }

  private broadcast(f: Follower, frame: TTabChatFrame): void {
    for (const s of f.subs) this.sendTo(f, s, frame);
  }

  /** A socket that throws on send is the socket's problem (it closes itself); the others still get the frame. */
  private sendTo(f: Follower, s: Sub, frame: TTabChatFrame): void {
    try {
      s.sub.send(frame);
    } catch (err) {
      this.deps.log.debug({ tabId: f.tabId, frame: frame.type, err: err instanceof Error ? err.name : 'unknown' }, 'tab chat: send failed');
    }
  }

  private markUnavailable(f: Follower, availability: TabChatAvailability): void {
    f.failures++;
    if (f.unavailable === availability) return;
    f.unavailable = availability;
    this.broadcast(f, { type: 'unavailable', availability });
  }

  private async sendState(f: Follower, tab: Tab): Promise<void> {
    try {
      f.machine ??= (await this.deps.repos.machines.findById(tab.machine_id)) ?? null;
      f.project ??= (await this.deps.repos.projects.findById(tab.project_id)) ?? null;
      if (!f.machine || !f.project || f.closed) return;
      this.broadcast(f, { type: 'state', tab: tabSummaryOf(tab, f.project, f.machine, availabilityOf(tab, f.machine, this.agent)) });
    } catch (err) {
      this.deps.log.warn({ tabId: f.tabId, err: err instanceof Error ? err.message : String(err) }, 'tab chat: state not sent');
    }
  }

  /** One pass: reload the tab, then read every socket forward to the end of the file. */
  private async pass(f: Follower): Promise<void> {
    let tab: Tab | undefined;
    let machine: Machine | undefined;
    try {
      tab = await this.deps.repos.tabs.findById(f.tabId);
      machine = tab ? await this.deps.repos.machines.findById(tab.machine_id) : undefined;
    } catch (err) {
      f.failures++;
      this.deps.log.warn({ tabId: f.tabId, failures: f.failures, err: err instanceof Error ? err.message : String(err) }, 'tab chat: tab not loaded');
      return;
    }
    if (f.closed) return;
    if (!tab || !machine) {
      f.state = null;
      this.markUnavailable(f, 'no_session');
      return;
    }
    f.state = tab.state;
    f.machine = machine;
    const availability = availabilityOf(tab, machine, this.agent);
    if (availability !== 'ready') {
      this.markUnavailable(f, availability);
      return;
    }
    const session = tab.agent_session_id!;
    // A `/clear` or an account swap since the last read: every socket starts over on the new session.
    if (f.session !== null && f.session !== session) {
      for (const s of f.subs) s.cursor = null;
      this.broadcast(f, { type: 'reset', session_id: session });
      this.deps.log.info({ tabId: f.tabId, subscribers: f.subs.size }, 'tab chat: new session');
    }
    f.session = session;
    // A socket that joined with a cursor of an older session (its page predates a `/clear`).
    for (const s of f.subs) {
      if (s.cursor && s.cursor.session !== session) {
        s.cursor = null;
        this.sendTo(f, s, { type: 'reset', session_id: session });
      }
    }

    try {
      // Sockets with no cursor start at the end: nothing old is sent over the socket (the page has it).
      const fresh = [...f.subs].filter((s) => s.cursor === null);
      const justPlaced = new Set<Sub>();
      if (fresh.length) {
        const end = await this.read(machine, tab, { session, offset: END });
        if (end.missing) return this.markUnavailable(f, 'no_session');
        const cursor = decodeCursor(end.live);
        for (const s of fresh) {
          if (s.cursor !== null) continue;
          s.cursor = cursor;
          justPlaced.add(s);
        }
      }
      for (let reads = 0; reads < MAX_READS_PER_PASS; ) {
        const groups = new Map<number, Sub[]>();
        for (const s of f.subs) {
          if (!s.cursor || justPlaced.has(s)) continue;
          groups.set(s.cursor.offset, [...(groups.get(s.cursor.offset) ?? []), s]);
        }
        justPlaced.clear();
        if (groups.size === 0) break;
        let more = false;
        for (const [offset, members] of groups) {
          reads++;
          const res = await this.read(machine, tab, { session, offset });
          if (res.missing) return this.markUnavailable(f, 'no_session');
          if (res.unknown > 0) this.deps.log.debug({ tabId: f.tabId, known: res.known, unknown: res.unknown }, 'tab chat: lines not understood');
          const cursor = decodeCursor(res.live);
          for (const s of members) {
            if (!f.subs.has(s)) continue;
            s.cursor = cursor;
            if (res.items.length) this.sendTo(f, s, { type: 'items', items: res.items, live: res.live, mode: res.mode });
          }
          more ||= res.more;
        }
        // Every socket reached the end of the file it was reading: the next pass (poke, tick) goes on.
        if (!more && new Set([...f.subs].map((s) => s.cursor?.offset)).size <= 1) break;
      }
    } catch (err) {
      const offline = err instanceof HttpError && (err.statusCode === 503 || err.statusCode === 504);
      const now = availabilityOf(tab, machine, this.agent);
      this.markUnavailable(f, offline || now === 'ready' ? 'offline' : now);
      this.deps.log.warn(
        { tabId: f.tabId, machineId: machine.id, failures: f.failures, code: err instanceof HttpError ? err.code : undefined },
        'tab chat: transcript read failed',
      );
      return;
    }
    // Readable again after an `unavailable`: the summary tells the phone it is back.
    if (f.unavailable !== null) {
      f.unavailable = null;
      await this.sendState(f, tab);
    }
    f.failures = 0;
  }
}
