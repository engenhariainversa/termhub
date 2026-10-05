import type { Integration, IntegrationProvider } from '../db/repositories/integrations.js';
import { getProvider } from '../integrations/index.js';
import { readMachineSecret, type SecretSource } from '../integrations/machine-secret.js';
import { encryptionAvailable } from '../lib/crypto.js';
import { repoSchema, setupInputSchema, type ProjectSetupData } from '../setup/schema.js';
import { ControlError, type ControlContext } from './context.js';

/** The config keys that may leave the server: who the integration logs in as, and Jira's site (spec D7). */
const PUBLIC_CONFIG_KEYS = ['login', 'baseUrl', 'email'] as const;

/** An integration as the tools return it: never the secret, and only the known public config keys. */
export interface IntegrationOut {
  id: string;
  provider: IntegrationProvider;
  name: string;
  config: Record<string, unknown>;
  created_at: string;
}

function integrationOut(i: Integration): IntegrationOut {
  const config: Record<string, unknown> = {};
  for (const k of PUBLIC_CONFIG_KEYS) if (i.config[k] !== undefined) config[k] = i.config[k];
  return { id: i.id, provider: i.provider, name: i.name, config, created_at: i.created_at };
}

/** `owner/repo`, the same shape the setup schema takes, and no `.`/`..` segment. */
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const validRepo = (s: string) => REPO_RE.test(s) && s.split('/').every((part) => part !== '.' && part !== '..');

export async function listIntegrations(ctx: ControlContext, input: { provider?: IntegrationProvider }): Promise<{ integrations: IntegrationOut[] }> {
  const all = await ctx.repos.integrations.list(ctx.scope.ownerId);
  return { integrations: all.filter((i) => !input.provider || i.provider === input.provider).map(integrationOut) };
}

/**
 * Creates a GitHub integration from the `gh` login of one of the caller's machines (spec D1–D3): the
 * token is read by the server from the machine's agent, never taken as an argument, tested against
 * GitHub before anything is saved, and stored encrypted with `config.login` like the web screen does.
 * No message here carries the token or GitHub's answer body — only its HTTP status.
 */
export async function createIntegration(
  ctx: ControlContext,
  input: { provider: 'github'; name: string; secret_from: { machine_id: string; source: SecretSource } },
): Promise<IntegrationOut & { account: string | null }> {
  if (input.provider !== 'github') throw new ControlError('INTEGRATION_NOT_ALLOWED', 'Pelo chat só dá para criar integrações do GitHub; as outras são criadas na tela Integrações');
  if (!encryptionAvailable()) throw new ControlError('ENCRYPTION_UNAVAILABLE', 'O servidor não tem ENCRYPTION_KEY configurada, então não pode guardar o token');
  const machine = await ctx.scoped.machine(input.secret_from.machine_id);
  const secret = await readMachineSecret(machine, input.secret_from.source);
  const test = await getProvider('github').testConnection(secret, {});
  if (!test.ok) {
    const status = /^GitHub (\d{3})\b/.exec(test.error ?? '')?.[1];
    throw new ControlError(
      'INTEGRATION_TEST_FAILED',
      status
        ? `O GitHub recusou o token do gh da máquina ${machine.name} (HTTP ${status}); nada foi salvo`
        : `Não consegui falar com o GitHub para testar o token da máquina ${machine.name}; nada foi salvo`,
    );
  }
  const account = test.account ?? null;
  const integration = await ctx.repos.integrations.create({
    provider: 'github',
    name: input.name,
    config: account ? { login: account } : {},
    secret,
    owner_id: ctx.scope.createAs,
  });
  return { ...integrationOut(integration), account };
}

type RepoBlock = NonNullable<ProjectSetupData['repo']>;

/** The integration a repo block names, if it is still in scope. */
async function repoIntegration(ctx: ControlContext, repo: RepoBlock | null): Promise<IntegrationOut | null> {
  if (!repo?.integration_id) return null;
  const i = await ctx.scoped.integration(repo.integration_id).catch(() => null);
  return i ? integrationOut(i) : null;
}

/** The project's repository setup (integration, `owner/repo`, base branch, deploy workflow). */
export async function getProjectSetup(ctx: ControlContext, input: { project_id: string }): Promise<{ project_id: string; repo: RepoBlock | null; automation: ProjectSetupData['automation']; integration: IntegrationOut | null; updated_at: string | null }> {
  const { project } = await ctx.scoped.project(input.project_id);
  const setup = await ctx.repos.projectSetup.get(project.id);
  return { project_id: project.id, repo: setup.data.repo, automation: setup.data.automation, integration: await repoIntegration(ctx, setup.data.repo), updated_at: setup.updated_at };
}

/**
 * Points the project at a GitHub repository (spec D4): only the `repo` block changes, every other block
 * of the setup is saved back as it was. The integration must be a GitHub one of the project's own owner —
 * the rule the CI sync enforces, so a repository set here is one the CI panel will actually read.
 * `deploy_workflow` / `base_branch` left out keep their current value; `deploy_workflow: null` clears it.
 */
export async function setProjectRepo(
  ctx: ControlContext,
  input: { project_id: string; integration_id: string; full_name: string; deploy_workflow?: string | null; base_branch?: string },
): Promise<{ project_id: string; repo: RepoBlock; integration: IntegrationOut; updated_at: string | null }> {
  const { project } = await ctx.scoped.project(input.project_id);
  const integration = await ctx.scoped.integration(input.integration_id);
  if (integration.provider !== 'github' || project.owner_id === null || integration.owner_id !== project.owner_id) {
    throw new ControlError('INTEGRATION_NOT_ALLOWED', `A integração ${integration.name} não serve para o repositório do projeto ${project.name}: precisa ser do GitHub e do mesmo dono do projeto`);
  }
  const fullName = input.full_name.trim();
  if (!validRepo(fullName)) throw new ControlError('INVALID_REPO', 'Repositório inválido: use o formato dono/repositorio (ex.: acme/api)');
  const current = await ctx.repos.projectSetup.get(project.id);
  const repo = repoSchema.safeParse({
    ...(current.data.repo ?? {}),
    integration_id: integration.id,
    full_name: fullName,
    ...(input.deploy_workflow !== undefined ? { deploy_workflow: input.deploy_workflow } : {}),
    ...(input.base_branch !== undefined ? { base_branch: input.base_branch } : {}),
  });
  if (!repo.success) throw new ControlError('INVALID_REPO', 'Branch base ou workflow de deploy inválido');
  const next = setupInputSchema.safeParse({ ...current.data, repo: repo.data });
  if (!next.success) throw new ControlError('INVALID_SETUP', `O setup salvo do projeto ${project.name} está inválido; abra-o na tela Setup e salve de novo`);
  const saved = await ctx.repos.projectSetup.save(project.id, next.data);
  return { project_id: project.id, repo: saved.data.repo!, integration: integrationOut(integration), updated_at: saved.updated_at };
}
