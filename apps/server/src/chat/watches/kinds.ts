/**
 * TER-1099: what a watch ("me avise quando…") can follow, and which events each kind fires. The concierge
 * registers one with `watch`; the engine (`engine.ts`) compares the target's state with the watch's
 * baseline, on every sweep and right after the in-process buses report a change, and wakes the chat.
 */

export const WATCH_KINDS = ['tab', 'card', 'pr', 'machine', 'agent_release'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
export const isWatchKind = (v: unknown): v is WatchKind => (WATCH_KINDS as readonly string[]).includes(v as string);

/** A tab's stops (its monitor states other than `working`), and `gone`: the tab was closed or its session died. */
export const TAB_EVENTS = ['finished', 'waiting_input', 'waiting_permission', 'idle', 'error', 'blocked', 'auth_required', 'trust_prompt', 'waiting_background', 'gone'] as const;
/** What "the tab stopped" means when the concierge names no event: every stop but background work still running. */
export const TAB_DEFAULT_EVENTS: readonly TabWatchEvent[] = TAB_EVENTS.filter((e) => e !== 'waiting_background');
export type TabWatchEvent = (typeof TAB_EVENTS)[number];

/** A card moved to another column (optionally: to one of a category), or was deleted. */
export const CARD_EVENTS = ['moved', 'gone'] as const;
export type CardWatchEvent = (typeof CARD_EVENTS)[number];
export const CARD_STATUSES = ['backlog', 'todo', 'doing', 'done'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

/** A pull request (of a card, or by URL), its CI, its deploy and its release workflows (agent, OTA, store). */
export const PR_EVENTS = ['opened', 'merged', 'closed', 'ci_failed', 'ci_passed', 'deploy_ok', 'deploy_failed', 'release_ok', 'release_failed'] as const;
export type PrWatchEvent = (typeof PR_EVENTS)[number];
export const PR_DEFAULT_EVENTS: readonly PrWatchEvent[] = ['merged', 'closed', 'ci_failed'];

export const MACHINE_EVENTS = ['online', 'offline', 'gone'] as const;
export type MachineWatchEvent = (typeof MACHINE_EVENTS)[number];

/** A new `@termhub/agent` on npm at or above `version`. */
export const AGENT_RELEASE_EVENTS = ['published'] as const;

export const EVENTS_BY_KIND: Record<WatchKind, readonly string[]> = {
  tab: TAB_EVENTS,
  card: CARD_EVENTS,
  pr: PR_EVENTS,
  machine: MACHINE_EVENTS,
  agent_release: AGENT_RELEASE_EVENTS,
};
export const DEFAULT_EVENTS: Record<WatchKind, readonly string[]> = {
  tab: TAB_DEFAULT_EVENTS,
  card: CARD_EVENTS,
  pr: PR_DEFAULT_EVENTS,
  machine: ['online', 'offline'],
  agent_release: AGENT_RELEASE_EVENTS,
};

/** Every watch ends this way too: its time ran out (the chat is told once), or the person or the concierge cancelled it. */
export const EXPIRED_EVENT = 'expired';

/** What a watch was registered with, beyond its target. */
export interface WatchParams {
  events: string[];
  /** pr: the pull request's URL, when the watch is not on a card's PRs. */
  pr_url?: string;
  /** card: only a move into a column of this category counts. */
  to?: CardStatus;
  /** agent_release: the lowest version that counts (x.y.z). */
  version?: string;
  /** pr release events: only this workflow's run counts (its file or name, as the setup lists it). */
  workflow?: string;
}

/** Limits (card §4): open watches per chat scope, wakes per hour, validity and the recurring pace. */
export const WATCH_LIMITS = {
  openPerScope: 30,
  wakesPerHour: 12,
  defaultHours: 24,
  maxHours: 24 * 7,
  /** A recurring watch fires at most once in this window; what happens meanwhile is told at its end. */
  recurringCooldownMs: 10 * 60_000,
  noteMax: 500,
} as const;

export const WATCH_STATUSES = ['open', 'done', 'cancelled', 'expired', 'gone'] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

/** x.y.z, the only versions an agent release watch compares. */
export const SEMVER = /^\d+\.\d+\.\d+$/;
