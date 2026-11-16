import type { Repositories } from '../db/repositories/index.js';
import type { QueueItem } from './queue.js';

/** What the wake names (TER-1068): the project, and the cards (ids, refs, titles: the person's own words). */
export interface RepoUnknownWake {
  ownerId: string;
  projectId: string;
  cards: { id: string; ref: string; title: string }[];
}

/** At most this many cards are named in one wake; the rest are named by the next ticks. */
export const REPO_UNKNOWN_NAMED_MAX = 10;
/** After a wake that did not start (hourly budget, no owner), the next try waits this long. */
export const REPO_UNKNOWN_RETRY_MS = 5 * 60_000;

/** Per instance: cards already told (claimed here or seen claimed), and when a project may be tried again. */
const told = new Set<string>();
const retryAt = new Map<string, number>();

/** Tests only. */
export function resetRepoUnknownState(): void {
  told.clear();
  retryAt.clear();
}

export interface RepoUnknownDeps {
  repos: Pick<Repositories, 'tasks' | 'automationEvents'>;
  now(): Date;
  /** a card in its first minutes is left to whoever is creating it (the form, the concierge) */
  graceMs: number;
  wake?: (i: RepoUnknownWake) => Promise<boolean>;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

/**
 * Spec 2026-10-07 multi-repo R9 b: an automatic card left without repositories in a multi-repo project (the
 * queue's `repo_unknown`, made by hand on the board for example) wakes the project's chat once, so the concierge
 * infers them or asks. Each card is claimed with an `automation_events` row of kind `repo_unknown` under the
 * once-only index `automation_events_repo_unknown_once`, so two colours never name the same card twice. The
 * cards this pass claimed go into one wake, under the automation's hourly budget (`chat/wake.ts`); when the wake
 * does not start, the claims are given back and the project waits `REPO_UNKNOWN_RETRY_MS` before the next try.
 */
export async function askForRepos(deps: RepoUnknownDeps, project: { id: string; owner_id: string }, items: readonly QueueItem[]): Promise<void> {
  if (!deps.wake) return;
  const now = deps.now().getTime();
  const unknown = items.filter((i) => i.reason === 'repo_unknown' && !told.has(i.task_id));
  if (unknown.length === 0 || (retryAt.get(project.id) ?? 0) > now) return;
  const { repos } = deps;
  const claimed: { event: string; card: RepoUnknownWake['cards'][number] }[] = [];
  for (const item of unknown) {
    if (claimed.length >= REPO_UNKNOWN_NAMED_MAX) break;
    const task = await repos.tasks.findById(item.task_id);
    if (!task || now - new Date(task.created_at).getTime() < deps.graceMs) continue;
    // already told (by the other colour, or before a restart): no insert that would only hit the index
    if (await repos.automationEvents.findOnce(task.id, 'repo_unknown', {})) {
      remember(task.id);
      continue;
    }
    const row = await repos.automationEvents.insertOnce({ project_id: project.id, task_id: task.id, kind: 'repo_unknown', payload: { ref: task.ref } });
    remember(task.id);
    if (row) claimed.push({ event: row.id, card: { id: task.id, ref: task.ref, title: task.title } });
  }
  if (claimed.length === 0) return;
  const woke = await deps.wake({ ownerId: project.owner_id, projectId: project.id, cards: claimed.map((c) => c.card) }).catch(() => false);
  if (!woke) {
    for (const c of claimed) {
      await repos.automationEvents.remove(c.event);
      told.delete(c.card.id);
    }
    retryAt.set(project.id, now + REPO_UNKNOWN_RETRY_MS);
  }
  deps.log.info({ projectId: project.id, cards: claimed.length, woke }, 'automation: chat woken for cards without a repository');
}

function remember(taskId: string): void {
  if (told.size > 10_000) told.clear();
  told.add(taskId);
}
