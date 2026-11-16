import path from 'node:path';
import { ControlError, type ControlContext } from '../control/context.js';
import { msg } from '../i18n/index.js';
import { ensureEpicBranch as ensureEpicBranchFn, ensureWorkspace as ensureWorkspaceFn, targetOf } from './branches.js';
import { recordEvent } from './events.js';
import { runOfTabToken } from './follower.js';
import { githubAccess } from './github-access.js';
import { activeEntries, loadRepoEntries } from './repo-entry.js';
import { githubClient } from './run-done.js';
import { baseOf, checkoutDirOn, pickRunRepo, repoDirOf, runKeysOf } from './run-repo.js';
import type { GithubWriteClient } from '../integrations/github-write.js';

export interface AddRepoDeps {
  ensureWorkspace: typeof ensureWorkspaceFn;
  ensureEpicBranch: typeof ensureEpicBranchFn;
  gh: GithubWriteClient;
}

const defaults = (): AddRepoDeps => ({ ensureWorkspace: ensureWorkspaceFn, ensureEpicBranch: ensureEpicBranchFn, gh: githubClient() });

export interface AddRepoResult {
  ok: true;
  key: string;
  /** owner/repo */
  repo: string;
  /** the new worktree, `<run worktree>/<key>` */
  path: string;
  base: string;
  /** the key was already one of the run's repositories: nothing was done */
  already?: true;
}

/**
 * The tab tool `add_repo { key }` (spec 2026-10-07 multi-repo R12, outline Task 13): the agent of a workspace
 * run found it also needs another repository of the project. The key must be in the project, enabled and
 * readable, and checked out on the run's machine. The server then makes the epic branch there when the card's
 * epic is automatic (R16), cuts the worktree at `<workspace>/<key>` on the run's branch, adds the
 * `automation_run_repos` row, appends the key to the card's `repo_keys` and records `run_repo_added`.
 *
 * A run in one repository is refused: its worktree is that repository itself, so there is no workspace root to
 * add under, and its guard was set up for one folder. Removing a repository is not offered: one left without
 * commits gets no PR (`no_changes`) and its worktree goes at cleanup.
 */
export async function addRunRepo(ctx: ControlContext, i: { key: string }, deps: AddRepoDeps = defaults()): Promise<AddRepoResult> {
  const { repos } = ctx;
  const run = await runOfTabToken(ctx);
  const task = run?.task_id ? await repos.tasks.findById(run.task_id) : undefined;
  if (!run || !task || !run.branch || !run.worktree_path || !run.machine_id) throw new ControlError('NO_RUN', msg('Esta aba não tem trabalho automático em andamento'));
  const rows = repos.automationRunRepos ? await repos.automationRunRepos.listByRun(run.id) : [];
  const keys = runKeysOf(rows, run.worktree_path);
  if (keys.length < 2) {
    throw new ControlError('ADD_REPO_SINGLE', msg('Esta execução trabalha num repositório só e não recebe outro; chame report_card com status blocked dizendo qual repositório falta, para o card rodar com os dois'));
  }
  const setup = (await repos.projectSetup.get(run.project_id)).data;
  const entries = await loadRepoEntries(repos, run.project_id, setup);
  const entry = entries.find((e) => e.key === i.key);
  if (!entry) throw new ControlError('REPO_UNKNOWN', msg('O repositório {{key}} não existe neste projeto', { key: i.key }));
  if (!activeEntries([entry]).length) throw new ControlError('REPO_UNAVAILABLE', msg('Repositório desligado ou removido no Setup'));
  const root = run.worktree_path.replace(/\/+$/, '');
  const wanted = path.posix.join(root, i.key);
  if (keys.includes(i.key)) return { ok: true, key: i.key, repo: entry.full_name, path: wanted, base: rows.find((r) => r.worktree_path.replace(/\/+$/, '') === wanted)?.base ?? entry.base_branch, already: true };

  const target = pickRunRepo(setup, repos.projectRepositories ? await repos.projectRepositories.listByProject(run.project_id) : [], [i.key]);
  const dir = checkoutDirOn(target, run.machine_id);
  const link = await repos.projectMachines.find(run.project_id, run.machine_id);
  const machine = await repos.machines.findById(run.machine_id);
  if (dir === null || !link || !machine || !target.repositoryId) {
    throw new ControlError('REPO_NOT_ON_MACHINE', msg('O repositório {{key}} não está na máquina desta execução', { key: i.key }));
  }

  // the same base the dispatcher gives every repository of the card: the epic branch when its epic is automatic
  const epic = task.epic_id ? await repos.tasks.findById(task.epic_id) : undefined;
  const { base, epicBranch } = targetOf({ epic: epic ? { auto: epic.auto, ref: epic.ref, title: epic.title } : null }, setup, target.branch);
  if (epicBranch) {
    const project = await repos.projects.findById(run.project_id);
    const access = project ? await githubAccess(repos, project, setup, entry) : null;
    if (!access) throw new ControlError('REPO_NO_ACCESS', msg('A integração do GitHub não acessa o repositório {{key}}', { key: i.key }));
    await deps.ensureEpicBranch({ gh: deps.gh, ...access }, baseOf(target, setup), epicBranch);
  }
  // the workspace is `<worktrees_dir>/<pid>/<ref>`: the new worktree goes right under it, whatever the Setup says now
  const ws = await deps.ensureWorkspace(machine, {
    repoDir: repoDirOf(link.cwd, dir),
    root: path.posix.dirname(path.posix.dirname(root)),
    projectId: path.posix.basename(path.posix.dirname(root)),
    ref: path.posix.basename(root),
    branch: run.branch,
    base,
    key: i.key,
  });
  await repos.automationRunRepos.add({ run_id: run.id, repository_id: target.repositoryId, branch: run.branch, base, worktree_path: ws.path });
  await repos.tasks.addRepoKey(task.id, i.key);
  await recordEvent(repos, { project_id: run.project_id, task_id: task.id, run_id: run.id, kind: 'run_repo_added', payload: { key: i.key, repo: entry.full_name, tab_id: run.tab_id, path: ws.path } }).catch((e: unknown) =>
    ctx.log?.warn({ runId: run.id, code: (e as { code?: string }).code ?? 'INTERNAL' }, 'automation: run_repo_added not recorded'),
  );
  ctx.log?.info({ runId: run.id, taskId: task.id, machineId: machine.id }, 'automation: repository added to a run');
  return { ok: true, key: i.key, repo: entry.full_name, path: ws.path, base };
}
