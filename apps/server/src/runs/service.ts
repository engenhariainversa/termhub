import { EventEmitter } from 'node:events';
import { RUN_HEADLESS_MIN_AGENT_VERSION, type RunOpenParams } from '@termhub/agent-protocol';
import type { AgentChannel, ChannelClosedReason, ChannelHandlers } from '../agent/connection.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import type { ApiRun, ApiRunWorkspace, StoredRunEvent } from '../db/repositories/api-runs.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, User } from '../db/repositories/types.js';
import { getAccountUsage } from '../ai/index.js';
import { resetAt } from '../automation/quota.js';
import { ensureWorkspace } from '../automation/branches.js';
import { localeOf, msg, t, tk, type Locale } from '../i18n/index.js';
import type { LocalizedText } from '../i18n/index.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import type { Adapter, AdapterOutcome, Capability, Provider, RunErrorCode, RunEvent, RunStatus } from './events.js';
import { looksLikeLimit } from './events.js';
import { checkRunLimits } from './limits.js';
import { claudeTools, codexSandbox, resolveModel, type ModelClass } from './models.js';
import { routeRun, type Candidate, type RouteInput, type RouteResult, type Skipped } from './routing.js';
import { V1Error } from './v1-auth.js';
import { ownProject } from './view.js';

/**
 * Runs a prompt of the personal runs API (TER-1176, spec "Routing", "Workspace", "Security"): picks the
 * account and machine (`routing.ts`), prepares the workspace, opens the agent's `run` channel, sends the
 * prompt as its only data frame, adapts each stdout line into normalized events, stores them in order and
 * wakes the live subscribers (SSE). A rate limit before any output moves the run to the next account;
 * after output it ends the run (`account_limited`), so two accounts' output never mix.
 *
 * Never logged: the prompt, the events, the CLI's output. Only run id, machine id, sizes and outcomes.
 * A run lives in this process: a restart (deploy) ends it `failed` ("server restarted").
 */

export interface CreateRunInput {
  project: string;
  prompt: string;
  capabilities: Capability[];
  model_class?: ModelClass;
  model?: string | null;
  provider?: Provider | null;
  machine?: string | null;
  timeout_s: number;
  idempotency_key?: string | null;
}

/** The agent side the service needs (the `agents` registry in production, a fake in tests). */
export interface RunAgents {
  openRun(machineId: string, params: RunOpenParams, handlers: ChannelHandlers): Promise<AgentChannel>;
  isOnline(machineId: string): boolean;
  capabilities(machineId: string): string[] | null;
}

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export interface RunServiceDeps {
  repos: Repositories;
  agents: RunAgents;
  log: Log;
  route?: (input: RouteInput) => Promise<RouteResult>;
  ensureWorktree?: (machine: Machine, i: { repoDir: string; root: string; projectId: string; ref: string; branch: string; base: string }) => Promise<{ path: string }>;
  /** Marks the account exhausted until its window resets (the automatic work skips it too). */
  markExhausted?: (account: AiAccount, machine: Machine) => Promise<void>;
  now?: () => Date;
  /** How often a running run checks that its machine is still online (default 10 s). */
  offlineCheckMs?: number;
  /** Slack past the run's own timeout before the server gives up on the agent (default 30 s). */
  timeoutGraceMs?: number;
  /** How often a subscriber re-reads the table, on top of the in-process wake (default 1 s). */
  pollMs?: number;
}

/** A run's error: its code and the message, already in the owner's language. */
interface RunFailure {
  code: RunErrorCode;
  message: string;
}

type Attempt =
  /** Rate limited before any output: try the next account. */
  | { kind: 'limited' }
  /** Never started on this candidate (offline, open refused, workspace): try the next one. */
  | { kind: 'skipped'; failure: RunFailure }
  | { kind: 'final'; status: RunStatus; failure: RunFailure | null; outcome: AdapterOutcome | null };

interface Active {
  run: ApiRun;
  locale: Locale;
  channel: AgentChannel | null;
  cancelled: boolean;
  finished: boolean;
  /** Event writes, in order. */
  queue: Promise<void>;
  /** An error event already stored for this run (the CLI's own), so the end does not add a second. */
  errorEmitted: boolean;
  /** Ends the attempt in progress from outside (cancel, shutdown). */
  stop: ((a: Attempt) => void) | null;
}

