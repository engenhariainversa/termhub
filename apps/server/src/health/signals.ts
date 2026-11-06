/**
 * TER-1121: the signs of stalled work the project's health watcher looks for. Pure: `observe` reads a
 * snapshot of one project (built by `snapshot.ts`) and answers what it sees right now, each sign with its
 * subject (the PR, tab, card, run or machine it is about), when it started as far as the snapshot tells, and
 * whether only the person can act (`needs_you`) or the project's chat may resolve it (`concierge`). The
 * watcher (`watcher.ts`) keeps one alert per sign and subject, opens it once the sign outlasts its minutes,
 * and closes it when the sign is gone. Ids, URLs, states and reason codes only — never terminal content.
 */
import { versionAtLeast } from '../agent/errors.js';
import type { AutonomyLevel, HealthSignal, ProjectHealth } from '../setup/schema.js';

export type HealthLevel = 'needs_you' | 'concierge';

/** Flat strings and numbers, for the panel, the wake text and the push. */
export type HealthDetail = Record<string, string | number | null>;

export interface Observation {
  signal: HealthSignal;
  subject: string;
  level: HealthLevel;
  /** when the sign started, as far as the snapshot tells; null = from the first time the watcher saw it */
  since: Date | null;
  detail: HealthDetail;
  /** opens at once, whatever its minutes: the wait is a person's by policy, not by time (TER-1136) */
  now?: boolean;
}

/** Merge waits only a person ends, which the merge executor already pushed and woke the chat about (TER-1136). */
export const PERSON_WAITS: readonly string[] = ['merge_person_card'];

/** Signs that run on every project: a person's own tabs and machines stall too. The rest need automation on. */
export const LIGHT_SIGNALS: readonly HealthSignal[] = ['tab_stuck', 'tab_waiting', 'machine_offline'];

export const LEVEL_OF: Record<HealthSignal, HealthLevel> = {
  pr_ready: 'needs_you',
  base_red: 'needs_you',
  queue_stalled: 'concierge',
  tab_stuck: 'concierge',
  tab_waiting: 'concierge',
  card_orphan: 'concierge',
  run_blocked: 'needs_you',
  machine_offline: 'needs_you',
  delivery_failed: 'needs_you',
  agent_outdated: 'needs_you',
  epic_zombie: 'concierge',
  done_unmerged: 'concierge',
};

/**
 * TER-1148: a tab on the folder trust dialog waits on nobody but the person (the server already answers it
 * wherever it may), and its agent has not even started: past this long it opens as `needs_you`, whatever the
 * `tab_waiting` minutes say.
 */
export const TRUST_PROMPT_ALERT_MS = 2 * 60_000;

/** Tab states that wait on someone: a question, a permission, the folder trust dialog, a login. */
export const WAITING_STATES = ['waiting_input', 'waiting_permission', 'trust_prompt', 'auth_required'] as const;

/** Queue reasons that no wait ends: such a card never starts, so it does not make the queue stalled. */
export const STRUCTURAL_REASONS: readonly string[] = ['automation_off', 'paused', 'type_not_allowed'];

/** Queue reasons that end on their own in a minute or two: the card is about to start (TER-1110's wait). */
export const TRANSIENT_REASONS: readonly string[] = ['just_created'];

/** Run waits that are not an escalation: they resume on their own (quota back, GitHub back). */
export const SELF_RESUMING_WAITS = ['quota', 'github_transient'];

export interface SnapshotPr {
  url: string;
  repo: string;
  number: number;
  title: string;
  task_ref: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  ci_state: string;
  base_ref: string | null;
  merged_at: Date | null;
  deploy_state: string;
  deploy_url: string | null;
  release_runs: { workflow: string; state: string; url: string | null }[];
  /** why the merge executor holds it (a `merge_*` reason), when it does */
  wait: string | null;
  /** what the wait names besides its reason (the cards a held PR depends on, TER-1136); absent = nothing */
  wait_detail?: string | null;
}

