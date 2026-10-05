import type { FastifyBaseLogger } from 'fastify';
import { agents } from '../agent/registry.js';
import type { ControlContext } from '../control/context.js';
import type { Repositories, UsageCursor, UsageSum, UsageTokens } from '../db/repositories/index.js';
import { ACTIVE_RUN_STATUSES, type AutomationRun } from '../db/repositories/automation-runs.js';
import type { Tab } from '../db/repositories/types.js';
import { availabilityOf, READ_MAX_BYTES, type AgentView, type Rpc } from '../tab-chat/reader.js';
import { agentRpc } from '../agent/errors.js';
import { costOf } from './prices.js';

/**
 * Tokens and an API-equivalent cost per tab, card, epic and account (agentic board, spec D23, preflight
 * F-29). On each main-thread Stop of an automatic Claude tab, the new lines of its transcript are read
 * through the agent's `transcript.read` (only `assistant` lines, strings cut short), their `message.usage`
 * is summed and only the counts and the new byte offset are stored. The lines are dropped right here and
 * never logged.
 *
 * Only tabs an automation run started, while the run owns them, are read (impact on other users): reading every Claude tab's
 * transcript on every Stop would add an agent RPC per turn for everyone, and the cost is shown on the
 * automatic work's screens only.
 */

export interface UsageDeps {
  repos: {
    tabUsage: Pick<Repositories['tabUsage'], 'cursor' | 'record' | 'ownerTimeZone' | 'noteUnmetered'>;
    automationRuns: Pick<Repositories['automationRuns'], 'latestByTab'>;
    machines: Pick<Repositories['machines'], 'findById'>;
  };
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'debug'>;
  rpc?: Rpc;
  agents?: AgentView;
  now?: () => Date;
}

/**
 * Dedupe by message id is per pass: a message whose lines straddle two passes (a pass stops after
 * MAX_PAGES) or that Claude Code copied into a new session file would be counted twice. Rare, and the number
 * is an estimate.
 */
/** Strings of a usage line are never needed: the agent cuts them to the smallest it allows. */
const MAX_STRING = 256;
/** Pages read in one pass (×256 KB); the rest is read at the next Stop. */
const MAX_PAGES = 16;

const defaultRpc: Rpc = (machine, params) => agentRpc(machine, 'transcript.read', params);

const empty = (): UsageTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export interface TranscriptUsage {
  byModel: Map<string, UsageTokens>;
  lastModel: string | null;
}

/**
 * Sums the `message.usage` of transcript lines per model. Claude Code writes one line per content block of a
 * response, each with the response's usage, so a message id counts once (its largest counts: the output
 * grows while it streams). `<synthetic>` messages (Claude Code's own) and odd shapes are skipped.
 */
export function sumTranscriptUsage(lines: string[]): TranscriptUsage {
  const messages = new Map<string, { model: string; tokens: UsageTokens }>();
  let anonymous = 0;
  for (const raw of lines) {
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    const msg = (o as { type?: unknown; message?: unknown })?.type === 'assistant' ? (o as { message?: unknown }).message : null;
    if (!msg || typeof msg !== 'object') continue;
    const { id, model, usage } = msg as { id?: unknown; model?: unknown; usage?: unknown };
    if (typeof model !== 'string' || model.startsWith('<') || !usage || typeof usage !== 'object') continue;
    const u = usage as Record<string, unknown>;
    const tokens = { input: count(u.input_tokens), output: count(u.output_tokens), cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens) };
    const key = typeof id === 'string' && id ? id : `#${anonymous++}`;
    const seen = messages.get(key);
    if (seen) {
      seen.tokens = {
        input: Math.max(seen.tokens.input, tokens.input),
        output: Math.max(seen.tokens.output, tokens.output),
        cacheRead: Math.max(seen.tokens.cacheRead, tokens.cacheRead),
        cacheWrite: Math.max(seen.tokens.cacheWrite, tokens.cacheWrite),
      };
      // re-inserted so the last model is the one of the last line read
      messages.delete(key);
      messages.set(key, seen);
    } else messages.set(key, { model, tokens });
  }
  const byModel = new Map<string, UsageTokens>();
  let lastModel: string | null = null;
  for (const { model, tokens } of messages.values()) {
    const sum = byModel.get(model) ?? empty();
    sum.input += tokens.input;
    sum.output += tokens.output;
    sum.cacheRead += tokens.cacheRead;
    sum.cacheWrite += tokens.cacheWrite;
    byModel.set(model, sum);
    lastModel = model;
  }
  return { byModel, lastModel };
}

