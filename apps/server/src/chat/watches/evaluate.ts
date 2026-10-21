/**
 * TER-1099: whether a watch caught something. Each kind compares the target's state now with the watch's
 * baseline (the state when it was created, then after each fire): a change that happened while the server
 * was restarting is still a change on the next sweep, so nothing is lost and nothing needs replaying. A
 * tab is read from its persisted state events (`tab_events`), so even a stop that already ended is caught.
 *
 * Pure apart from the `WatchProbe` reads; the engine writes what `evaluateWatch` answers.
 */
import type { CiState, TaskPullRequest } from '../../db/repositories/task-pull-requests.js';
import type { ChatWatch } from '../../db/repositories/chat-watches.js';
import type { TabState } from '../../db/repositories/types.js';
import { versionAtLeast } from '../../agent/errors.js';
import { SEMVER, TAB_EVENTS, WATCH_LIMITS, type CardStatus, type WatchStatus } from './kinds.js';

/** How long a machine must stay offline before `offline` fires: a deploy moves every agent between colours. */
export const OFFLINE_GRACE_MS = 3 * 60_000;

export interface ProbeTab {
  id: string;
  name: string;
  project_id: string;
  machine_id: string;
  state: TabState | null;
}
export interface ProbeTask {
  id: string;
  ref: string;
  title: string;
  project_id: string;
  column_id: string | null;
  status: CardStatus;
}
export interface ProbeMachine {
  id: string;
  name: string;
  online: boolean;
  /** How long it has been offline as this process sees it; null while online. */
  offline_for_ms: number | null;
}

/** The reads a watch is evaluated with. Scoped by the ids the watch was created with (checked then, owner-scoped). */
export interface WatchProbe {
  tab(id: string): Promise<ProbeTab | null>;
  tabEventsAfter(tabId: string, after: Date, kinds: readonly TabState[]): Promise<{ id: string; kind: TabState; created_at: string }[]>;
  task(id: string): Promise<ProbeTask | null>;
  pullRequests(watch: Pick<ChatWatch, 'user_id' | 'target_id' | 'params'>): Promise<TaskPullRequest[]>;
  machine(id: string): Promise<ProbeMachine | null>;
  latestAgentVersion(): Promise<string | null>;
}

export interface CaughtEvent {
  key: string;
  event: string;
  payload: Record<string, unknown>;
}

/** What a watch caught, and its state after it. `events` empty with a new baseline: a silent update. */
export interface Evaluation {
  events: CaughtEvent[];
  baseline: Record<string, unknown>;
  close: WatchStatus | null;
}

type Watch = Pick<ChatWatch, 'id' | 'user_id' | 'kind' | 'target_id' | 'params' | 'baseline' | 'recurring' | 'created_at' | 'fire_count'>;

const wants = (w: Watch, event: string) => w.params.events.includes(event);
const done = (w: Watch): WatchStatus | null => (w.recurring ? null : 'done');

/** What a PR's baseline keeps of it: enough to tell each of its events from the previous state. */
export interface PrSnap {
  state: string;
  ci_state: CiState;
  head_sha: string;
  deploy_state: CiState;
  merge_sha: string | null;
  releases: Record<string, CiState>;
}
export const prSnap = (p: TaskPullRequest): PrSnap => ({
  state: p.state,
  ci_state: p.ci_state,
  head_sha: p.head_sha,
  deploy_state: p.deploy_state,
  merge_sha: p.merge_commit_sha,
  releases: Object.fromEntries(p.release_runs.map((r) => [r.workflow, r.state])),
});
/** One row per PR (a PR naming several cards has one row each). */
const byUrl = (rows: TaskPullRequest[]): Map<string, TaskPullRequest> => {
  const out = new Map<string, TaskPullRequest>();
  for (const r of rows) if (!out.has(r.url)) out.set(r.url, r);
  return out;
};
export const prBaseline = (rows: TaskPullRequest[]): Record<string, unknown> => ({ prs: Object.fromEntries([...byUrl(rows)].map(([url, p]) => [url, prSnap(p)])) });