export interface SnapshotTab {
  id: string;
  name: string;
  state: string | null;
  state_at: Date | null;
  machine_id: string;
  /** an automatic run drives it */
  run: boolean;
}

export interface SnapshotCard {
  task_id: string;
  ref: string;
  title: string;
  /** when the card last changed, or its last run ended, whichever is later */
  since: Date;
  tab_alive: boolean;
  active_run: boolean;
  /** its newest run's status, null without runs */
  latest_run: string | null;
  open_pr: boolean;
}

export interface SnapshotRun {
  id: string;
  task_id: string | null;
  ref: string | null;
  status: string;
  waiting_reason: string | null;
  ended_at: Date | null;
}

export interface SnapshotMachine {
  id: string;
  name: string;
  /** an agent machine (ssh machines have no live connection to tell) */
  agent: boolean;
  online: boolean;
  last_seen_at: Date | null;
  agent_version: string | null;
  /** an active run of this project sits on it (its tabs are in `HealthSnapshot.tabs`) */
  active_run: boolean;
}

/** TER-1150: an automatic epic in Fazendo, and what still keeps it alive. */
export interface SnapshotEpic {
  task_id: string;
  ref: string;
  title: string;
  /** the epic's or its cards' last change, or the last end of one of their runs, whichever is latest */
  since: Date;
  /** a card of the epic in Fazendo or with an active run */
  active_card: boolean;
  /** an open PR of the epic or of its cards, or the epic's merged PR still delivering */
  open_pr: boolean;
}

/** TER-1150: a card in Feito whose PR is still open (red, in conflict or just never merged). */
export interface SnapshotDoneUnmerged {
  task_id: string;
  ref: string;
  url: string;
  number: number;
  ci_state: string;
  /** when the card last changed: about when it was moved to Feito */
  since: Date;
}

export interface SnapshotQueued {
  task_id: string;
  ref: string;
  reason: string | null;
  reason_text: string | null;
  /** when the card last changed (put in A fazer, edited): how long it has waited at most */
  since: Date;
}

export interface HealthSnapshot {
  now: Date;
  /** the project's automatic work is on (and not paused) */
  automation: boolean;
  autonomy: AutonomyLevel;
  base_branch: string;
  prs: SnapshotPr[];
  /** the base branch's head as the merge executor last read it; null = not read lately */
  base: { state: 'green' | 'red' | 'pending'; sha: string | null; failing: string[] } | null;
  /** tagged cards in A fazer, in queue order */
  queued: SnapshotQueued[];
  active_runs: number;
  /** the newest start of a run in the project */
  last_run_at: Date | null;
  tabs: SnapshotTab[];
  doing: SnapshotCard[];
  runs: SnapshotRun[];
  machines: SnapshotMachine[];
  min_agent_version: string;
  /** TER-1150; absent from a snapshot built before it */
  epics?: SnapshotEpic[];
  done_unmerged?: SnapshotDoneUnmerged[];
}

const AUTONOMY_ORDER: AutonomyLevel[] = ['pr', 'merge', 'deploy', 'release'];
const mergesAlone = (a: AutonomyLevel) => AUTONOMY_ORDER.indexOf(a) >= AUTONOMY_ORDER.indexOf('merge');