/** `YYYY-MM-DD` of `at` in the IANA `zone`; UTC when the zone is unknown or invalid. */
export function dayIn(zone: string | null, at: Date): string {
  if (zone) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    } catch {
      // an invalid zone: UTC below
    }
  }
  return at.toISOString().slice(0, 10);
}

/**
 * How long after its run ended a tab is still the run's: the Stop that ends a run can be read after the run
 * was marked done. Past it, a person who keeps using the tab by hand is not metered against the card.
 */
export const RUN_END_GRACE_MS = 10 * 60_000;

/** Whether the tab's tokens are the automatic work's: its run is active, or ended moments ago. */
export function runOwnsTab(run: Pick<AutomationRun, 'status' | 'ended_at'>, now: Date): boolean {
  if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) return true;
  return run.ended_at !== null && now.getTime() - run.ended_at.getTime() <= RUN_END_GRACE_MS;
}

/** One pass per tab at a time in this process; the repository's cursor check covers the other colour. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Meters the transcript lines a tab wrote since its last pass. Never throws: a failure only logs metadata,
 * and the same bytes are read again at the next Stop (the cursor did not move).
 */
export function meterTab(deps: UsageDeps, tab: Tab): Promise<void> {
  const previous = inFlight.get(tab.id) ?? Promise.resolve();
  const next = previous.then(() => meterOnce(deps, tab));
  inFlight.set(tab.id, next);
  void next.finally(() => {
    if (inFlight.get(tab.id) === next) inFlight.delete(tab.id);
  });
  return next;
}

async function meterOnce(deps: UsageDeps, tab: Tab): Promise<void> {
  try {
    const codex = tab.state_tool === 'codex';
    if (tab.state_tool && tab.state_tool !== 'claude' && !codex) return;
    if (!codex && (!tab.agent_session_id || !tab.agent_transcript_path)) return;
    const now = (deps.now ?? (() => new Date()))();
    const run = await deps.repos.automationRuns.latestByTab(tab.id);
    if (!run || !runOwnsTab(run, now)) return;
    // A Codex tab has no transcript to read (spec D23): its card shows "—", from a row with no counts.
    if (codex) {
      const day = dayIn(await deps.repos.tabUsage.ownerTimeZone(tab.project_id), now);
      await deps.repos.tabUsage.noteUnmetered({ tab_id: tab.id, project_id: tab.project_id, task_id: run.task_id, account_id: tab.ai_account_id ?? run.account_id, day });
      return;
    }
    const session = tab.agent_session_id;
    const transcriptPath = tab.agent_transcript_path;
    if (!session || !transcriptPath) return;
    const machine = await deps.repos.machines.findById(tab.machine_id);
    if (!machine || availabilityOf(tab, machine, deps.agents ?? agents) !== 'ready') return;

    const from: UsageCursor | null = await deps.repos.tabUsage.cursor(tab.id);
    const start = from && from.session_id === session ? from.offset : 0;
    const rpc = deps.rpc ?? defaultRpc;
    let offset = start;
    const lines: string[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await rpc(machine, {
        transcript_path: transcriptPath,
        session_id: session,
        direction: 'forward',
        offset,
        max_bytes: READ_MAX_BYTES,
        types: ['assistant'],
        max_string: MAX_STRING,
      });
      if (res.status === 'missing') return;
      lines.push(...res.lines);
      if (res.end <= offset) break;
      offset = res.end;
      if (offset >= res.size) break;
    }
    if (from && from.session_id === session && offset === start) return;

    const { byModel, lastModel } = sumTranscriptUsage(lines);
    lines.length = 0;
    const tokens = empty();
    let cost: number | null = null;
    for (const [model, t] of byModel) {
      tokens.input += t.input;
      tokens.output += t.output;
      tokens.cacheRead += t.cacheRead;
      tokens.cacheWrite += t.cacheWrite;
      const c = costOf(model, t);
      if (c !== null) cost = (cost ?? 0) + c;
    }
    const day = dayIn(await deps.repos.tabUsage.ownerTimeZone(tab.project_id), now);
    const written = await deps.repos.tabUsage.record({
      tab_id: tab.id,
      project_id: tab.project_id,
      task_id: run.task_id,
      account_id: tab.ai_account_id ?? run.account_id,
      day,
      model: lastModel,
      from,
      to: { session_id: session, offset },
      tokens,
      cost_usd: cost,
    });
    deps.log.debug({ tabId: tab.id, machineId: machine.id, runId: run.id, bytes: offset - start, ...tokens, written }, 'automation: tab usage metered');
  } catch (err) {
    deps.log.warn({ tabId: tab.id, err: err instanceof Error ? err.name : 'unknown' }, 'automation: tab usage failed');
  }
}

