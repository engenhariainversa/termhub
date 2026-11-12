/**
 * The blocks in force for a person under the open model (TER-1164): their own `chat_blocks`, plus what they
 * had already taken out of the defaults (`chat_default_restrictions`, TER-627), read as a block for every
 * project that asks. Read at use time, not copied, so turning the flag off and on again changes nothing,
 * and a restriction changed meanwhile is honoured both ways.
 */
import { isEnabled } from '../features/flags.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ChatBlock } from '../db/repositories/chat-blocks.js';
import type { DefaultAllowKind } from './gate.js';
import { BLOCK_KIND_LABEL, type BlockEffect, type BlockKind, type BlockShape } from './open-permissions.js';

/** A restricted default, as the block it stands for under the open model. `read_commands` was the
 *  read-only list of run_command: restricting it asked every command, so it reads as a run_command block. */
const RESTRICTION_AS_BLOCK: Record<DefaultAllowKind, BlockKind> = {
  open_tab: 'open_tab',
  start_agent: 'start_agent',
  link_tab_task: 'link_tab_task',
  board: 'board',
  terminal: 'terminal',
  close_tab: 'close_tab',
  read_commands: 'run_command',
};

/** A block in force, with where it came from: `restriction` rows are lifted in "Permissões do chat" like before. */
export type EffectiveBlock = BlockShape & { id: string; source: 'block' | 'restriction'; created_at: string | null };

export async function effectiveBlocks(repos: Pick<Repositories, 'chatBlocks' | 'chatDefaultRestrictions'>, userId: string): Promise<EffectiveBlock[]> {
  const [own, restricted] = await Promise.all([repos.chatBlocks.listActive(userId), repos.chatDefaultRestrictions.listForUser(userId)]);
  const fromRestrictions: EffectiveBlock[] = [...restricted].map((k) => ({
    id: `restriction:${k}`,
    source: 'restriction',
    kind: RESTRICTION_AS_BLOCK[k],
    project_id: null,
    words: [],
    effect: 'ask',
    created_at: null,
  }));
  return [...own.map((b: ChatBlock): EffectiveBlock => ({ id: b.id, source: 'block', kind: b.kind, project_id: b.project_id, words: b.words, effect: b.effect, created_at: b.created_at })), ...fromRestrictions];
}

/**
 * Whether the open model is on for this person. Any failure reads as off — the current model, which asks
 * more, is the safe direction for a permission.
 */
export async function openPermissionsOn(repos: Pick<Repositories, 'featureFlags'>, userId: string): Promise<boolean> {
  try {
    return await isEnabled('chat_open_permissions', { repos, userId });
  } catch {
    return false;
  }
}

/** One block in the person's words, pt-BR, for the prompt and the tools' answers. */
export function describeBlock(b: BlockShape & { id: string }, projectName: string | null): string {
  const what = b.kind === 'run_command' && b.words.length > 0 ? `rodar «${b.words.join(' ')}…»` : BLOCK_KIND_LABEL[b.kind];
  const where = b.project_id === null ? 'em todos os projetos' : `no projeto ${projectName ?? b.project_id}`;
  return `${what} ${where} (${b.effect === 'never' ? 'nunca' : 'pedir antes'}; id ${b.id})`;
}

export interface BlockView {
  id: string;
  kind: BlockKind;
  label: string;
  project_id: string | null;
  project_name: string | null;
  words: string[];
  effect: BlockEffect;
  /** `restriction`: a default the person took back before the open model; lifted in "Liberadas por padrão". */
  source: 'block' | 'restriction';
  created_at: string | null;
  text: string;
}

/** The blocks as the chat, the tools and the screen show them, project names read owner-scoped. */
export async function blockViews(repos: Pick<Repositories, 'projects'>, userId: string, blocks: EffectiveBlock[]): Promise<BlockView[]> {
  const ids = [...new Set(blocks.map((b) => b.project_id).filter((p): p is string => p !== null))];
  const projects = ids.length ? await repos.projects.findByIdsForOwner(ids, userId) : [];
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  return blocks.map((b) => {
    const name = b.project_id ? (nameOf.get(b.project_id) ?? null) : null;
    return { id: b.id, kind: b.kind, label: BLOCK_KIND_LABEL[b.kind], project_id: b.project_id, project_name: name, words: [...b.words], effect: b.effect, source: b.source, created_at: b.created_at, text: describeBlock(b, name) };
  });
}