/** Every sign the snapshot shows, before thresholds. Disabled signs are left out. */
export function observe(s: HealthSnapshot, config: ProjectHealth): Observation[] {
  if (!config.enabled) return [];
  const out: Observation[] = [];
  const on = (signal: HealthSignal) => config.signals[signal].enabled && (s.automation || LIGHT_SIGNALS.includes(signal));
  const add = (signal: HealthSignal, subject: string, since: Date | null, detail: HealthDetail, now = false, level: HealthLevel = LEVEL_OF[signal]) => {
    if (on(signal)) out.push({ signal, subject, level, since, detail, ...(now ? { now } : {}) });
  };

  // 1. a green PR, not a draft, still open while the autonomy lets termhub merge it. One held by policy for
  // a person (TER-1136) opens at once: waiting longer tells nothing more. The executor already pushed and woke
  // the chat about it, so the watcher shows it and stays quiet (`told_elsewhere`), as for a red base.
  if (mergesAlone(s.autonomy)) {
    for (const pr of s.prs) {
      if (pr.state !== 'open' || pr.draft || pr.ci_state !== 'passed') continue;
      const person = !!pr.wait && PERSON_WAITS.includes(pr.wait);
      add('pr_ready', pr.url, null, {
        label: `#${pr.number}`, url: pr.url, ref: pr.task_ref, title: pr.title, reason: pr.wait,
        ...(pr.wait_detail ? { cards: pr.wait_detail } : {}),
        ...(person ? { told_elsewhere: 1 } : {}),
      }, person);
    }
  }

  // 2. the base branch's head red, or never settling (a workflow queued with no runner). A red head that
  // holds a ready PR is escalated by the merge executor itself (TER-1120, push and wake once per base head):
  // the watcher shows it and stays quiet (`told_elsewhere`); a head that never settles is its own to tell.
  if (s.base && s.base.state !== 'green') {
    add('base_red', s.base_branch, null, {
      label: s.base_branch, state: s.base.state, sha: s.base.sha ? s.base.sha.slice(0, 7) : null, failing: s.base.failing.slice(0, 5).join(', ') || null,
      ...(s.base.state === 'red' ? { told_elsewhere: 1 } : {}),
    });
  }

  // 3. cards waiting in A fazer and nothing running, nothing started for a while. A type the Setup leaves out
  // never starts, however long it waits: it is not a stalled queue (TER-1143); a new card in its first minutes
  // is about to start. The sign lasts since the oldest card waits, or since the last start when that is newer:
  // a card put in A fazer a minute ago is no queue stalled for hours (TER-1146).
  const waiting = s.queued.filter((q) => !STRUCTURAL_REASONS.includes(q.reason ?? '') && !TRANSIENT_REASONS.includes(q.reason ?? ''));
  if (waiting.length > 0 && s.active_runs === 0) {
    const oldest = waiting.reduce((a, q) => (q.since < a ? q.since : a), waiting[0].since);
    add('queue_stalled', 'queue', s.last_run_at && s.last_run_at > oldest ? s.last_run_at : oldest, {
      label: String(waiting.length),
      cards: waiting.slice(0, 5).map((q) => (q.reason_text ? `${q.ref} (${q.reason_text})` : q.ref)).join('; '),
    });
  }

  // 4. a tab working with no event for a long while; a tab waiting on someone
  for (const tab of s.tabs) {
    if (!tab.state_at) continue;
    if (tab.state === 'working') add('tab_stuck', tab.id, tab.state_at, { label: tab.name, state: tab.state, run: tab.run ? 1 : 0 });
    else if (tab.state === 'trust_prompt') {
      // TER-1148: only the person can answer it, and nothing runs meanwhile — the person is pushed after 2 minutes
      const due = s.now.getTime() - tab.state_at.getTime() >= TRUST_PROMPT_ALERT_MS;
      add('tab_waiting', tab.id, tab.state_at, { label: tab.name, state: tab.state, run: tab.run ? 1 : 0 }, due, 'needs_you');
    } else if ((WAITING_STATES as readonly string[]).includes(tab.state ?? '')) add('tab_waiting', tab.id, tab.state_at, { label: tab.name, state: tab.state, run: tab.run ? 1 : 0 });
  }

  // 5. a card in Doing nobody works on: no tab, no run, no PR to wait for, not parked on a blocked run (6 says that)
  for (const c of s.doing) {
    if (c.tab_alive || c.active_run || c.open_pr || c.latest_run === 'blocked') continue;
    add('card_orphan', c.task_id, c.since, { label: c.ref, title: c.title });
  }

  // 6. a run escalated to the person, or blocked, still sitting there
  for (const r of s.runs) {
    const escalated = r.status === 'waiting' && !!r.waiting_reason && !SELF_RESUMING_WAITS.includes(r.waiting_reason);
    if (r.status !== 'blocked' && !escalated) continue;
    add('run_blocked', r.id, r.status === 'blocked' ? r.ended_at : null, { label: r.ref ?? r.id, status: r.status, reason: r.waiting_reason });
  }

  // 7. an agent machine offline while it holds this project's work; 9. one below the minimum agent
  for (const m of s.machines) {
    if (!m.agent) continue;
    if (!m.online && holdsWork(s, m, config)) add('machine_offline', m.id, m.last_seen_at, { label: m.name });
    if (m.online && m.agent_version && !versionAtLeast(m.agent_version, s.min_agent_version)) add('agent_outdated', m.id, null, { label: m.name, version: m.agent_version, min: s.min_agent_version });
  }

  // 8. the newest merge of each repository whose deploy or release failed, and nothing merged since
  const newest = new Map<string, SnapshotPr>();
  for (const pr of s.prs) {
    if (pr.state !== 'merged' || !pr.merged_at) continue;
    const seen = newest.get(pr.repo);
    if (!seen || (seen.merged_at && seen.merged_at < pr.merged_at)) newest.set(pr.repo, pr);
  }
  for (const pr of newest.values()) {
    if (pr.deploy_state === 'failed') add('delivery_failed', `${pr.url}#deploy`, null, { label: `#${pr.number}`, url: pr.deploy_url ?? pr.url, workflow: 'deploy', ref: pr.task_ref });
    for (const run of pr.release_runs) {
      if (run.state === 'failed') add('delivery_failed', `${pr.url}#${run.workflow}`, null, { label: `#${pr.number}`, url: run.url ?? pr.url, workflow: run.workflow, ref: pr.task_ref });
    }
  }

  // 10. an automatic epic in Fazendo with nothing alive under it: no card in progress, no PR, no delivery (TER-1150)
  for (const e of s.epics ?? []) {
    if (e.active_card || e.open_pr) continue;
    add('epic_zombie', e.task_id, e.since, { label: e.ref, title: e.title });
  }

  // 11. a card in Feito whose PR is still open: done on the board, not in the code (TER-1150)
  for (const d of s.done_unmerged ?? []) {
    add('done_unmerged', `${d.url}#${d.task_id}`, d.since, { label: d.ref, url: d.url, pr: `#${d.number}`, ci: d.ci_state });
  }
  return out;
}

