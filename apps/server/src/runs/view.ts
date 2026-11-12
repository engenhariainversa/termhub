import type { ApiRun } from '../db/repositories/api-runs.js';
import type { Repositories } from '../db/repositories/index.js';
import { Scoped } from '../auth/scope.js';
import type { User } from '../db/repositories/types.js';
import { notFound } from '../lib/errors.js';

/**
 * A run as the API answers it (spec "Contract", `GET /runs/:id`): the account by its label only, never
 * its config dir; the error as `{ code, message }`. Never the prompt, which is not stored.
 */
export interface RunView {
  id: string;
  project_id: string;
  status: ApiRun['status'];
  provider: string | null;
  model: string | null;
  capabilities: string[];
  machine: { id: string; name: string | null } | null;
  account: string | null;
  workspace: ApiRun['workspace'];
  result: string | null;
  usage: ApiRun['usage'];
  error: { code: string; message: string | null } | null;
  timeout_s: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  events_url: string;
}

export function toRunView(run: ApiRun): RunView {
  return {
    id: run.id,
    project_id: run.project_id,
    status: run.status,
    provider: run.provider,
    model: run.model,
    capabilities: run.capabilities,
    machine: run.machine_id ? { id: run.machine_id, name: run.machine_name } : null,
    account: run.account_label,
    workspace: run.workspace,
    result: run.result,
    usage: run.usage,
    error: run.error_code ? { code: run.error_code, message: run.error_message } : null,
    timeout_s: Math.round(run.timeout_ms / 1000),
    created_at: run.created_at,
    started_at: run.started_at,
    ended_at: run.ended_at,
    events_url: `/api/v1/runs/${run.id}/events`,
  };
}

/**
 * The project a run request names, by id or by key ("TER", case-insensitive), owned by `user` itself:
 * never "view as", never someone else's project, even for an admin. A miss is a 404.
 */
export async function ownProject(repos: Repositories, user: User, ref: string): Promise<{ id: string; key: string; name: string }> {
  const own = new Scoped(repos, { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id });
  const byKey = /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(ref) ? await repos.projects.findByKey(ref.toUpperCase()) : undefined;
  if (byKey) {
    if (!own.owns(byKey.owner_id)) throw notFound('Projeto não encontrado');
    return byKey;
  }
  const { project } = await own.project(ref);
  return project;
}
