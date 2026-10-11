import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { scoped } from '../auth/scope.js';
import { isAgentProvider, type AgentProvider } from '../ai/project-accounts.js';
import { auditBlocked, exclusiveError, usableIn } from '../ai/exclusive.js';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest } from '../lib/errors.js';
import { aiSchema, type ProjectAi } from './schema.js';
import { msg } from '../i18n/index.js';

/** One account the project may list: an account of the owner, on a machine linked to the project,
 *  of a provider `start_agent` can launch (spec 2026-09-30 project AI accounts §3). */
export interface ProjectAiOption {
  id: string;
  label: string;
  provider: AgentProvider;
  machine_id: string;
  machine_name: string;
  /** the machine's own login (no config dir override) */
  default: boolean;
  /** TER-990: the project the account is exclusive to; another project's Setup shows it disabled */
  exclusive_project: { id: string; name: string } | null;
}

export interface ProjectAiView {
  ai: ProjectAi;
  available: ProjectAiOption[];
}

export const projectAiBody = z.object({ ai: aiSchema });

async function options(repos: Repositories, request: FastifyRequest, projectId: string): Promise<ProjectAiOption[]> {
  const { machines } = await scoped(repos, request).projectMachines(projectId);
  const accounts = await repos.aiAccounts.list(request.scope.ownerId);
  return machines.flatMap(({ machine }) =>
    accounts
      .filter((a) => a.machine_id === machine.id)
      .flatMap((a) => (isAgentProvider(a.provider) ? [{ id: a.id, label: a.label, provider: a.provider, machine_id: machine.id, machine_name: machine.name, default: a.config_dir === null, exclusive_project: a.exclusive_project }] : [])),
  );
}

/** The project's `ai` block and what it may list. 404 outside the scope. */
export async function describeProjectAi(repos: Repositories, request: FastifyRequest, projectId: string): Promise<ProjectAiView> {
  const available = await options(repos, request, projectId);
  const setup = await repos.projectSetup.get(projectId);
  return { ai: setup.data.ai, available };
}

/**
 * Saves the `ai` block alone (the rest of the setup is untouched). Every listed account is checked
 * through the scope, one 400 naming the first that cannot be listed; nothing is saved then. An account
 * exclusive to another project (TER-990) is refused when it is being added, and dropped when the block
 * already listed it from before it became exclusive (every path skips it anyway), so the rest saves.
 */
export async function saveProjectAi(repos: Repositories, request: FastifyRequest, projectId: string, ai: ProjectAi): Promise<ProjectAiView> {
  const s = scoped(repos, request);
  const available = await options(repos, request, projectId);
  const allowed = new Set(available.map((o) => o.id));
  const current = await repos.projectSetup.get(projectId);
  const before = new Set(current.data.ai.accounts);
  const dropped = new Set<string>();
  for (const id of ai.accounts) {
    const option = available.find((o) => o.id === id);
    if (option && !usableIn(option, projectId)) {
      if (before.has(id)) {
        dropped.add(id);
        continue;
      }
      await auditBlocked(repos, request.log, option, { project_id: projectId, path: 'project_setup' });
      throw badRequest(exclusiveError(option).localized);
    }
    if (allowed.has(id)) continue;
    const found = await s.aiAccount(id).catch(() => null);
    if (!found) throw badRequest(msg('Conta de IA inexistente: {{id}}', { id }));
    if (!isAgentProvider(found.account.provider)) throw badRequest(msg('A conta "{{account}}" é {{provider}}: o projeto só usa contas do Claude e do Codex', { account: found.account.label, provider: found.account.provider }));
    throw badRequest(msg('A conta "{{account}}" está na máquina {{machine}}, que não está ligada ao projeto', { account: found.account.label, machine: found.machine.name }));
  }
  const saved = await repos.projectSetup.save(projectId, { ...current.data, ai: { ...ai, accounts: ai.accounts.filter((id) => !dropped.has(id)) } });
  return { ai: saved.data.ai, available };
}