const WORKTREE_CAPS: readonly Capability[] = ['edit', 'run_commands'];
const IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;
/** Output that has reached the caller: after it, a rate limit can no longer move the run. */
const OUTPUT_EVENTS: ReadonlySet<RunEvent['type']> = new Set(['text', 'tool_use', 'tool_result']);

const CLOSED_MESSAGES: Partial<Record<ChannelClosedReason, LocalizedText>> = {
  cli_missing: msg('A CLI não está instalada nesta máquina'),
  cli_rejected: msg('A CLI recusou as opções da run; atualize-a nesta máquina'),
  run_failed: msg('A CLI terminou com erro'),
  killed: msg('A run foi encerrada na máquina'),
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : 'unknown';
}

export const isTerminal = (status: string) => status === 'succeeded' || status === 'failed' || status === 'cancelled';

export class RunService {
  private readonly active = new Map<string, Active>();
  private readonly bus = new EventEmitter();
  private closing = false;

  constructor(private readonly deps: RunServiceDeps) {
    this.bus.setMaxListeners(0);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Whether this process holds the run now (its events still arriving). */
  holds(runId: string): boolean {
    return this.active.has(runId);
  }

  /**
   * Validated input → a queued run, started in the background. The same idempotency key within 24 h
   * returns the run it created (`created: false`). Throws the API's errors: 404 project, 429 limits,
   * 409 NO_ACCOUNT_AVAILABLE / AGENT_OUTDATED.
   */
  async create(auth: { user: User; token: ApiToken }, input: CreateRunInput): Promise<{ run: ApiRun; created: boolean }> {
    const { repos } = this.deps;
    const { user, token } = auth;
    if (this.closing) throw new V1Error(503, tk('O servidor está reiniciando; tente de novo em instantes'), 'UNAVAILABLE');
    if (input.idempotency_key) {
      const existing = await repos.apiRuns.findByIdempotency(user.id, input.idempotency_key);
      if (existing && this.now().getTime() - Date.parse(existing.created_at) < IDEMPOTENCY_MS) return { run: existing, created: false };
      if (existing) await repos.apiRuns.clearIdempotencyKey(existing.id);
    }
    const project = await ownProject(repos, user, input.project);

    const limit = await checkRunLimits(repos, { userId: user.id, tokenId: token.id }, this.now());
    if (!limit.ok) throw new RunLimitError(limit.retryAfterS);

    const route = this.deps.route ?? ((i: RouteInput) => routeRun({ repos, agents: this.deps.agents }, i));
    const routed = await route({ userId: user.id, projectId: project.id, provider: input.provider ?? null, model: input.model ?? null, machine: input.machine ?? null });
    if (routed.candidates.length === 0) throw noCandidate(routed.skipped);

    const blocked = await repos.users.chatBlockedModels(user.id).catch((): string[] => []);
    let run: ApiRun;
    try {
      run = await repos.apiRuns.create({
        user_id: user.id,
        token_id: token.id,
        project_id: project.id,
        capabilities: input.capabilities,
        timeout_ms: input.timeout_s * 1000,
        idempotency_key: input.idempotency_key ?? null,
      });
    } catch (err) {
      // Two requests with the same key at once: the unique index lets one through, the other gets its run.
      const again = input.idempotency_key ? await repos.apiRuns.findByIdempotency(user.id, input.idempotency_key) : undefined;
      if (again) return { run: again, created: false };
      throw err;
    }

    const st: Active = { run, locale: localeOf(user.locale), channel: null, cancelled: false, finished: false, queue: Promise.resolve(), errorEmitted: false, stop: null };
    this.active.set(run.id, st);
    this.deps.log.info({ runId: run.id, projectId: project.id, candidates: routed.candidates.length, promptChars: input.prompt.length, capabilities: input.capabilities }, 'api run: created');
    void this.execute(st, input, routed, blocked).catch((err: unknown) => {
      this.deps.log.warn({ runId: run.id, err: errorText(err) }, 'api run: execution failed');
      return this.finalize(st, 'failed', { code: 'cli_failed', message: t(st.locale, tk('Erro interno')) }, null);
    });
    return { run, created: true };
  }

  /**
   * Cancels the person's run: the agent kills the CLI's process group and the run ends `cancelled`. A
   * run that already ended stays as it is. Returns the run, or undefined when it is not theirs.
   */
  async cancel(userId: string, runId: string): Promise<ApiRun | undefined> {
    const { repos } = this.deps;
    const run = await repos.apiRuns.findForUser(userId, runId);
    if (!run) return undefined;
    if (isTerminal(run.status)) return run;
    const st = this.active.get(runId);
    if (st) {
      st.cancelled = true;
      if (st.stop) {
        st.stop({ kind: 'final', status: 'cancelled', failure: null, outcome: null });
        await this.whenFinished(st);
      } else await this.finalize(st, 'cancelled', null, null);
    } else {
      // Held by no process (a crash, or the other color): end it here.
      if (await repos.apiRuns.finishActive(runId, { status: 'cancelled', ended_at: this.now() })) {
        await repos.apiRuns.appendEvents(runId, [{ type: 'done', payload: { status: 'cancelled', result: null, usage: null } }]);
        this.bus.emit(runId);
      }
    }
    this.deps.log.info({ runId }, 'api run: cancel requested');
    return (await repos.apiRuns.findForUser(userId, runId)) ?? run;
  }

  /**
   * Streams the run's events with `seq` above `afterSeq`, in order: what is stored first, then what
   * arrives. `onEnd` fires after `done`, or once a run that ended has nothing more to give (its events
   * pruned). The returned function stops it; stopping never cancels the run.
   */
  subscribe(runId: string, afterSeq: number, onEvent: (e: StoredRunEvent) => void, onEnd: () => void): () => void {
    const { repos } = this.deps;
    let last = afterSeq;
    let stopped = false;
    let busy = false;
    let again = false;
    const finish = () => {
      if (stopped) return;
      stop();
      onEnd();
    };
    const pump = async (checkEnd: boolean): Promise<void> => {
      if (stopped) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        for (;;) {
          again = false;
          const events = await repos.apiRuns.eventsAfter(runId, last, 500);
          for (const e of events) {
            if (stopped) return;
            last = e.seq;
            onEvent(e);
            if (e.type === 'done') return finish();
          }
          if (events.length === 500 || again) continue;
          break;
        }
        if (checkEnd && !this.active.has(runId)) {
          const run = await repos.apiRuns.findById(runId);
          if (!run || isTerminal(run.status)) {
            // A done written between the read above and this one is still delivered.
            const tail = await repos.apiRuns.eventsAfter(runId, last, 500);
            for (const e of tail) {
              if (stopped) return;
              last = e.seq;
              onEvent(e);
            }
            finish();
          }
        }
      } catch {
        // The next tick reads again.
      } finally {
        busy = false;
      }
    };
    const wake = () => void pump(false);
    this.bus.on(runId, wake);
    const timer = setInterval(() => void pump(true), this.deps.pollMs ?? 1000);
    timer.unref?.();
    function stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      bus.off(runId, wake);
    }
    const bus = this.bus;
    void pump(true);
    return stop;
  }

  /**
   * The server is going away (SIGTERM drain, close): every run it holds ends `failed` ("server
   * restarted"); a run cannot move to the next color in v1, and the docs say so.
   */
  async shutdown(): Promise<void> {
    this.closing = true;
    const all = [...this.active.values()];
    await Promise.all(
      all.map((st) => {
        const failure: RunFailure = { code: 'cli_failed', message: t(st.locale, tk('O servidor reiniciou')) };
        if (st.stop) {
          st.stop({ kind: 'final', status: 'failed', failure, outcome: null });
          return st.queue;
        }
        return this.finalize(st, 'failed', failure, null);
      }),
    );
    // Let the finalizations started by `stop` land before the database closes.
    await Promise.all(all.map((st) => this.whenFinished(st)));
  }

  private finishedWaiters = new Map<string, Array<() => void>>();

  private whenFinished(st: Active): Promise<void> {
    if (!this.active.has(st.run.id)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.finishedWaiters.get(st.run.id) ?? [];
      list.push(resolve);
      this.finishedWaiters.set(st.run.id, list);
    });
  }

  // ---------------------------------------------------------------------------------------------

  private async execute(st: Active, input: CreateRunInput, routed: RouteResult, blocked: string[]): Promise<void> {
    const { repos } = this.deps;
    const setup = (await repos.projectSetup.get(st.run.project_id)).data;
    let failure: RunFailure = { code: 'agent_offline', message: t(st.locale, tk('Nenhuma máquina disponível respondeu')) };
    let limited = false;
    const worktrees = new Map<string, ApiRunWorkspace>();
    for (const c of routed.candidates) {
      if (st.finished || st.cancelled) return;
      if (!this.deps.agents.isOnline(c.machine.id)) continue;
      let ws: ApiRunWorkspace;
      try {
        ws = worktrees.get(c.machine.id) ?? (await this.workspace(st, c, setup));
        worktrees.set(c.machine.id, ws);
      } catch (err) {
        this.deps.log.warn({ runId: st.run.id, machineId: c.machine.id, err: errorText(err) }, 'api run: workspace failed');
        failure = { code: 'cli_failed', message: t(st.locale, tk('Não foi possível preparar a worktree da run')) };
        continue;
      }
      if (st.finished || st.cancelled) return;
      const model = resolveModel(c.provider, { model: input.model ?? undefined, model_class: input.model_class }, { blocked, setupModels: routed.ai.models });
      const r = await this.attempt(st, input, c, ws, model);
      if (r.kind === 'limited') {
        limited = true;
        failure = { code: 'account_limited', message: t(st.locale, tk('Todas as contas disponíveis estão no limite de uso')) };
        await (this.deps.markExhausted ?? defaultMarkExhausted(repos, () => this.now()))(c.account, c.machine).catch((err: unknown) =>
          this.deps.log.warn({ runId: st.run.id, accountId: c.account.id, err: errorText(err) }, 'api run: exhaustion not recorded'),
        );
        this.deps.log.info({ runId: st.run.id, accountId: c.account.id }, 'api run: account limited before output, trying the next');
        continue;
      }
      if (r.kind === 'skipped') {
        if (!limited) failure = r.failure;
        continue;
      }
      return this.finalize(st, r.status, r.failure, r.outcome);
    }
    return this.finalize(st, 'failed', failure, null);
  }

  /** read → the project's folder; edit/run_commands → a disposable worktree `<worktrees_dir>/<projectId>/run-<id>`. */
  private async workspace(st: Active, c: Candidate, setup: Awaited<ReturnType<Repositories['projectSetup']['get']>>['data']): Promise<ApiRunWorkspace> {
    if (!st.run.capabilities.some((cap) => WORKTREE_CAPS.includes(cap as Capability))) return { kind: 'project', path: c.cwd, branch: null };
    const ensure = this.deps.ensureWorktree ?? ensureWorkspace;
    const branch = `termhub/run-${st.run.id}`;
    const r = await ensure(c.machine, { repoDir: c.cwd, root: setup.automation.worktrees_dir, projectId: st.run.project_id, ref: `run-${st.run.id}`, branch, base: setup.repo?.base_branch ?? 'main' });
    return { kind: 'worktree', path: r.path, branch };
  }

  /** One try on one account: resolves when the run ended on it, or when it should move to the next one. */
  private async attempt(st: Active, input: CreateRunInput, c: Candidate, ws: ApiRunWorkspace, model: string | null): Promise<Attempt> {
    const { repos, agents, log } = this.deps;
    const runId = st.run.id;
    const caps = st.run.capabilities as Capability[];
    const params: RunOpenParams =
      c.provider === 'claude'
        ? { provider: 'claude', config_dir: c.account.config_dir, cwd: ws.path, model, tools: claudeTools(caps), timeout_ms: st.run.timeout_ms, guard: ws.kind === 'worktree' && ws.branch ? { branch: ws.branch, worktree: ws.path } : null }
        : { provider: 'codex', config_dir: c.account.config_dir, cwd: ws.path, model, sandbox: codexSandbox(caps), timeout_ms: st.run.timeout_ms, guard: null };

    const marked = await repos.apiRuns.setStatus(
      runId,
      {
        status: 'running',
      machine_id: c.machine.id,
      account_id: c.account.id,
      provider: c.provider,
      model,
      workspace: ws,
        ...(st.run.started_at ? {} : { started_at: this.now() }),
      },
      { onlyActive: true },
    );
    // Cancelled (or the server closing) while this was on its way: nothing is started.
    if (!marked || st.finished) return { kind: 'final', status: 'cancelled', failure: null, outcome: null };
    st.run = { ...st.run, started_at: st.run.started_at ?? this.now().toISOString() };
    this.emit(st, [{ type: 'started', provider: c.provider, model, machine: c.machine.name, account: c.account.label, workspace: { kind: ws.kind, path: ws.path, branch: ws.branch } }]);

    const adapter: Adapter = c.provider === 'claude' ? claudeAdapter() : codexAdapter();
    let output = false;
    let heldLimit: RunEvent | null = null;
    // Usage before any output is held too: on a move to the next account it would restart the cumulative count.
    let heldUsage: RunEvent | null = null;
    let buffer = '';
    let bytes = 0;

    return new Promise<Attempt>((resolve) => {
      let settled = false;
      const end = (a: Attempt) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        clearTimeout(deadline);
        st.stop = null;
        const ch = st.channel;
        st.channel = null;
        // Still open = the end was decided here (cancel, offline, deadline, shutdown): closing it has the
        // agent kill the CLI's process group. After the agent's own `closed` it is already null.
        if (ch) {
          try {
            ch.close();
          } catch {
            /* the connection is gone */
          }
        }
        log.info({ runId, machineId: c.machine.id, kind: a.kind, status: a.kind === 'final' ? a.status : null, bytes }, 'api run: attempt ended');
        resolve(a.kind === 'final' && !a.outcome ? { ...a, outcome: adapter.finish() } : a);
      };
      st.stop = end;

      const feed = (line: string) => {
        const events = adapter.parse(line);
        const keep: RunEvent[] = [];
        for (const e of events) {
          if (e.type === 'error' && e.code === 'account_limited' && !output) {
            // Held back: if the run moves to the next account, this one never happened for the caller.
            heldLimit = e;
            continue;
          }
          if (e.type === 'text' && looksLikeLimit(e.text) && !output) continue;
          if (e.type === 'usage' && !output) {
            heldUsage = e;
            continue;
          }
          if (OUTPUT_EVENTS.has(e.type) && !output) {
            output = true;
            if (heldUsage) keep.push(heldUsage);
            heldUsage = null;
          }
          if (e.type === 'error') st.errorEmitted = true;
          keep.push(e);
        }
        this.emit(st, keep);
      };

      const handlers: ChannelHandlers = {
        onData: (data) => {
          if (settled) return;
          bytes += data.length;
          buffer += data.toString('utf8');
          for (;;) {
            const nl = buffer.indexOf('\n');
            if (nl === -1) break;
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.trim()) feed(line);
          }
        },
        onExit: (code, reason) => {
          if (settled) return;
          if (buffer.trim()) feed(buffer);
          buffer = '';
          st.channel = null;
          const outcome = adapter.finish();
          const limitedNow = reason === 'usage_limit' || heldLimit !== null;
          if (limitedNow && !output) return end({ kind: 'limited' });
          if (heldUsage) this.emit(st, [heldUsage]);
          if (limitedNow) {
            return end({ kind: 'final', status: 'failed', failure: { code: 'account_limited', message: t(st.locale, tk('A conta atingiu o limite de uso depois que a run já tinha começado a responder')) }, outcome });
          }
          if (reason === 'timeout') return end({ kind: 'final', status: 'failed', failure: { code: 'timeout', message: t(st.locale, tk('A run passou do tempo limite')) }, outcome });
          if (code === null && reason === undefined) {
            return end({ kind: 'final', status: 'failed', failure: { code: 'agent_offline', message: t(st.locale, tk('A máquina desconectou durante a run')) }, outcome });
          }
          if (code === 0 && reason === undefined && outcome.ok) return end({ kind: 'final', status: 'succeeded', failure: null, outcome });
          const text = (reason && CLOSED_MESSAGES[reason]) ?? msg('A CLI terminou com erro');
          return end({ kind: 'final', status: 'failed', failure: { code: 'cli_failed', message: t(st.locale, text) }, outcome });
        },
      };

      // The agent's own deadline normally ends the run; this one covers an agent that never answers.
      const deadline = setTimeout(
        () => end({ kind: 'final', status: 'failed', failure: { code: 'timeout', message: t(st.locale, tk('A run passou do tempo limite')) }, outcome: null }),
        st.run.timeout_ms + (this.deps.timeoutGraceMs ?? 30_000),
      );
      deadline.unref?.();
      // A connection that dies without a close frame is noticed here, well within 60 s.
      const watchdog = setInterval(() => {
        if (!agents.isOnline(c.machine.id)) end({ kind: 'final', status: 'failed', failure: { code: 'agent_offline', message: t(st.locale, tk('A máquina desconectou durante a run')) }, outcome: null });
      }, this.deps.offlineCheckMs ?? 10_000);
      watchdog.unref?.();

      if (st.cancelled) return end({ kind: 'final', status: 'cancelled', failure: null, outcome: null });
      agents.openRun(c.machine.id, params, handlers).then(
        (ch) => {
          if (settled) {
            try {
              ch.close();
            } catch {
              /* gone */
            }
            return;
          }
          st.channel = ch;
          // stdin only: argv is visible to every process on the machine.
          ch.write(Buffer.from(input.prompt, 'utf8'));
        },
        (err: unknown) => {
          log.warn({ runId, machineId: c.machine.id, err: errorText(err) }, 'api run: channel did not open');
          end({ kind: 'skipped', failure: { code: 'agent_offline', message: t(st.locale, tk('A máquina não abriu a run')) } });
        },
      );
    });
  }

  /** Stores events after the run's last, in order, and wakes the subscribers. */
  private emit(st: Active, events: RunEvent[]): Promise<void> {
    if (events.length === 0) return st.queue;
    const rows = events.map(({ type, ...payload }) => ({ type, payload: payload as Record<string, unknown> }));
    st.queue = st.queue
      .then(async () => {
        await this.deps.repos.apiRuns.appendEvents(st.run.id, rows);
        this.bus.emit(st.run.id);
      })
      .catch((err: unknown) => this.deps.log.warn({ runId: st.run.id, count: rows.length, err: errorText(err) }, 'api run: events not stored'));
    return st.queue;
  }

  /** Ends the run once: its error (unless the CLI's own was stored), the row, then `done`. */
  private async finalize(st: Active, status: RunStatus, failure: RunFailure | null, outcome: AdapterOutcome | null): Promise<void> {
    if (st.finished) return;
    st.finished = true;
    try {
      if (failure && !st.errorEmitted) await this.emit(st, [{ type: 'error', code: failure.code, message: failure.message }]);
      await st.queue;
      const result = outcome?.result ?? null;
      const usage = outcome?.usage ?? null;
      await this.deps.repos.apiRuns.finishActive(st.run.id, {
        status,
        result,
        usage,
        error_code: failure?.code ?? null,
        error_message: failure?.message ?? null,
        ended_at: this.now(),
      });
      await this.emit(st, [{ type: 'done', status, result, usage }]);
      this.deps.log.info({ runId: st.run.id, status, error: failure?.code ?? null }, 'api run: ended');
    } finally {
      this.active.delete(st.run.id);
      for (const w of this.finishedWaiters.get(st.run.id) ?? []) w();
      this.finishedWaiters.delete(st.run.id);
      this.bus.emit(st.run.id);
    }
  }
}

