import { EventEmitter } from 'node:events';
import type { ControlContext } from '../control/context.js';
import { AUTOMATION_EVENTS_PAGE_MAX, type AutomationEvent, type AutomationEventInput, type AutomationEventKind, type AutomationEventPayload, type Repositories } from '../db/repositories/index.js';

export type { AutomationEvent, AutomationEventKind, AutomationEventPayload };

/** A payload string longer than this is dropped from the event, not cut: a long string is not an id, URL or reason. */
export const EVENT_STRING_MAX = 500;

/** An automation event on its way to the owner's sockets (web `/ws/monitor`, app `/ws/m/chat`). */
export type PublishedAutomationEvent = AutomationEvent & { owner_id: string };

/** In-process fan-out of recorded automation events, one per server process like `monitorBus`. */
class AutomationBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(e: PublishedAutomationEvent): void {
    this.emitter.emit('event', e);
  }

  subscribe(fn: (e: PublishedAutomationEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}

export const automationBus = new AutomationBus();

/**
 * Something the dispatcher should look at now instead of at its next tick (spec D11): a card tagged, a
 * setup saved. Per process; the other colour sees the change at its own tick.
 */
class DispatchTriggers {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  poke(reason: string): void {
    this.emitter.emit('poke', reason);
  }

  subscribe(fn: (reason: string) => void): () => void {
    this.emitter.on('poke', fn);
    return () => this.emitter.off('poke', fn);
  }
}

export const dispatchTriggers = new DispatchTriggers();

/** Keeps only flat values; drops nested values (a JS caller past the type) and over-long strings. */
function flatPayload(payload: AutomationEventPayload | undefined): AutomationEventPayload {
  const out: AutomationEventPayload = {};
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= EVENT_STRING_MAX) out[k] = v;
  }
  return out;
}

/** Tells the owner's sockets of an event already written (a claimed once-only row). */
export async function publishEvent(repos: Repositories, row: AutomationEvent): Promise<void> {
  const project = await repos.projects.findById(row.project_id);
  if (project?.owner_id) automationBus.publish({ ...row, owner_id: project.owner_id });
}

/**
 * Writes one automation event and pushes it to the project owner's sockets. Events hold ids, URLs,
 * counts and reasons only — never terminal content, transcripts or prompts (spec D27).
 */
export async function recordEvent(
  repos: Repositories,
  e: { project_id: string; task_id?: string | null; run_id?: string | null; kind: AutomationEventKind; payload?: AutomationEventPayload },
): Promise<void> {
  const input: AutomationEventInput = { project_id: e.project_id, task_id: e.task_id ?? null, run_id: e.run_id ?? null, kind: e.kind, payload: flatPayload(e.payload) };
  const row = await repos.automationEvents.insert(input);
  const project = await repos.projects.findById(e.project_id);
  if (project?.owner_id) automationBus.publish({ ...row, owner_id: project.owner_id });
}

/**
 * Takes a once-only event (a unique index guards its kind, like `ci_fix_requested`) without telling anyone:
 * null when another call, on this colour or the other, holds it. The caller settles it (`settleEvent`) once
 * it acted, or gives it back (`automationEvents.remove`) so a later pass may take it again.
 */
export async function claimEvent(
  repos: Repositories,
  e: { project_id: string; task_id: string; kind: AutomationEventKind; payload: AutomationEventPayload },
): Promise<AutomationEvent | null> {
  return repos.automationEvents.insertOnce({ project_id: e.project_id, task_id: e.task_id, run_id: null, kind: e.kind, payload: flatPayload(e.payload) });
}

/** Writes the claimed event's outcome and pushes it to the owner's sockets, as `recordEvent` does. */
export async function settleEvent(repos: Repositories, claim: AutomationEvent, payload: AutomationEventPayload): Promise<void> {
  const row = await repos.automationEvents.setPayload(claim.id, flatPayload(payload));
  if (!row) return;
  const project = await repos.projects.findById(row.project_id);
  if (project?.owner_id) automationBus.publish({ ...row, owner_id: project.owner_id });
}

/** A project's events, newest first, for the activity feed (`before` pages back). */
export async function listAutomationEvents(ctx: ControlContext, projectId: string, opts: { before?: string; limit?: number } = {}): Promise<AutomationEvent[]> {
  const { project } = await ctx.scoped.project(projectId);
  return ctx.repos.automationEvents.listByProject(project.id, { before: opts.before ? new Date(opts.before) : undefined, limit: opts.limit ?? AUTOMATION_EVENTS_PAGE_MAX });
}
