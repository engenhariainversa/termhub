import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { HISTORY_ROWS, decideWait, rearmOf, type HistoryRow, type Rearm, type SubagentRef } from '../../monitor/wait-decision.js';
import { mapTab, mapTabEvent, type Tab, type TabActivity, type TabEvent, type TabKind, type TabState } from './types.js';

/** A flood of hook events cannot grow the log without bound: only this many are kept per tab. */
const EVENTS_KEPT_PER_TAB = 200;

/** One working interval counts at most this much agent time: bounds a hook that died mid-turn (spec 2026-09-26 progress-panel D2). */
export const MAX_WORKING_INTERVAL_S = 7200;

/** States that mean a tool is mid-task in that tab — as opposed to `idle`, `error` or never seen. */
const BUSY_STATES: TabState[] = ['working', 'waiting_input', 'waiting_permission', 'waiting_background'];

const metaOf = (meta: unknown): Record<string, unknown> => (meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {});

/** The hook event name an event row carries in its meta (`{ event: 'Stop', … }`), or null. */
function eventName(meta: unknown): string | null {
  const name = metaOf(meta).event;
  return typeof name === 'string' && name ? name : null;
}

/** A subagent's event carries `subagent: true` in its meta (monitor/state.ts). */
const isSubagentEvent = (meta: unknown): boolean => metaOf(meta).subagent === true;

/** The subagent an event's meta names (`agent_id` when the hook script sent one), or null for the main thread. */
function subagentOf(meta: unknown): SubagentRef | null {
  if (!isSubagentEvent(meta)) return null;
  const id = metaOf(meta).agent_id;
  return { id: typeof id === 'string' && id ? id : null };
}

/** The final message of the agent's last turn in a tab, as its hooks delivered it (spec 2026-09-30 last
 *  answer). `stale`: a turn started after it, so it is an earlier turn's. */
export interface LastAnswer {
  text: string;
  at: string;
  tool: string;
  stale: boolean;
}

/** A Claude Stop that left background tasks running writes their count in its meta. */
function hasBackgroundTasks(meta: unknown): boolean {
  const count = metaOf(meta).background_tasks;
  return typeof count === 'number' && count > 0;
}

export class TabsRepository {
  constructor(private db: PrismaClient) {}