/** Counts and cost of a card, an epic, an account or the project. `cost_usd` null: nothing priced. */
export interface UsageLine {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
}

export interface ProjectUsage {
  from: string | null;
  to: string | null;
  total: UsageLine;
  /** per card (an epic's own rows are its integrator's) */
  cards: Array<UsageLine & { task_id: string; ref: string }>;
  /** an epic's own rows plus those of its cards */
  epics: Array<UsageLine & { epic_id: string; ref: string }>;
  accounts: Array<UsageLine & { account_id: string; label: string | null }>;
}

const zeroLine = (): UsageLine => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null });

function add(into: UsageLine, s: UsageSum): void {
  into.input_tokens += s.tokens.input;
  into.output_tokens += s.tokens.output;
  into.cache_read_tokens += s.tokens.cacheRead;
  into.cache_write_tokens += s.tokens.cacheWrite;
  if (s.cost_usd !== null) into.cost_usd = (into.cost_usd ?? 0) + s.cost_usd;
}

/** A project's usage per card, epic and account, from `from` to `to` (inclusive days; open when absent). */
export async function projectUsage(ctx: ControlContext, projectId: string, range: { from?: string; to?: string } = {}): Promise<ProjectUsage> {
  const { project } = await ctx.scoped.project(projectId);
  const sums = await ctx.repos.tabUsage.sums(project.id, range);
  const taskIds = [...new Set(sums.flatMap((s) => (s.task_id ? [s.task_id] : [])))];
  const tasks = new Map((await ctx.repos.tasks.findByIds(taskIds)).filter((t) => t.project_id === project.id).map((t) => [t.id, t]));
  const epicIds = [...new Set([...tasks.values()].flatMap((t) => (t.type === 'epic' ? [] : t.epic_id ? [t.epic_id] : [])))].filter((id) => !tasks.has(id));
  const epicsById = new Map([...tasks.values()].filter((t) => t.type === 'epic').map((t) => [t.id, t]));
  for (const e of await ctx.repos.tasks.findByIds(epicIds)) if (e.project_id === project.id) epicsById.set(e.id, e);

  const total = zeroLine();
  const cards = new Map<string, UsageLine & { task_id: string; ref: string }>();
  const epics = new Map<string, UsageLine & { epic_id: string; ref: string }>();
  const accounts = new Map<string, UsageLine & { account_id: string; label: string | null }>();
  for (const s of sums) {
    add(total, s);
    const task = s.task_id ? tasks.get(s.task_id) : undefined;
    if (task) {
      const card = cards.get(task.id) ?? { ...zeroLine(), task_id: task.id, ref: task.ref };
      add(card, s);
      cards.set(task.id, card);
      const epic = task.type === 'epic' ? task : task.epic_id ? epicsById.get(task.epic_id) : undefined;
      if (epic) {
        const line = epics.get(epic.id) ?? { ...zeroLine(), epic_id: epic.id, ref: epic.ref };
        add(line, s);
        epics.set(epic.id, line);
      }
    }
    if (s.account_id) {
      const line = accounts.get(s.account_id) ?? { ...zeroLine(), account_id: s.account_id, label: null };
      add(line, s);
      accounts.set(s.account_id, line);
    }
  }
  for (const line of accounts.values()) {
    line.label = await ctx.scoped
      .aiAccount(line.account_id)
      .then(({ account }) => account.label)
      .catch(() => null);
  }
  return { from: range.from ?? null, to: range.to ?? null, total, cards: [...cards.values()], epics: [...epics.values()], accounts: [...accounts.values()] };
}
