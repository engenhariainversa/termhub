import { auditExclusiveChange } from '../ai/exclusive.js';
import type { AiAccount } from '../db/repositories/types.js';
import { msg } from '../i18n/index.js';
import { ControlError, type ControlContext } from './context.js';

export interface ExclusiveView {
  id: string;
  label: string;
  provider: AiAccount['provider'];
  machine_id: string;
  exclusive_project: { id: string; name: string } | null;
}

const view = (a: AiAccount): ExclusiveView => ({ id: a.id, label: a.label, provider: a.provider, machine_id: a.machine_id, exclusive_project: a.exclusive_project });

/**
 * Makes the account exclusive to a project, or clears it (`project_id: null`) — TER-990. The account and
 * the project go through the scope (404 outside it). Only the person changes it: an agent tab's token is
 * refused (it could hand a client's account to its own project), and an MCP call needs `confirm: true`,
 * without which the answer says what would change and nothing does. Every change is audited.
 */
export async function setAccountExclusive(
  ctx: ControlContext,
  input: { account_id: string; project_id: string | null; confirm?: boolean },
  via: 'web' | 'mcp' | 'chat',
): Promise<{ account: ExclusiveView; changed: boolean }> {
  if (ctx.token?.tab) throw new ControlError('FORBIDDEN', 'Só a pessoa muda a exclusividade de uma conta de IA, nunca um agente numa aba');
  const { account } = await ctx.scoped.aiAccount(input.account_id);
  const project = input.project_id === null ? null : (await ctx.scoped.project(input.project_id)).project;
  const from = account.exclusive_project?.id ?? null;
  const to = project?.id ?? null;
  if (from === to) return { account: view(account), changed: false };
  if (via !== 'web' && !input.confirm) {
    throw new ControlError(
      'CONFIRM_REQUIRED',
      project
        ? msg('Isso deixa a conta "{{account}}" exclusiva do projeto {{project}}: nenhum outro projeto poderá usá-la; repita com confirm: true para confirmar', { account: account.label, project: project.name })
        : msg('Isso libera a conta "{{account}}", hoje exclusiva do projeto {{project}}, para qualquer projeto; repita com confirm: true para confirmar', { account: account.label, project: account.exclusive_project?.name ?? '' }),
    );
  }
  const updated = await ctx.repos.aiAccounts.update(account.id, { exclusive_project_id: to });
  if (!updated) throw new ControlError('NOT_FOUND', 'Conta não encontrada');
  await auditExclusiveChange(ctx.repos, ctx.log, account, from, to, via);
  return { account: view(updated), changed: true };
}
