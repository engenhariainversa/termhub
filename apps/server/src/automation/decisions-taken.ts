import { defaultEmbedder, type Embedder } from '../chat/embeddings.js';
import { NOTES_PER_HOUR } from '../control/memory.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { Repositories } from '../db/repositories/index.js';
import { indexNote, type MemoryDeps } from '../memory/index-items.js';
import { recordEvent } from './events.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

/** One decision an automatic run took alone (TER-1043), as the agent reports it in `report_card`. */
export interface TakenDecision {
  question: string;
  options?: string;
  choice: string;
  reason: string;
}

/** At most this many decisions per `report_card`. */
export const DECISIONS_MAX = 10;
/** The feed's summary of one decision: question → choice, cut to this. */
export const DECISION_SUMMARY_MAX = 300;

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "<question> → <choice>", on one line, at most DECISION_SUMMARY_MAX characters. */
export function decisionSummary(d: Pick<TakenDecision, 'question' | 'choice'>): string {
  return clip(`${oneLine(d.question)} → ${oneLine(d.choice)}`, DECISION_SUMMARY_MAX);
}

/**
 * The decisions a run reported (TER-1043 §4), so the person can review them later: each one goes to the feed
 * and the daily summary as `decided_by_recommendation` (`via: 'agent'`, with its summary — the agent's own
 * words for the person, like `report_card`'s reason, never the tab's screen) and becomes a memory note (trust
 * `derived`, the project owner's, citing the card) that `search_memory` finds as a precedent next time. Notes
 * stop at the owner's NOTES_PER_HOUR. Best effort: a failed write is logged by id and never fails the report.
 */
export async function recordTakenDecisions(
  repos: Repositories,
  run: AutomationRun,
  decisions: TakenDecision[],
  deps: { embedder?: Embedder | null; log: Log; now?: () => Date },
): Promise<number> {
  if (decisions.length === 0) return 0;
  let recorded = 0;
  try {
    const [project, task] = await Promise.all([repos.projects.findById(run.project_id), run.task_id ? repos.tasks.findById(run.task_id) : undefined]);
    const ownerId = project?.owner_id ?? null;
    const now = deps.now?.() ?? new Date();
    let room = ownerId ? NOTES_PER_HOUR - (await repos.memoryItems.countNotesSince(ownerId, new Date(now.getTime() - 3_600_000))) : 0;
    const embedder = deps.embedder !== undefined ? deps.embedder : defaultEmbedder();
    for (const d of decisions.slice(0, DECISIONS_MAX)) {
      await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'decided_by_recommendation', payload: { via: 'agent', tab_id: run.tab_id, summary: decisionSummary(d) } });
      recorded++;
      if (!ownerId || room <= 0) continue;
      room--;
      await indexNote(
        repos,
        {
          owner_id: ownerId,
          project_id: run.project_id,
          question: task ? `${task.ref}: ${d.question}` : d.question,
          decision: d.options ? `${d.choice} (opções: ${d.options})` : d.choice,
          reason: d.reason,
          sources: run.task_id ? [`task:${run.task_id}`] : [],
        },
        { embedder, log: deps.log as unknown as MemoryDeps['log'] },
      );
    }
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    deps.log.warn({ runId: run.id, code: typeof code === 'string' ? code.slice(0, 64) : 'INTERNAL' }, 'automation: decisions not all recorded');
  }
  return recorded;
}