/** The baseline a new watch starts from: the target's state now. */
export async function initialBaseline(probe: WatchProbe, w: Pick<ChatWatch, 'user_id' | 'kind' | 'target_id' | 'params'>, now: Date): Promise<Record<string, unknown>> {
  switch (w.kind) {
    case 'tab':
      return { cursor: now.toISOString() };
    case 'card': {
      const t = w.target_id ? await probe.task(w.target_id) : null;
      return { column_id: t?.column_id ?? null, status: t?.status ?? null };
    }
    case 'pr':
      return prBaseline(await probe.pullRequests(w));
    case 'machine': {
      const m = w.target_id ? await probe.machine(w.target_id) : null;
      return { online: m?.online ?? false };
    }
    case 'agent_release':
      return { seen: await probe.latestAgentVersion() };
  }
}

export async function evaluateWatch(probe: WatchProbe, w: Watch): Promise<Evaluation | null> {
  switch (w.kind) {
    case 'tab':
      return evaluateTab(probe, w);
    case 'card':
      return evaluateCard(probe, w);
    case 'pr':
      return evaluatePr(probe, w);
    case 'machine':
      return evaluateMachine(probe, w);
    case 'agent_release':
      return evaluateAgentRelease(probe, w);
  }
}

const gone = (w: Watch, payload: Record<string, unknown>): Evaluation => ({ events: [{ key: 'gone', event: 'gone', payload }], baseline: w.baseline, close: 'gone' });

async function evaluateTab(probe: WatchProbe, w: Watch): Promise<Evaluation | null> {
  const tabId = w.target_id!;
  const tab = await probe.tab(tabId);
  // Closed, or its session died and the tab went with it: always told, whatever the events asked.
  if (!tab) return gone(w, { tab_id: tabId });
  const cursor = new Date(typeof w.baseline.cursor === 'string' ? w.baseline.cursor : w.created_at);
  const kinds = w.params.events.filter((e): e is TabState => e !== 'gone' && (TAB_EVENTS as readonly string[]).includes(e));
  const events = await probe.tabEventsAfter(tabId, cursor, kinds);
  if (events.length === 0) return null;
  // Once: the first stop after the watch began is the one asked about. Recurring: the newest, since a
  // cooldown may have let several pass.
  const ev = w.recurring ? events[events.length - 1] : events[0];
  return {
    events: [{ key: `tab:${ev.id}`, event: ev.kind, payload: { tab_id: tab.id, tab_name: tab.name, project_id: tab.project_id, machine_id: tab.machine_id, state: ev.kind, at: ev.created_at, state_now: tab.state } }],
    baseline: { cursor: ev.created_at },
    close: done(w),
  };
}

async function evaluateCard(probe: WatchProbe, w: Watch): Promise<Evaluation | null> {
  const taskId = w.target_id!;
  const t = await probe.task(taskId);
  if (!t) return gone(w, { task_id: taskId });
  const from = { column_id: (w.baseline.column_id as string | null) ?? null, status: (w.baseline.status as string | null) ?? null };
  if (t.column_id === from.column_id && t.status === from.status) return null;
  const baseline = { column_id: t.column_id, status: t.status };
  if (!wants(w, 'moved') || (w.params.to && t.status !== w.params.to)) return { events: [], baseline, close: null };
  return {
    events: [{ key: `card:${t.column_id ?? 'backlog'}:${t.status}:${w.fire_count}`, event: 'moved', payload: { task_id: t.id, ref: t.ref, title: t.title, project_id: t.project_id, from_status: from.status, to_status: t.status } }],
    baseline,
    close: done(w),
  };
}

