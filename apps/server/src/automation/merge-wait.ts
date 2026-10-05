import type { IneligibleReason } from './eligibility.js';

/** Why a card's green PR is not merged yet: what the merge executor saw on its last pass (spec §10.1). */
export type MergeWait = Extract<IneligibleReason, `merge_${string}`>;

/** Shown while this fresh: a few CI syncs (60 s each). Past that the executor no longer holds the PR. */
export const MERGE_WAIT_TTL_MS = 3 * 60_000;

/**
 * Per process, like the dispatcher's waiting reasons (`placement.ts`): the executor writes it on every pass
 * and nothing is stored per sync; a restart clears it and the next pass fills it again.
 */
const waits = new Map<string, { wait: MergeWait; at: number }>();

export function noteMergeWait(taskIds: string[], wait: MergeWait, now: Date): void {
  for (const id of taskIds) waits.set(id, { wait, at: now.getTime() });
}

export function clearMergeWait(taskIds: string[]): void {
  for (const id of taskIds) waits.delete(id);
}

export function mergeWaitOf(taskId: string, now: Date = new Date()): MergeWait | null {
  const w = waits.get(taskId);
  if (!w) return null;
  if (now.getTime() - w.at > MERGE_WAIT_TTL_MS) {
    waits.delete(taskId);
    return null;
  }
  return w.wait;
}

/** Tests only. */
export function resetMergeWaits(): void {
  waits.clear();
}
