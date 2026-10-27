import type { IneligibleReason } from './eligibility.js';

/** Why a card's green PR is not merged yet: what the merge executor saw on its last pass (spec §10.1). */
export type MergeWait = Extract<IneligibleReason, `merge_${string}`>;

/** Shown while this fresh: a few CI syncs (60 s each). Past that the executor no longer holds the PR. */
export const MERGE_WAIT_TTL_MS = 3 * 60_000;

/** A wait and the PR head it is about, when that head is what the text names (TER-1016: "conflito em a058efd"). */
export interface MergeWaitEntry {
  wait: MergeWait;
  sha: string | null;
}

/**
 * Per process, like the dispatcher's waiting reasons (`placement.ts`): the executor writes it on every pass
 * and nothing is stored per sync; a restart clears it and the next pass fills it again.
 */
const waits = new Map<string, MergeWaitEntry & { at: number }>();

export function noteMergeWait(taskIds: string[], wait: MergeWait, now: Date, sha: string | null = null): void {
  for (const id of taskIds) waits.set(id, { wait, sha, at: now.getTime() });
}

export function clearMergeWait(taskIds: string[]): void {
  for (const id of taskIds) waits.delete(id);
}

export function mergeWaitEntryOf(taskId: string, now: Date = new Date()): MergeWaitEntry | null {
  const w = waits.get(taskId);
  if (!w) return null;
  if (now.getTime() - w.at > MERGE_WAIT_TTL_MS) {
    waits.delete(taskId);
    return null;
  }
  return { wait: w.wait, sha: w.sha };
}

export function mergeWaitOf(taskId: string, now: Date = new Date()): MergeWait | null {
  return mergeWaitEntryOf(taskId, now)?.wait ?? null;
}

/** Tests only. */
export function resetMergeWaits(): void {
  waits.clear();
}

/** TER-1121: the base branch's head as the merge executor last read it, per project, for the health watcher. */
export interface BaseReading {
  state: 'green' | 'red' | 'pending';
  sha: string | null;
  /** the workflows failing (red) or not done yet (pending) on it, by name */
  failing: string[];
  at: number;
}

/** Kept this long: past it the executor stopped reading the base (no PR waits on it) and nothing is told. */
export const BASE_READING_TTL_MS = 15 * 60_000;

const bases = new Map<string, BaseReading>();

export function noteBaseReading(projectId: string, reading: Omit<BaseReading, 'at'>, now: Date = new Date()): void {
  bases.set(projectId, { ...reading, at: now.getTime() });
}

export function baseReadingOf(projectId: string, now: Date = new Date()): BaseReading | null {
  const b = bases.get(projectId);
  if (!b || now.getTime() - b.at > BASE_READING_TTL_MS) return null;
  return b;
}

/** Tests only. */
export function resetBaseReadings(): void {
  bases.clear();
}
