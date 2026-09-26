import type { FastifyBaseLogger } from 'fastify';
import { noteHookEvent } from '../chat/tab-questions.js';
import { cancelTabSuggestion, scheduleTabSuggestion } from '../chat/tab-suggestions.js';
import { autoSwapOnLimit } from '../control/account-swap.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { monitorBus } from './bus.js';
import { claudeSessionOf, interpretHookEvent, isRateLimit, type HookTool, type Interpreted } from './state.js';

export type IngestResult = { ok: true; tab: Tab } | { ok: false; reason: 'unknown_session' | 'ignored' };

/**
 * A hook fired on a machine: find the tab by its tmux session, interpret the payload, store
 * the event as the tab's state and tell the subscribers. Logs metadata only (never `text`).
 */
export async function ingestHookEvent(
  repos: Repositories,
  log: FastifyBaseLogger,
  input: { machineId: string; tool: HookTool; session: string; event: unknown },
): Promise<IngestResult> {
  const tab = await repos.tabs.findByTmuxSession(input.machineId, input.session);
  if (!tab) return { ok: false, reason: 'unknown_session' };
  // Any hook event of the tab means its screen moved: a suggestion check still waiting opens nothing
  // (spec 2026-09-25 tab suggestions §6.1).
  cancelTabSuggestion(tab.id);
  let current = tab;
  const interpreted = interpretHookEvent(input.tool, input.event);
  if (input.tool === 'claude') current = await noteClaudeSession(repos, current, input.event, interpreted);
  if (!interpreted) return { ok: false, reason: 'ignored' };
  const updated = await recordInterpretation(repos, log, current, input.tool, interpreted);
  // After the tab row (spec 2026-09-25 §4.2): a question opens a card in the project's chat, any
  // other event closes the one on screen. Never throws.
  await noteHookEvent(repos, log, updated, interpreted);
  // Claude Code draws its suggested next prompt shortly after the turn ends: look in a few seconds.
  if (input.tool === 'claude' && interpreted.meta.event === 'Stop') scheduleTabSuggestion(repos, log, updated.id);
  if (isRateLimit(interpreted)) autoSwapOnLimit(repos, log, updated);
  return { ok: true, tab: updated };
}

/** The tab's side of an interpreted event: the light activity path, or a recorded state. */
async function recordInterpretation(repos: Repositories, log: FastifyBaseLogger, tab: Tab, tool: HookTool, interpreted: Interpreted): Promise<Tab> {
  // A tool (or spinner verb) change on a tab already working is not a state change: the light path
  // moves only the activity and its verb (no event row) and still tells the subscribers. The script
  // already posts only on a change; the equality check here is a defensive no-op for anything else.
  if (interpreted.activity !== undefined && tab.state === 'working' && interpreted.kind === 'working') {
    const verb = interpreted.verb ?? null;
    if (tab.activity === interpreted.activity && tab.activity_verb === verb) return tab;
    // Nothing updated: the tab stopped working (or is gone) between the read above and this write —
    // the conditional UPDATE is what decides, not the row we read. The full path takes it from here.
    const updated = await repos.tabs.setActivity(tab.id, interpreted.activity, verb);
    if (updated) {
      const machine = await repos.machines.findById(tab.machine_id);
      // the verb came off the person's screen: only whether there was one is logged
      log.debug({ tabId: tab.id, machineId: machine?.id, activity: interpreted.activity, hasVerb: verb !== null }, 'monitor: tab activity');
      publishTabChange(updated, tab.project_id, machine);
      return updated;
    }
  }
  return applyState(repos, log, tab, tool, interpreted);
}

/** Records the event for the tab, updates its state and publishes the change. */
export async function applyState(repos: Repositories, log: FastifyBaseLogger, tab: Tab, tool: string, next: Interpreted): Promise<Tab> {
  const { tab: updated } = await repos.tabs.recordEvent(tab.id, {
    kind: next.kind,
    tool,
    text: next.text,
    meta: next.meta,
    activity: next.activity,
    activityVerb: next.verb,
    ...(next.continuesWait ? { continuesWait: true } : {}),
    ...(next.keepsWaitText ? { keepsWaitText: true } : {}),
  });
  const machine = await repos.machines.findById(tab.machine_id);
  log.info({ tabId: tab.id, machineId: machine?.id, tool, kind: next.kind, textLen: next.text?.length ?? 0 }, 'monitor: tab state');
  publishTabChange(updated, tab.project_id, machine);
  return updated;
}

/** Tells the monitor subscribers (WS handler) about a tab whose state or seen-ness changed. */
export function publishTabChange(tab: Tab, projectId: string, machine: { id: string; owner_id: string | null } | undefined): void {
  monitorBus.publish({ tab, project_id: projectId, machine_id: machine?.id ?? '', owner_id: machine?.owner_id ?? null });
}

/**
 * Events that mean the tab's Claude is running again: a usage limit it was stuck on is over. A turn
 * that ended normally (Stop) proves the account works again — Claude's own auto-continue after the
 * reset may produce nothing else.
 */
const RUNNING_AGAIN = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']);

/**
 * The tab's Claude bookkeeping (spec 2026-09-26 account swap): the session it runs (a `/clear` starts a
 * new one) and whether it is stuck on a usage limit. One write, only when something changed.
 */
async function noteClaudeSession(repos: Repositories, tab: Tab, event: unknown, interpreted: Interpreted | null): Promise<Tab> {
  const patch: Parameters<Repositories['tabs']['setAgentFields']>[1] = {};
  const session = claudeSessionOf(event);
  if (session && (session.session_id !== tab.agent_session_id || session.transcript_path !== tab.agent_transcript_path)) {
    patch.agent_session_id = session.session_id;
    patch.agent_transcript_path = session.transcript_path;
  }
  const name = interpreted?.meta.event;
  if (isRateLimit(interpreted)) patch.rate_limited_at = new Date();
  else if (tab.rate_limited_at && typeof name === 'string' && RUNNING_AGAIN.has(name)) patch.rate_limited_at = null;
  if (Object.keys(patch).length === 0) return tab;
  return (await repos.tabs.setAgentFields(tab.id, patch)) ?? tab;
}
