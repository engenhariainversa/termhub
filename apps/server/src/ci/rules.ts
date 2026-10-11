import type { CiState, CiSummary } from '../db/repositories/task-pull-requests.js';

/** The fields of a GitHub Actions workflow run the panel reads. */
export interface WorkflowRun {
  id: number;
  name: string;
  path: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  /** When the run last changed (its end, for a finished one); absent in older fixtures. */
  updated_at?: string;
}

export const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const MAX_FAILING = 5;

/** Card numbers of `key` refs ("TER-183", any case) in a PR's branch, title and body (spec D13). */
export function refsIn(texts: Array<string | null>, key: string): number[] {
  const re = new RegExp(`(?<![A-Za-z0-9])${key}-(\\d+)(?!\\d)`, 'gi');
  const found = new Set<number>();
  for (const text of texts) for (const m of (text ?? '').matchAll(re)) found.add(Number(m[1]));
  return [...found];
}

/** A re-run is a newer run of the same workflow file: only the latest one counts. */
export function latestPerWorkflow(runs: WorkflowRun[]): WorkflowRun[] {
  const byPath = new Map<string, WorkflowRun>();
  for (const r of runs) {
    const cur = byPath.get(r.path);
    if (!cur || r.created_at > cur.created_at || (r.created_at === cur.created_at && r.id > cur.id)) byPath.set(r.path, r);
  }
  return [...byPath.values()];
}

function stateOf(runs: WorkflowRun[]): CiState {
  if (runs.length === 0) return 'none';
  if (runs.some((r) => r.status !== 'completed')) return 'running';
  if (runs.some((r) => FAILED.has(r.conclusion ?? ''))) return 'failed';
  return 'passed';
}

export function ciOf(runs: WorkflowRun[]): { state: CiState; summary: CiSummary } {
  const latest = latestPerWorkflow(runs);
  const running = latest.filter((r) => r.status !== 'completed');
  const failed = latest.filter((r) => r.status === 'completed' && FAILED.has(r.conclusion ?? ''));
  return {
    state: stateOf(latest),
    summary: {
      total: latest.length,
      running: running.length,
      failed: failed.length,
      passed: latest.length - running.length - failed.length,
      failing: failed.map((r) => r.name).slice(0, MAX_FAILING),
    },
  };
}

/** Whether a run is of `workflow`, named in a setup by its display name, its path or its file name. */
export const matchesWorkflow = (r: WorkflowRun, workflow: string): boolean => r.name === workflow || r.path === workflow || r.path.endsWith(`/${workflow}`);

/** The deploy: the latest run of the setup's workflow, matched by file name or display name. */
export function deployOf(runs: WorkflowRun[], workflow: string | null): { state: CiState; url: string | null; run: WorkflowRun | null } {
  if (!workflow) return { state: 'none', url: null, run: null };
  // A cancelled deploy was superseded by a newer one (deploy workflows use cancel-in-progress), so it is
  // not a failure: the merge's code ships with the next run. CI (`ciOf`) keeps cancelled = failed.
  const mine = latestPerWorkflow(runs.filter((r) => matchesWorkflow(r, workflow))).filter(
    (r) => r.conclusion !== 'cancelled',
  );
  if (mine.length === 0) return { state: 'none', url: null, run: null };
  return { state: stateOf(mine), url: mine[0].html_url, run: mine[0] };
}
