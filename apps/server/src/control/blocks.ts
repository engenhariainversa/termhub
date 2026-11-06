/**
 * The MCP half of the open model's blocks (TER-1164, flag `chat_open_permissions`): `list_blocks` tells the
 * chat what the person said it must not do, `block_action` adds a block on the person's word (a brake: no
 * card), `unblock_action` lifts one (always a card: the gate classes it `write` and nothing covers it).
 */
import { blockViews, effectiveBlocks, openPermissionsOn, type BlockView, type EffectiveBlock } from '../chat/blocks.js';
import { parseCommand } from '../chat/command-rules.js';
import { OPEN_CORE_TEXT, type BlockEffect, type BlockKind } from '../chat/open-permissions.js';
import { BLOCKS_MAX } from '../db/repositories/chat-blocks.js';
import { msg } from '../i18n/index.js';
import { ControlError, type ControlContext } from './context.js';

const OFF = () =>
  new ControlError('OPEN_PERMISSIONS_OFF', msg('Bloqueios só valem com o modelo "liberado por padrão", que não está ligado para esta pessoa. As permissões dela estão em Configurações › Permissões do chat.'));

/** `list_blocks`: the blocks in force (one project's and the global ones, or all), and the fixed core. */
export async function listBlocksTool(ctx: ControlContext, input: { project_id?: string }): Promise<{ on: boolean; blocks: BlockView[]; always_asks: string }> {
  const userId = ctx.scope.user.id;
  if (!(await openPermissionsOn(ctx.repos, userId))) return { on: false, blocks: [], always_asks: OPEN_CORE_TEXT };
  let blocks = await effectiveBlocks(ctx.repos, userId);
  if (input.project_id) {
    const { project } = await ctx.scoped.project(input.project_id);
    blocks = blocks.filter((b) => b.project_id === null || b.project_id === project.id);
  }
  return { on: true, blocks: await views(ctx, blocks), always_asks: OPEN_CORE_TEXT };
}

/**
 * `block_action`: the person says what the chat must not do. Owner-scoped project; a run_command block may
 * name the command's first words. Idempotent: the same block twice is one block.
 */
export async function blockAction(ctx: ControlContext, input: { kind: BlockKind; project_id?: string; command?: string; effect?: BlockEffect }): Promise<{ block: BlockView; created: boolean }> {
  const userId = ctx.scope.user.id;
  if (!(await openPermissionsOn(ctx.repos, userId))) throw OFF();
  let words: string[] = [];
  if (input.command !== undefined) {
    if (input.kind !== 'run_command') throw new ControlError('BLOCK_INVALID', msg('command só vale para kind run_command.'));
    const parsed = parseCommand(input.command);
    if (!parsed.ok || parsed.words.length === 0) throw new ControlError('BLOCK_INVALID', msg('command deve ser o começo de um comando simples, como «git push» ou «docker compose down».'));
    words = parsed.words;
  }
  const projectId = input.project_id ? (await ctx.scoped.project(input.project_id)).project.id : null;
  if ((await ctx.repos.chatBlocks.countActive(userId)) >= BLOCKS_MAX) throw new ControlError('BLOCKS_FULL', msg('A pessoa já tem {{max}} bloqueios; peça para ela revisar a lista em Permissões do chat.', { max: BLOCKS_MAX }));
  const { block, created } = await ctx.repos.chatBlocks.create({ user_id: userId, project_id: projectId, kind: input.kind, words, effect: input.effect ?? 'ask', conversation_id: ctx.token?.chat_conversation_id ?? null });
  const [view] = await views(ctx, [{ ...block, source: 'block' }]);
  return { block: view!, created };
}

/** `unblock_action`: lifts one block of the person's — on a chat token only after they approve the card. */
export async function unblockAction(ctx: ControlContext, input: { block_id: string }): Promise<{ lifted: BlockView }> {
  const userId = ctx.scope.user.id;
  if (!(await openPermissionsOn(ctx.repos, userId))) throw OFF();
  if (input.block_id.startsWith('restriction:')) {
    throw new ControlError('BLOCK_IS_RESTRICTION', msg('Este bloqueio vem de uma ação que a pessoa desmarcou em "Liberadas por padrão": ela o tira em Configurações › Permissões do chat.'));
  }
  const lifted = await ctx.repos.chatBlocks.revoke(input.block_id, userId);
  if (!lifted) throw new ControlError('NOT_FOUND', msg('Bloqueio não encontrado (ou já tirado). Veja os bloqueios com list_blocks.'));
  const [view] = await views(ctx, [{ ...lifted, source: 'block' }]);
  return { lifted: view! };
}

const views = (ctx: ControlContext, blocks: EffectiveBlock[]): Promise<BlockView[]> => blockViews(ctx.repos, ctx.scope.user.id, blocks);
