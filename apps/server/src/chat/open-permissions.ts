/**
 * The open permissions model (TER-1164, flag `chat_open_permissions`): the chat acts without a card by
 * default, and the person says what it must not do (a block, per project or for every project). A small
 * core — what cannot be undone, what leaves the machine, credentials and money — always asks, whatever
 * the blocks say. Spec docs/superpowers/specs/2026-11-06-chat-open-permissions-design.md.
 *
 * This file is the pure half: which kind a call is, the labels and the budgets. The gate's half, which
 * resolves the target owner-scoped and applies the guards, is `openGrantCovering` in gate-runtime.ts.
 */
import { BOARD_GRANT_TOOLS } from './gate.js';

/** What a block names. Closed on purpose: a tool not mapped to one of these is core and always asks. */
export const BLOCK_KINDS = ['open_tab', 'close_tab', 'start_agent', 'board', 'link_tab_task', 'terminal', 'run_command', 'share_file', 'machines', 'tickets', 'automation'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
export const isBlockKind = (v: unknown): v is BlockKind => (BLOCK_KINDS as readonly string[]).includes(v as string);

export const BLOCK_EFFECTS = ['ask', 'never'] as const;
export type BlockEffect = (typeof BLOCK_EFFECTS)[number];
export const isBlockEffect = (v: unknown): v is BlockEffect => (BLOCK_EFFECTS as readonly string[]).includes(v as string);

/** pt-BR, for the prompt and the tools' answers (the screens translate their own copy). */
export const BLOCK_KIND_LABEL: Record<BlockKind, string> = {
  open_tab: 'abrir abas',
  close_tab: 'fechar abas paradas',
  start_agent: 'iniciar agentes',
  board: 'mexer no quadro',
  link_tab_task: 'ligar aba a card',
  terminal: 'digitar texto e teclas nas abas',
  run_command: 'rodar comandos',
  share_file: 'compartilhar arquivos das máquinas',
  machines: 'mexer nas máquinas (ligar ao projeto, pasta, acordar, atualizar o agente, hooks)',
  tickets: 'sincronizar e importar tickets',
  automation: 'retomar o trabalho automático',
};

/** What always asks, whatever the blocks say — told to the model and shown on the screen. */
export const OPEN_CORE_TEXT =
  'apagar card, fechar aba trabalhando, as teclas C-c e Escape, responder permissão do CLI (salvo quando você repassa a resposta citando a mensagem da pessoa, on_behalf_of), comandos da lista "nunca" (encadeados, redirecionamento, sudo, rm, kill, push --force, reset --hard, git clean, ssh e shells, segredos), merge e subir o nível da automação, status de ticket, integrações e set_project_repo, login, exclusividade e setup das contas de IA, dados de outro usuário, remover um bloqueio e qualquer ferramenta nova';

const MACHINE_TOOLS: ReadonlySet<string> = new Set(['link_project_machine', 'set_project_machine_cwd', 'wake_machine', 'update_machine_agent', 'install_machine_hooks']);
const INTERRUPTING_KEYS: ReadonlySet<string> = new Set(['C-c', 'Escape']);

/**
 * The kind of an open-model call, or null when it is core (asks whatever the blocks say). Only the
 * call's own arguments are read here; the gate adds the target's state.
 */
export function openKindOf(tool: string, args: Record<string, unknown>): BlockKind | null {
  if (tool === 'open_tab' || tool === 'start_agent' || tool === 'close_tab' || tool === 'link_tab_task' || tool === 'run_command' || tool === 'share_file') return tool;
  if (BOARD_GRANT_TOOLS.has(tool)) return 'board';
  if (tool === 'send_input') return 'terminal';
  if (tool === 'send_key') return typeof args.key === 'string' && !INTERRUPTING_KEYS.has(args.key) ? 'terminal' : null;
  if (MACHINE_TOOLS.has(tool)) return 'machines';
  // Without confirm it unlinks a machine with no tabs, or refuses; with it, it closes tabs (core).
  if (tool === 'unlink_project_machine') return args.confirm === true ? null : 'machines';
  if (tool === 'sync_tickets' || tool === 'import_tickets') return 'tickets';
  if (tool === 'resume_automation' || tool === 'resume_automation_run') return 'automation';
  if (tool === 'set_machine_automation') return args.accept === true ? 'automation' : null;
  return null;
}

/** Calls the open model covers per user, kind and rolling hour: a brake against an injected prompt, not a
 *  quota. Past it, the call is asked. */
export const OPEN_BUDGETS: Record<BlockKind, number> = {
  open_tab: 30,
  close_tab: 30,
  start_agent: 10,
  board: 30,
  link_tab_task: 30,
  terminal: 120,
  run_command: 60,
  share_file: 30,
  machines: 10,
  tickets: 10,
  automation: 10,
};

/** The audit id of a call the open model let through. The `default:` prefix keeps the existing "liberado
 *  por padrão" mark on the web and in the app; no grant row has a colon in its id. */
export const openGrantId = (userId: string, kind: BlockKind): string => `default:open-${kind}:${userId}`;
/** A permission answer relayed with the person's own words (`on_behalf_of`): audited apart. */
export const quotedAnswerGrantId = (userId: string): string => `default:open-quoted:${userId}`;
export const isQuotedAnswerGrantId = (id: string | null | undefined): boolean => typeof id === 'string' && id.startsWith('default:open-quoted:');

/** How recent the person's quoted message must be to answer a permission for them. */
export const QUOTED_ANSWER_MAX_AGE_MS = 30 * 60_000;

/** A block as the gate reads it. */
export interface BlockShape {
  kind: BlockKind;
  project_id: string | null;
  words: readonly string[];
  effect: BlockEffect;
}

/**
 * The block that applies to a call of `kind` in `projectId` (null: a call with no project, which only
 * blocks for every project apply to), or undefined. A run_command block with words only applies to the
 * commands that start with them; `words` is the command's own (null when the call is not a command).
 * `never` wins over `ask` when both apply.
 */
export function blockFor(blocks: readonly BlockShape[], kind: BlockKind, projectId: string | null, words: readonly string[] | null): BlockShape | undefined {
  const applies = blocks.filter((b) => {
    if (b.kind !== kind) return false;
    if (b.project_id !== null && b.project_id !== projectId) return false;
    if (b.words.length === 0) return true;
    return words !== null && b.words.length <= words.length && b.words.every((w, i) => w === words[i]);
  });
  return applies.find((b) => b.effect === 'never') ?? applies[0];
}