  async listByProject(projectId: string): Promise<Tab[]> {
    const rows = await this.db.tab.findMany({ where: { projectId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(mapTab);
  }

  /** Every tab of the given projects, in tab-bar order within each project (the office floor). */
  async listByProjects(projectIds: string[]): Promise<Tab[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.db.tab.findMany({ where: { projectId: { in: projectIds } }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(mapTab);
  }

  /** Tabs of one project on one machine (closed when the machine is unlinked). */
  async listByProjectMachine(projectId: string, machineId: string): Promise<Tab[]> {
    const rows = await this.db.tab.findMany({ where: { projectId, machineId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(mapTab);
  }

  /** Every tab of the given projects that runs on this machine (the office floor of one machine). */
  async listByProjectsOnMachine(projectIds: string[], machineId: string): Promise<Tab[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.db.tab.findMany({ where: { projectId: { in: projectIds }, machineId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(mapTab);
  }

  async findById(id: string): Promise<Tab | undefined> {
    const t = await this.db.tab.findUnique({ where: { id } });
    return t ? mapTab(t) : undefined;
  }

  /**
   * Batched by id, one query regardless of how many ids are asked for, filtered to one owner's tabs
   * through their machine — never "no filter": a caller that resolves names for one
   * person's screen (e.g. the chat action trail) must not be able to pass `null` and see everyone's.
   * Another owner's tab id is simply absent from the result, like a row that does not exist. The
   * owner filter is a join condition, not a reason to query per row.
   */
  async findByIdsForOwner(ids: string[], ownerId: string): Promise<Tab[]> {
    if (ids.length === 0) return [];
    return (await this.db.tab.findMany({ where: { id: { in: ids }, machine: { ownerId } } })).map(mapTab);
  }

  /** Tab by tmux session name, restricted to the machine that reported it (session names are unique anyway). */
  async findByTmuxSession(machineId: string, session: string): Promise<Tab | undefined> {
    const t = await this.db.tab.findFirst({ where: { tmuxSession: session, machineId } });
    return t ? mapTab(t) : undefined;
  }

  /** Tabs whose tool reported a state (monitor list). `owner`: only tabs on that user's machines (null = all). */
  async listWithState(owner: string | null = null): Promise<Tab[]> {
    const rows = await this.db.tab.findMany({
      where: { state: { not: null }, ...(owner ? { machine: { ownerId: owner } } : {}) },
      orderBy: [{ stateAt: 'desc' }],
    });
    return rows.map(mapTab);
  }

  /**
   * Every terminal tab on the owner's machines (null = every owner), reported a state or not: the
   * sidebar's "open agents". Scoped like `listWithState`, by the machine the tab runs on.
   */
  async listOpenTerminals(owner: string | null = null): Promise<Tab[]> {
    const rows = await this.db.tab.findMany({
      where: { kind: 'terminal', ...(owner ? { machine: { ownerId: owner } } : {}) },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(mapTab);
  }

  /**
   * Claude Code and Codex tabs left `working` (or `waiting_background`, TER-644) with no hook event since
   * `before` (TER-615), oldest first, at most `limit`: the tabs the monitor looks at again
   * (monitor/stale-working.ts).
   */
  async listStaleWorking(before: Date, limit = 50): Promise<Tab[]> {
    const rows = await this.db.tab.findMany({
      where: { kind: 'terminal', tmuxSession: { not: null }, state: { in: ['working', 'waiting_background'] }, stateTool: { in: ['claude', 'codex'] }, stateAt: { lt: before } },
      orderBy: [{ stateAt: 'asc' }],
      take: limit,
    });
    return rows.map(mapTab);
  }

  /** Every tab on one machine. */
  async listByMachine(machineId: string): Promise<Tab[]> {
    const rows = await this.db.tab.findMany({ where: { machineId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(mapTab);
  }

  /**
   * Per machine: how many terminal tabs exist and how many already reported a state. A tab that
   * never reported one is invisible to the monitor (see `listWithState`), which is what "the
   * machine has tabs but the office/monitor is empty" looks like — the machine list shows both
   * numbers so the person can tell that apart from having no tabs at all.
   */
  async countsByMachine(owner: string | null = null): Promise<Record<string, { tabs: number; reporting: number }>> {
    const rows = await this.db.tab.findMany({
      where: { kind: 'terminal', ...(owner ? { machine: { ownerId: owner } } : {}) },
      select: { state: true, machineId: true },
    });
    const out: Record<string, { tabs: number; reporting: number }> = {};
    for (const row of rows) {
      const counts = (out[row.machineId] ??= { tabs: 0, reporting: 0 });
      counts.tabs += 1;
      if (row.state !== null) counts.reporting += 1;
    }
    return out;
  }

  /**
   * How many tabs of this machine have a tool mid-task. Used before an automatic agent update:
   * an attached terminal is not the only sign of a machine in use — a tool working (or waiting
   * for the person) in a detached tmux session holds no channel open at all.
   */
  async countBusyByMachine(machineId: string): Promise<number> {
    return this.db.tab.count({ where: { state: { in: BUSY_STATES }, machineId } });
  }

  /**
   * Monitor: records the event and makes it the tab's current state; keeps only the newest events
   * per tab. Whether the event alerts is `decideWait`'s call (monitor/wait-decision.ts, spec
   * 2026-09-29), from the tab's row and its last events, read here under the row lock: a wait the
   * person already saw stays seen when the event continues it or brings nothing new. The text
   * follows the same decision: a continuation with no text of its own, or whose own text is only a
   * reminder (`keepsWaitText`), keeps the wait's text.
   *
   * A dropped event (a Cursor session start that arrived after its own prompt, a Codex PostToolUse
   * that trails the Esc which ended its turn) writes no row and changes nothing: `event` is null and
   * the tab is the row as it was.
   *
   * `rearm` is for the log: the wait alerts although the person had seen the one before it and
   * asked for nothing since.
   */
  async recordEvent(
    tabId: string,
    event: {
      kind: TabState;
      tool: string;
      text: string | null;
      meta?: Record<string, unknown>;
      activity?: TabActivity;
      activityVerb?: string | null;
      continuesWait?: boolean;
      keepsWaitText?: boolean;
      /** The whole answer of the turn (monitor/state.ts `Interpreted.answer`), stored apart from the tab. */
      answer?: string;
      /**
       * Only for a state read off the screen (monitor/stale-working.ts): the tab's `state_at` when the
       * screen was captured. The event is dropped unless the tab is still `working` (or
       * `waiting_background`) since then — a hook that landed meanwhile knows better than the capture.
       */
      ifStateAt?: string;
    },
  ): Promise<{ tab: Tab; event: TabEvent | null; rearm: Rearm | null }> {
    const [e, t, rearm] = await this.db.$transaction(async (tx) => {
      // One event per tab at a time: two hooks fired together (PermissionRequest and
      // Notification(permission_prompt)) would otherwise both see the same `working` event as the
      // previous one and credit its interval twice. The second waits here and reads the first's event.
      await tx.$queryRaw`SELECT 1 FROM "tabs" WHERE "id" = ${tabId} FOR UPDATE`;
      // Taken under the lock, not before it: an event that waited here must not write a time older
      // than a look that committed meanwhile (the wait it opens would read as seen), and the rows'
      // `created_at` must follow the order the events were applied in, which the decision reads.
      const at = new Date();
      const current = await tx.tab.findUnique({ where: { id: tabId }, select: { state: true, stateAt: true, stateSeenAt: true, stateText: true, activity: true } });
      const rows = await tx.tabEvent.findMany({ where: { tabId }, orderBy: { createdAt: 'desc' }, take: HISTORY_ROWS, select: { kind: true, createdAt: true, meta: true } });
      const previous = rows[0];
      const history: HistoryRow[] = rows.map((r) => ({ kind: r.kind as TabState, event: eventName(r.meta), ageMs: at.getTime() - r.createdAt.getTime(), backgroundTasks: hasBackgroundTasks(r.meta), subagent: subagentOf(r.meta) }));
      const now = {
        state: (current?.state ?? null) as TabState | null,
        seen: !!current?.stateSeenAt && !!current.stateAt && current.stateSeenAt >= current.stateAt,
        hasActivity: !!current?.activity,
        seenAgeMs: current?.stateSeenAt ? at.getTime() - current.stateSeenAt.getTime() : null,
      };
      const incoming = { kind: event.kind, name: eventName(event.meta), continuesWait: !!event.continuesWait, keepsWaitText: !!event.keepsWaitText, subagent: subagentOf(event.meta) };
      const stillWorking = current?.state === 'working' || current?.state === 'waiting_background';
      const outdated = event.ifStateAt !== undefined && (!stillWorking || current?.stateAt?.toISOString() !== event.ifStateAt);
      const outcome = outdated ? ({ action: 'drop' } as const) : decideWait(now, history, incoming);
      if (outcome.action === 'drop') {
        return [null, await tx.tab.findUniqueOrThrow({ where: { id: tabId } }), null] as const;
      }

      // A working interval ends here: credit it to the card this tab works on (a subtask's parent), once.
      // Time spent waiting on the agent's own background work (TER-644) is that work's time, so it counts.
      if (previous?.kind === 'working' || previous?.kind === 'waiting_background') {
        const seconds = Math.min(MAX_WORKING_INTERVAL_S, Math.round((at.getTime() - previous.createdAt.getTime()) / 1000));
        if (seconds > 0) {
          await tx.$executeRaw`UPDATE "tasks" SET "active_seconds" = "active_seconds" + ${seconds} WHERE "id" IN (SELECT DISTINCT COALESCE("parent_id", "id") FROM "tasks" WHERE "tab_id" = ${tabId})`;
        }
      }
      // A continuation keeps the wait's own text when it has none of its own, or when its own text is
      // never the answer (`keepsWaitText`: Claude's idle_prompt, "Claude is waiting for your input", which
      // must not replace the Stop's last_assistant_message). Any other continuation's text — Cursor's
      // afterAgentResponse — replaces the wait's own, including a stale one from an earlier turn.
      const text = outcome.continuing && (event.text === null || event.keepsWaitText) ? (current?.stateText ?? event.text) : event.text;
      const ev = await tx.tabEvent.create({ data: { id: newId(), tabId, kind: event.kind, tool: event.tool, text: event.text, meta: (event.meta ?? {}) as object, createdAt: at } });
      const updated = await tx.tab.update({
        where: { id: tabId },
        data: {
          state: event.kind,
          stateText: text,
          stateTool: event.tool,
          stateAt: at,
          activity: event.kind === 'working' ? (event.activity ?? null) : null,
          activityVerb: event.kind === 'working' ? (event.activityVerb ?? null) : null,
          ...(outcome.seen === 'none' ? {} : { stateSeenAt: at }),
        },
      });
      // The whole answer, when the event carries one (spec 2026-09-30 last answer): one row per tab,
      // replaced at every turn. An event with none — a reminder, a permission prompt, a tool call —
      // leaves the last one as it is. Never logged.
      if (event.answer !== undefined) {
        await tx.tabLastAnswer.upsert({ where: { tabId }, create: { tabId, text: event.answer, tool: event.tool, at }, update: { text: event.answer, tool: event.tool, at } });
      }
      await tx.$executeRaw`DELETE FROM "tab_events" WHERE "tab_id" = ${tabId} AND "id" NOT IN (SELECT "id" FROM "tab_events" WHERE "tab_id" = ${tabId} ORDER BY "created_at" DESC LIMIT ${EVENTS_KEPT_PER_TAB})`;
      return [ev, updated, rearmOf(now, history, incoming, outcome)] as const;
    });
    return { tab: mapTab(t), event: e ? mapTabEvent(e) : null, rearm };
  }

  async listEvents(tabId: string, limit = 50): Promise<TabEvent[]> {
    const rows = await this.db.tabEvent.findMany({ where: { tabId }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map(mapTabEvent);
  }

  /** Clears the monitor state (e.g. the tmux session is gone). */
  async clearState(tabId: string): Promise<void> {
    await this.db.tab.updateMany({ where: { id: tabId }, data: { state: null, stateText: null, stateTool: null, stateAt: null, stateSeenAt: null, activity: null, activityVerb: null } });
  }

  /**
   * The agent's last whole answer of a tab, or null when none was ever recorded. Read on its own:
   * it is never part of a `Tab` row, which every list carries. `stale` when a working event of the
   * tab is newer than the answer: a turn started since (an Esc, an empty stop, a lost event). A
   * `SessionStart` (Claude's /compact, /clear, a resume) and a subagent's event do not count: the
   * person asked nothing new. The meta is read here, not in the query, so an event without those
   * keys is never lost to JSON-path null semantics; the table keeps at most EVENTS_KEPT_PER_TAB rows.
   * `gte`, not `gt`: an event that carries an answer is never a working one, so a working event in the
   * same millisecond as the answer is a later one and must count.
   */
  async readLastAnswer(tabId: string): Promise<LastAnswer | null> {
    const row = await this.db.tabLastAnswer.findUnique({ where: { tabId } });
    if (!row) return null;
    const newer = await this.db.tabEvent.findMany({ where: { tabId, kind: 'working', createdAt: { gte: row.at } }, select: { meta: true } });
    const stale = newer.some((e) => eventName(e.meta) !== 'SessionStart' && !isSubagentEvent(e.meta));
    return { text: row.text, at: row.at.toISOString(), tool: row.tool, stale };
  }

  /**
   * A tool change on a tab that is already working: the activity (with the spinner verb that came
   * with it, or null) and the time move, nothing else,
   * and no event row is written — an active agent changes tool several times a minute, and the
   * event table is for state changes. `updateMany…AndReturn` so a tab that is gone comes back as
   * `undefined` (like `markSeen`) instead of throwing, still in a single statement.
   *
   * `state: 'working'` is part of the `where`, not a check the caller can make first: the hook
   * script posts in the background, so a `Stop` can commit between the caller's read and this
   * write — and a waiting tab must never read as coding, nor have its `stateAt` pushed past the
   * `stateSeenAt` that says the person already saw it. Nothing updated = it is no longer working.
   */
  async setActivity(tabId: string, activity: TabActivity, verb: string | null): Promise<Tab | undefined> {
    const [t] = await this.db.tab.updateManyAndReturn({ where: { id: tabId, state: 'working' }, data: { activity, activityVerb: verb, stateAt: new Date() } });
    return t ? mapTab(t) : undefined;
  }

  /**
   * Monitor: the tab was just looked at. Writes `stateSeenAt = now` only when the tab is waiting
   * (NEEDS_YOU states — keep in sync with monitor/state.ts) and is not already seen for its current
   * `stateAt`. A conditional `UPDATE` (raw SQL: Prisma's query builder cannot compare two columns)
   * compares the row's *current* `stateAt`, so a hook event that bumps it concurrently is never
   * marked seen by accident. Returns the updated tab when it
   * wrote, `undefined` otherwise (not waiting, already seen, or missing).
   */
  async markSeen(id: string, now = new Date()): Promise<Tab | undefined> {
    const written = await this.db.$executeRaw`
      UPDATE "tabs"
      SET "state_seen_at" = ${now}
      WHERE "id" = ${id}
        AND "state" IN ('waiting_input', 'waiting_permission')
        AND ("state_seen_at" IS NULL OR "state_seen_at" < "state_at")
    `;
    return written > 0 ? this.findById(id) : undefined;
  }

  async create(projectId: string, machineId: string, name: string, opts: { kind?: TabKind; simulator_udid?: string | null; created_by_token_id?: string | null } = {}): Promise<Tab> {
    const id = newId();
    const kind = opts.kind ?? 'terminal';
    const agg = await this.db.tab.aggregate({ where: { projectId }, _max: { position: true } });
    const t = await this.db.tab.create({
      data: {
        id,
        projectId,
        machineId,
        name,
        kind,
        tmuxSession: kind === 'terminal' ? `termhub-${projectId}-${id}` : null,
        simulatorUdid: kind === 'simulator' ? (opts.simulator_udid ?? null) : null,
        createdByTokenId: opts.created_by_token_id ?? null,
        position: (agg._max.position ?? -1) + 1,
      },
    });
    return mapTab(t);
  }

  async update(id: string, patch: { name?: string; simulator_udid?: string | null }): Promise<Tab | undefined> {
    const data: { name?: string; simulatorUdid?: string | null } = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.simulator_udid !== undefined) data.simulatorUdid = patch.simulator_udid;
    const t = await this.db.tab.update({ where: { id }, data });
    return mapTab(t);
  }

  async rename(id: string, name: string): Promise<Tab | undefined> {
    return this.update(id, { name });
  }

  /** Deletes the tab. A tab token dies with its tab (spec 2026-09-27 agent-tab-mcp D6): revoked in
   * the same transaction, so there is no moment where the tab is gone and its token still works. */
  async delete(id: string): Promise<boolean> {
    const [, r] = await this.db.$transaction([
      this.db.apiToken.updateMany({ where: { tabId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.db.tab.deleteMany({ where: { id } }),
    ]);
    return r.count > 0;
  }

  /** Tabs this token opened that still exist — the per-token open-tab limit (spec §4.2). */
  async countOpenByToken(tokenId: string): Promise<number> {
    return this.db.tab.count({ where: { createdByTokenId: tokenId } });
  }

  /**
   * The tab's agent bookkeeping (spec 2026-09-26 account swap): its Claude session and transcript,
   * the account termhub started it with, and when it hit a usage limit. Only the given keys change;
   * a tab that is gone answers undefined.
   */
  async setAgentFields(
    id: string,
    patch: { agent_session_id?: string | null; agent_transcript_path?: string | null; ai_account_id?: string | null; rate_limited_at?: Date | null },
  ): Promise<Tab | undefined> {
    const data = {
      ...(patch.agent_session_id !== undefined ? { agentSessionId: patch.agent_session_id } : {}),
      ...(patch.agent_transcript_path !== undefined ? { agentTranscriptPath: patch.agent_transcript_path } : {}),
      ...(patch.ai_account_id !== undefined ? { aiAccountId: patch.ai_account_id } : {}),
      ...(patch.rate_limited_at !== undefined ? { rateLimitedAt: patch.rate_limited_at } : {}),
    };
    const [t] = await this.db.tab.updateManyAndReturn({ where: { id }, data });
    return t ? mapTab(t) : undefined;
  }
}