/** 429 with the seconds to wait (the route sets `Retry-After`). */
export class RunLimitError extends V1Error {
  constructor(retryAfterS: number) {
    super(429, tk('Limite de runs atingido; tente de novo mais tarde'), 'RATE_LIMITED');
    this.retryAfterS = retryAfterS;
  }
}

/** 409 with one reason per account left out (the route adds it to the body). */
export class NoCandidateError extends V1Error {
  constructor(code: 'NO_ACCOUNT_AVAILABLE' | 'AGENT_OUTDATED', message: LocalizedText, skipped: Skipped[]) {
    super(409, message, code);
    this.details = { candidates: skipped };
  }
}

function noCandidate(skipped: Skipped[]): NoCandidateError {
  if (skipped.length > 0 && skipped.every((s) => s.reason === 'agent_outdated')) {
    return new NoCandidateError('AGENT_OUTDATED', msg('Atualize o agente desta máquina (npm i -g @termhub/agent, versão {{version}} ou mais nova)', { version: RUN_HEADLESS_MIN_AGENT_VERSION }), skipped);
  }
  if (skipped.length === 0) return new NoCandidateError('NO_ACCOUNT_AVAILABLE', msg('O projeto não tem contas de Claude Code ou Codex suas no Setup'), skipped);
  return new NoCandidateError('NO_ACCOUNT_AVAILABLE', msg('Nenhuma conta disponível para a run'), skipped);
}

/** The account's limit lasts until its usage window resets (an hour when that is unknown). */
function defaultMarkExhausted(repos: Repositories, now: () => Date) {
  return async (account: AiAccount, machine: Machine) => {
    const usage = await getAccountUsage(account, machine, true).catch(() => null);
    await repos.aiAccountExhaustions.mark(account.id, resetAt(usage, now()), 'rate_limit');
  };
}

