import { isLimited, projectChatAccounts } from '../chat/host.js';
import { msg } from '../i18n/index.js';
import { HttpError, notFound } from '../lib/errors.js';
import type { ControlContext } from './context.js';

/**
 * `set_chat_account` (TER-1144): the person asks the concierge to move a project chat to another of the
 * project's Claude accounts ("troca pra conta X"), or back to the project's order (`account_id: null`).
 * The same write as the chat settings' picker: the project conversation's own account, never the
 * account-wide host, never the project's Setup. Only the person's own project chats.
 */
export async function setChatAccount(ctx: ControlContext, args: { project_id: string; account_id: string | null }) {
  const { project } = await ctx.scoped.project(args.project_id);
  const user = ctx.scope.user;
  if (project.owner_id !== user.id) throw notFound(msg('Projeto não encontrado'));
  const machines = await ctx.repos.machines.list(user.id);
  const { accounts, chatMachineId } = await projectChatAccounts(ctx.repos, user.id, project.id, machines);
  const listed = accounts.map(({ account, machine }) => ({ id: account.id, label: account.label, machine: machine.name, limited: isLimited(account.id) }));
  if (args.account_id !== null && !accounts.some((a) => a.account.id === args.account_id)) {
    throw new HttpError(400, msg('Essa conta não está nas contas do Claude do projeto (Setup → Contas de IA e modelo)'), 'CHAT_ACCOUNT_NOT_IN_PROJECT');
  }
  const conversation = await ctx.repos.chat.getOrCreateForProject(user.id, project.id);
  await ctx.repos.chat.setRunAccount(conversation.id, args.account_id);
  const chosen = listed.find((a) => a.id === args.account_id) ?? null;
  return {
    project_id: project.id,
    account: chosen,
    concierge_machine: machines.find((m) => m.id === chatMachineId)?.name ?? null,
    project_accounts: listed,
    instruction: chosen
      ? `The project chat's next message runs on "${chosen.label}" (${chosen.machine})${chosen.limited ? ', once its usage limit is over (until then the next account of the project with room answers)' : ''}. The model's memory of this conversation starts over there; the history stays. Tell the person.`
      : "The project chat's account follows the project again: its concierge machine, else the first account of the Setup's list with room. Tell the person.",
  };
}