/**
 * TER-1135: what counts as the project's work on a machine — an active run, or a tab with an event shortly
 * before the machine was last seen (within the `tab_stuck` minutes). A tab sitting in "trabalhando" with no
 * event for days is not work but its own sign (`tab_stuck`), and must not keep a machine alert alive.
 */
export function holdsWork(s: HealthSnapshot, m: SnapshotMachine, config: ProjectHealth): boolean {
  if (m.active_run) return true;
  const from = (m.last_seen_at ?? s.now).getTime() - config.signals.tab_stuck.minutes * 60_000;
  return s.tabs.some((t) => t.machine_id === m.id && !!t.state_at && t.state_at.getTime() >= from);
}

/**
 * TER-1135: signs whose subject flickers — a machine on a shaky Wi-Fi or going to sleep drops and comes back.
 * Gone from the snapshot, such an alert stays for this long before it resolves; seen again meanwhile, it is
 * the same episode (no new push, no new wake) and its `flaps` count goes up.
 */
export const FLAP_GRACE_MS: Partial<Record<HealthSignal, number>> = { machine_offline: 60 * 60_000 };

/** Whether an observed sign has lasted past its minutes. `since` falls back to the alert's first sighting. */
export function isDue(signal: HealthSignal, config: ProjectHealth, since: Date, now: Date): boolean {
  return now.getTime() - since.getTime() >= config.signals[signal].minutes * 60_000;
}
