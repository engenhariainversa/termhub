import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PostRunWaker, Waker } from '../chat/wake.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { endedRunOfTab, isTypedRequest, reopenedRunNote, wakeForPostRunBlock } from '../automation/post-run.js';
import { unauthorized } from '../lib/errors.js';
import { ingestHookEvent } from '../monitor/ingest.js';
import { HOOK_TOOLS } from '../monitor/state.js';
import { HOOK_TOKEN_PREFIX, hashHookToken } from '../monitor/token.js';
import { recordEvent } from '../automation/events.js';

/** `waker` (spec 2026-09-26 concierge memory §7): optional, since a test with no `ChatService`
 *  instance to build one from simply omits it, and no card is ever woken for. */
export interface HooksDeps {
  waker?: Waker;
  /** told the tab of every Claude hook event (the tab chat hub's `poke`, spec 2026-10-01 tab chat §5.3) */
  onTabEvent?: (tabId: string) => void;
  /** wakes the project's chat for a guard block in a tab whose run ended (TER-1112); left out, it is only recorded */
  postRunWaker?: PostRunWaker;
  /** reopens a run of the card when a request is typed into a tab whose run ended (`reopenRunInTab`, TER-1112) */
  reopenRun?: (tab: Tab) => Promise<AutomationRun | null>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** machine authenticated by its hook token (hooks routes only) */
    hookMachineId?: string;
  }
}

/** Exported for the unit test: what the machines' hook script posts. */
export const hookEventBody = z.object({
  tool: z.enum(HOOK_TOOLS),
  /** tmux session the tool runs in (the script reads it from $TMUX_PANE) */
  session: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  /** the tool's raw hook payload; interpreted server-side */
  event: z.unknown(),
});

/** Codex includes the turn's input messages in its payload; keep room for that, nothing bigger. */
export const HOOK_BODY_LIMIT = 256 * 1024;

/**
 * Monitor ingestion. POST is public (no user session): the machines post here with the token
 * their hook install got — the proxy forwards termhub.dev/api/hooks/events to the app so the
 * calls do not go through Cloudflare Access. Only the token's hash is stored.
 */
export async function hooksRoutes(app: FastifyInstance, repos: Repositories, deps: HooksDeps = {}) {
  /** Token check runs at onRequest, before the body is read: an unauthenticated caller never gets a JSON parse. */
  const authenticate = async (request: FastifyRequest) => {
    const auth = request.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token.startsWith(HOOK_TOKEN_PREFIX) || token.length > 128) throw unauthorized();
    const machineId = await repos.machineHooks.machineIdForTokenHash(hashHookToken(token));
    if (!machineId) throw unauthorized();
    request.hookMachineId = machineId;
  };

  app.post('/events', { config: { public: true }, bodyLimit: HOOK_BODY_LIMIT, onRequest: authenticate }, async (request, reply) => {
    const machineId = request.hookMachineId;
    if (!machineId) throw unauthorized();

    const body = hookEventBody.parse(request.body);
    const result = await ingestHookEvent(repos, request.log, { machineId, tool: body.tool, session: body.session, event: body.event }, deps.waker, deps.onTabEvent);
    // A request typed into a tab whose automatic run ended reopens a run of its card (TER-1112); the agent is told.
    const reopened = result.ok && deps.reopenRun && isTypedPrompt(body.event) ? await reopenedNote(repos, deps.reopenRun, result.tab) : null;
    const context = [result.origin_note, body.tool === 'claude' ? reopened : null].filter((n): n is string => !!n).join('\n\n');
    // A prompt termhub typed (TER-851): the hook script prints this body as is, so Claude Code adds the
    // note to the session's context. Nothing else may come first: the script checks the prefix.
    if (context) return reply.code(200).send({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } });
    if (!result.ok) return reply.code(202).send({ ok: false, reason: result.reason });
    return { ok: true, tab_id: result.tab.id, state: result.tab.state };
  });

  // The hard-lock guard (TER-993) reports a block it made, so the feed shows what was stopped. It carries
  // the tool name and a short reason only — never the command (CLAUDE.md: terminal content is never
  // logged). Fire-and-forget from the guard; the reply is ignored. Recorded as `guard_blocked` against
  // the tab's active automatic run, and dropped silently when the session is not an automatic tab. A tab
  // whose run already ended (TER-1112) still records it, against that last run (`after_run: true`), and
  // wakes the project's chat: nothing else follows that tab.
  app.post('/guard', { config: { public: true }, bodyLimit: 8 * 1024, onRequest: authenticate }, async (request, reply) => {
    const machineId = request.hookMachineId;
    if (!machineId) throw unauthorized();
    const body = guardBlockedBody.parse(request.body);
    const tab = await repos.tabs.findByTmuxSession(machineId, body.session);
    if (!tab) return reply.code(202).send({ ok: false, reason: 'unknown_session' });
    const active = await repos.automationRuns.activeByTab(tab.id);
    const run = active ?? (await endedRunOfTab(repos, tab));
    if (!run) return reply.code(202).send({ ok: false, reason: 'not_automatic' });
    const afterRun = !active;
    const payload = { tab_id: tab.id, tool: body.tool, reason: body.reason, ...(afterRun ? { after_run: true } : {}) };
    await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'guard_blocked', payload }).catch(() => undefined);
    if (afterRun) await wakeForPostRunBlock(repos, deps.postRunWaker, run, tab, { cause: 'guard_blocked', tool: body.tool, reason: body.reason }, request.log);
    return { ok: true };
  });
}

/** A Claude or Codex `UserPromptSubmit` whose prompt someone typed (`isTypedRequest`); the prompt is only looked at. */
function isTypedPrompt(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const { hook_event_name: name, prompt } = event as Record<string, unknown>;
  return name === 'UserPromptSubmit' && isTypedRequest(prompt);
}

/** Reopens the tab's ended run (TER-1112) and returns the note for the agent, or null when nothing was reopened. */
async function reopenedNote(repos: Repositories, reopen: NonNullable<HooksDeps['reopenRun']>, tab: Tab): Promise<string | null> {
  const run = await reopen(tab);
  const task = run?.task_id ? await repos.tasks.findById(run.task_id).catch(() => undefined) : undefined;
  return run && task ? reopenedRunNote(run, task) : null;
}

/** What the guard script posts on a block: the session, the tool it stopped and a short reason (no command). */
export const guardBlockedBody = z.object({
  session: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  tool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
  reason: z.string().max(200),
});
