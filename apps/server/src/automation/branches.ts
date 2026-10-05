import path from 'node:path';
import { CAPABILITY_WORKTREE, WORKTREE_MIN_AGENT_VERSION } from '@termhub/agent-protocol';
import { agentRpc } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import { ControlError } from '../control/context.js';
import type { Machine } from '../db/repositories/types.js';
import { msg } from '../i18n/index.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import type { ProjectSetupData } from '../setup/schema.js';

const SLUG_MAX = 40;

/** ASCII, lower case, words joined by dashes, at most 40 characters (no trailing dash). */
export function slugOf(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

const fill = (pattern: string, ref: string, title: string) => pattern.replaceAll('{ref}', ref).replaceAll('{ticket}', ref).replaceAll('{slug}', slugOf(title));

/** `automation.epic_branch_pattern` (`{ref}`, `{slug}`). */
export function epicBranchName(pattern: string, epic: { ref: string; title: string }): string {
  return fill(pattern, epic.ref, epic.title);
}

/** `repo.branch_pattern` (`{ticket}` is the card's ref, `{slug}`). */
export function cardBranchName(pattern: string, card: { ref: string; title: string }): string {
  return fill(pattern, card.ref, card.title);
}

/** Where a card's PR goes: the epic's branch when its epic is automatic (D8), else the repo's base branch. */
export function targetOf(card: { epic: { auto: boolean; ref: string; title: string } | null }, setup: ProjectSetupData): { base: string; epicBranch: string | null } {
  if (card.epic?.auto) {
    const epicBranch = epicBranchName(setup.automation.epic_branch_pattern, card.epic);
    return { base: epicBranch, epicBranch };
  }
  return { base: setup.repo?.base_branch ?? 'main', epicBranch: null };
}

/** Creates the epic branch from the base branch's head; a branch that already exists is fine. */
export async function ensureEpicBranch(deps: { gh: GithubWriteClient; token: string; repo: string }, baseBranch: string, epicBranch: string): Promise<void> {
  const { gh, token, repo } = deps;
  const sha = await gh.branchSha(token, repo, baseBranch);
  if (!sha) throw new ControlError('BASE_BRANCH_MISSING', msg('A branch {{branch}} não existe no repositório', { branch: baseBranch }));
  await gh.createBranch(token, repo, epicBranch, sha); // 'created' and 'exists' are both success
}

/** A card's worktree on the machine: `<root>/<projectId>/<ref>`, on `branch` (started from `base`). */
export async function ensureWorkspace(
  machine: Machine,
  i: { repoDir: string; root: string; projectId: string; ref: string; branch: string; base: string },
): Promise<{ path: string; created: boolean }> {
  if (!(agents.capabilities(machine.id) ?? []).includes(CAPABILITY_WORKTREE)) {
    // An offline agent has no capabilities: the RPC below would say 503, but the version is the more useful answer only when connected.
    if (agents.isOnline(machine.id)) {
      throw new ControlError('AGENT_OUTDATED', msg('Atualize o agente desta máquina (npm i -g @termhub/agent, versão {{version}} ou mais nova)', { version: WORKTREE_MIN_AGENT_VERSION }));
    }
  }
  const target = path.posix.join(i.root, i.projectId, i.ref);
  const r = await agentRpc(machine, 'git.worktree.ensure', { repo_dir: i.repoDir, root: i.root, path: target, branch: i.branch, base: i.base });
  return { path: r.path, created: r.created };
}