async function evaluatePr(probe: WatchProbe, w: Watch): Promise<Evaluation | null> {
  const rows = byUrl(await probe.pullRequests(w));
  const before = (w.baseline.prs ?? {}) as Record<string, PrSnap>;
  const events: CaughtEvent[] = [];
  for (const [url, p] of rows) {
    const prev = before[url] as PrSnap | undefined;
    const base = { pr_url: url, number: p.number, title: p.title, repo: p.repo, task_id: p.task_id, project_id: p.project_id };
    const add = (event: string, key: string, extra: Record<string, unknown> = {}) => {
      if (wants(w, event)) events.push({ key: `${url}:${key}`, event, payload: { ...base, ...extra } });
    };
    // `opened` only for a card's PRs: a PR watched by its URL already exists.
    if (!prev && !w.params.pr_url && p.state === 'open') add('opened', 'opened', { head_ref: p.head_ref });
    if (p.state === 'merged' && prev?.state !== 'merged') add('merged', 'merged', { merge_sha: p.merge_commit_sha });
    if (p.state === 'closed' && prev?.state !== 'closed') add('closed', `closed:${p.head_sha}`);
    const sameSha = prev?.head_sha === p.head_sha;
    if (p.ci_state === 'failed' && !(sameSha && prev?.ci_state === 'failed')) add('ci_failed', `ci_failed:${p.head_sha}`, { head_sha: p.head_sha, failing: p.ci_summary.failing });
    if (p.ci_state === 'passed' && !(sameSha && prev?.ci_state === 'passed')) add('ci_passed', `ci_passed:${p.head_sha}`, { head_sha: p.head_sha });
    const sha = p.merge_commit_sha ?? p.head_sha;
    if (p.deploy_state === 'passed' && prev?.deploy_state !== 'passed') add('deploy_ok', `deploy_ok:${sha}`, { deploy_url: p.deploy_url });
    if (p.deploy_state === 'failed' && prev?.deploy_state !== 'failed') add('deploy_failed', `deploy_failed:${sha}`, { deploy_url: p.deploy_url });
    for (const r of p.release_runs) {
      if (w.params.workflow && r.workflow !== w.params.workflow) continue;
      const was = prev?.releases?.[r.workflow];
      const extra = { workflow: r.workflow, version: r.version, run_url: r.url };
      if (r.state === 'passed' && was !== 'passed') add('release_ok', `release_ok:${r.workflow}:${sha}`, extra);
      if (r.state === 'failed' && was !== 'failed') add('release_failed', `release_failed:${r.workflow}:${sha}`, extra);
    }
  }
  const baseline = prBaseline([...rows.values()]);
  if (events.length === 0) return JSON.stringify(baseline) === JSON.stringify({ prs: before }) ? null : { events: [], baseline, close: null };
  return { events, baseline, close: done(w) };
}

async function evaluateMachine(probe: WatchProbe, w: Watch): Promise<Evaluation | null> {
  const machineId = w.target_id!;
  const m = await probe.machine(machineId);
  if (!m) return gone(w, { machine_id: machineId });
  const was = w.baseline.online === true;
  const payload = { machine_id: m.id, machine_name: m.name };
  if (m.online && !was) {
    return wants(w, 'online')
      ? { events: [{ key: `online:${w.fire_count}`, event: 'online', payload }], baseline: { online: true }, close: done(w) }
      : { events: [], baseline: { online: true }, close: null };
  }
  // Offline only once it lasted: an agent moving between colours during a deploy is back within seconds.
  if (!m.online && was && (m.offline_for_ms ?? 0) >= OFFLINE_GRACE_MS) {
    return wants(w, 'offline')
      ? { events: [{ key: `offline:${w.fire_count}`, event: 'offline', payload }], baseline: { online: false }, close: done(w) }
      : { events: [], baseline: { online: false }, close: null };
  }
  return null;
}

async function evaluateAgentRelease(probe: WatchProbe, w: Watch): Promise<Evaluation | null> {
  const min = w.params.version;
  const latest = await probe.latestAgentVersion();
  if (!min || !latest || !SEMVER.test(latest) || !SEMVER.test(min) || !versionAtLeast(latest, min)) return null;
  // Recurring: each newer version once. Once: as soon as one at or above the minimum is on npm.
  const seen = typeof w.baseline.seen === 'string' && SEMVER.test(w.baseline.seen) ? w.baseline.seen : null;
  if (w.recurring && seen && versionAtLeast(seen, latest)) return null;
  return { events: [{ key: `agent:${latest}`, event: 'published', payload: { package: '@termhub/agent', version: latest, min_version: min } }], baseline: { seen: latest }, close: done(w) };
}

/** The `expired` event a watch whose validity ran out sends once, closing it. */
export function expiredEvaluation(w: Pick<ChatWatch, 'baseline' | 'expires_at'>): Evaluation {
  return { events: [{ key: 'expired', event: 'expired', payload: { expires_at: w.expires_at } }], baseline: w.baseline, close: 'expired' };
}

/** The cooldown a recurring watch's fire must respect (one-shot watches fire once anyway). */
export const cooldownOf = (w: Pick<ChatWatch, 'recurring'>): number | undefined => (w.recurring ? WATCH_LIMITS.recurringCooldownMs : undefined);
