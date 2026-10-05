import { createHash } from 'node:crypto';
import type { ChatAction, ChatActionStatus } from '../db/repositories/chat-actions.js';
import { STANDING_GRANT_KINDS, type StandingGrantKind } from '../db/repositories/chat-standing-grants.js';
import { hasAutomationPatch } from '../automation/setup-patch.js';

export { STANDING_GRANT_KINDS, type StandingGrantKind };

export type ActionClass = 'read' | 'self_mediated' | 'write' | 'irreversible';

// Tools whose effect is already mediated by the person, so asking again would double the question
// (spec 2026-09-26 concierge memory D13): record_decision writes a note the person sees and can
// forget on the Memória screen; answer_tab_question only schedules a countdown the person can cancel,
// or leaves a suggestion. record_lesson writes an unverified, visible block the person can forget —
// spec TER-205 D11. Never add a tool here that acts on a machine directly.
// recap_pending_cards only moves the person's own cards to the end of their chat (TER-477): nothing is
// decided, sent or changed on a machine, and a confirmation card for it would be one more card to answer.
const selfMediatedTools = new Set(['record_decision', 'answer_tab_question', 'record_lesson', 'recap_pending_cards', 'escalate_automation_run']);

// Tools classified by reversibility
const readTools = new Set([
  'list_machines',
  'list_projects',
  'list_project_groups',
  'list_tabs',
  'list_ai_accounts',
  'find',
  'read_screen',
  'read_last_answer',
  'wait_for_state',
  'list_tasks',
  'list_automation_queue',
  'get_automation_policy',
  // a tab tool (agentic board F-8): reads the calling tab's own run card; the concierge never lists it
  'get_card',
  'list_automation_events',
  'list_tickets',
  'get_ticket',
  'read_attachment',
  'search_memory',
  'list_integrations',
  'get_project_setup',
  // TER-627: lists the tabs' question cards and their answers; nothing is sent or changed.
  'list_tab_questions',
]);

const writeTools = new Set([
  'open_tab',
  'send_input',
  'run_command',
  'start_agent',
  'create_task',
  'add_subtasks',
  'update_task',
  'move_task',
  'link_tab_task',
  'link_project_machine',
  'set_project_machine_cwd',
  'sync_tickets',
  'import_tickets',
  // Lifting the brake lets automatic work start again: the person says so on a card.
  'resume_automation',
  // Hands one parked automatic run back: the follower may type into its tab again.
  'resume_automation_run',
]);

// close_tab stays irreversible. control/terminals.ts skips its per-token ownership check for a gated
// token because the gate mediates every gated close_tab: a card, or a standing grant (TER-386) under
// which the gate itself resolves the tab owner-scoped and requires it to belong to the granted project
// (chat/standing-project.ts) before the call runs — or the default allowance (TER-627), which resolves
// the tab the same owner-scoped way and only for a stopped tab. Never let close_tab through without one.
// create_integration and set_project_repo change credentials and where the CI panel reads from
// (spec 2026-09-28 MCP integrations D6): always a card, never covered by a grant.
// automation_merge is the card the merge executor asks for a PR above the project's level (agentic board
// D7): never a concierge tool, never covered by a grant; approving it merges that PR once.
const irreversibleTools = new Set(['close_tab', 'delete_task', 'push_ticket_status', 'create_integration', 'set_project_repo', 'automation_merge']);

// Keys that interrupt the running process and cannot be undone
const interruptingKeys = new Set(['C-c', 'Escape']);

/**
 * Classifies a proposed tool action by its reversibility.
 * Unknown tools default to irreversible to ensure new tools are never auto-allowed
 * without explicit evaluation.
 */
export function actionClass(tool: string, args: unknown): ActionClass {
  if (readTools.has(tool)) {
    return 'read';
  }

  if (selfMediatedTools.has(tool)) {
    return 'self_mediated';
  }

  if (writeTools.has(tool)) {
    return 'write';
  }

  if (irreversibleTools.has(tool)) {
    return 'irreversible';
  }

  // send_key must inspect the key argument: only interrupting keys are irreversible
  if (tool === 'send_key') {
    const key = (args as { key?: string } | undefined)?.key;
    return typeof key === 'string' && interruptingKeys.has(key) ? 'irreversible' : 'write';
  }

  // pause_automation is the brake: on its own it only stops new work, so it never waits for a card. With
  // interrupt it also sends Escape to the tabs running automatic work, which is the person's call.
  if (tool === 'pause_automation') {
    return (args as { interrupt?: unknown } | undefined)?.interrupt === true ? 'write' : 'self_mediated';
  }

  // TER-975: the automation Setup. Without a field to change it only reads. With one, the static class is
  // the worst case (a write no grant or default covers, so it asks); the gate runtime reads the current
  // Setup and lets a brake (off, a lower level, a lower max_parallel) through as self-mediated.
  if (tool === 'set_automation_policy') {
    return hasAutomationPatch((args ?? {}) as Record<string, unknown>) ? 'write' : 'read';
  }

  // The machine's "Aceita trabalho automático": refusing is a brake, accepting asks the person.
  if (tool === 'set_machine_automation') {
    return (args as { accept?: unknown } | undefined)?.accept === false ? 'self_mediated' : 'write';
  }

  // unlink_project_machine only closes tabs (irreversible) when confirm: true; otherwise it either
  // unlinks a machine with no tabs on it, or refuses and asks the caller to confirm — both reversible
  if (tool === 'unlink_project_machine') {
    return (args as { confirm?: unknown } | undefined)?.confirm === true ? 'irreversible' : 'write';
  }

  // Unknown tools default to irreversible: a tool added later must not silently
  // become auto-allowed without explicit review of this decision
  return 'irreversible';
}

/**
 * Recursively sorts object keys and returns canonical JSON representation.
 * Ensures argument order cannot create duplicate questions: { tab_id, text }
 * and { text, tab_id } produce the same serialization.
 */
function canonicalSerialize(obj: unknown): string {
  // Primitives and null/undefined
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  // Arrays: serialize each element canonically
  if (Array.isArray(obj)) {
    const serialized = obj.map(canonicalSerialize);
    return JSON.stringify(serialized);
  }

  // Objects: sort keys and serialize recursively
  const sorted: Record<string, string> = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    sorted[key] = canonicalSerialize((obj as Record<string, unknown>)[key]);
  }
  return JSON.stringify(sorted);
}

/**
 * Generates a stable idempotency key from conversation, tool, and arguments.
 * Uses SHA-256 of canonically serialized data so argument order does not matter.
 */
export function idempotencyKeyFor(conversationId: string, tool: string, args: unknown): string {
  const canonical = canonicalSerialize({ conversationId, tool, args });
  return createHash('sha256').update(canonical).digest('hex');
}

/** The one tool a tab grant can cover (spec 2026-09-25): free text typed at a prompt. */
export const GRANTABLE_TOOL = 'send_input';

/**
 * Whether "Permitir sempre nesta aba" may cover this call. Only `send_input` to a named tab, and
 * never with `answering_permission`: answering a permission dialog, like `send_key` and
 * `run_command`, always asks. Shared by the gate and the decision route, so the button is offered and
 * accepted for exactly the calls the gate will honour.
 */
export function grantable(tool: string, args: Record<string, unknown>): args is Record<string, unknown> & { tab_id: string } {
  const tab = args.tab_id;
  return tool === GRANTABLE_TOOL && args.answering_permission !== true && typeof tab === 'string' && tab.length >= 1 && tab.length <= 64;
}

/**
 * The board tools "Permitir sempre neste projeto" may cover (spec 2026-09-26 project grant §2). Closed
 * on purpose: a board tool added later is not covered until someone decides it. `delete_task` is
 * irreversible and never here.
 */
export const BOARD_GRANT_TOOLS: ReadonlySet<string> = new Set(['create_task', 'add_subtasks', 'update_task', 'move_task']);

export const boardGrantable = (tool: string): boolean => BOARD_GRANT_TOOLS.has(tool);

/** What one project grant covers at most: a brake on what an injected prompt could do before the user
 * notices a card again. Past it, calls are asked as usual. */
export const BOARD_GRANT_BUDGET = { calls: 30, windowMs: 60 * 60 * 1000 } as const;

/** "Liberar teclas e shell" (spec 2026-09-27 TER-325): the `chat_grants.tool` value of a tab trusted for
 * every key and any typed text, and the tools that level (and a project "tudo" grant) covers. Closed on
 * purpose, like `BOARD_GRANT_TOOLS`: `run_command`, `open_tab`, `close_tab` are never covered. */
export const TAB_TERMINAL_GRANT = 'terminal';
export const TERMINAL_GRANT_TOOLS: ReadonlySet<string> = new Set(['send_input', 'send_key']);

/** Whether the terminal level may cover this call: a covered tool, a named tab, and never an answer to
 * a permission dialog (`answering_permission`). The gate adds the tab's state, the screen check and the
 * text rules; the decision routes use this to offer and accept the buttons. */
export function terminalGrantable(tool: string, args: Record<string, unknown>): args is Record<string, unknown> & { tab_id: string } {
  const tab = args.tab_id;
  return TERMINAL_GRANT_TOOLS.has(tool) && args.answering_permission !== true && typeof tab === 'string' && tab.length >= 1 && tab.length <= 64;
}

/** Terminal calls one grant (tab or project) covers per rolling hour; past it, calls are asked. */
export const TERMINAL_GRANT_BUDGET = { calls: 120, windowMs: 60 * 60 * 1000 } as const;

const idArg = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 64;

/**
 * Which standing grant kind ("Liberar sem prazo", spec 2026-09-28 TER-386) may cover this call, or null:
 * a closed map, like the sets above. Terminal calls keep `terminalGrantable`'s rules (never an answer to a
 * permission); the gate adds the tab's state, the screen check and the text rules on top.
 */
export function standingKindOf(tool: string, args: Record<string, unknown>): StandingGrantKind | null {
  if (tool === 'open_tab' || tool === 'start_agent') return idArg(args.project_id) ? tool : null;
  if (tool === 'close_tab') return idArg(args.tab_id) ? 'close_tab' : null;
  if (boardGrantable(tool)) return 'board';
  if (terminalGrantable(tool, args)) return 'terminal';
  return null;
}

/**
 * What the chat does without asking by default, for every user (TER-627): routine, reversible actions.
 * The standing kinds plus `link_tab_task`, under the same guards as a standing grant and stricter ones
 * where the default reaches further (see `defaultGrantCovering` in gate-runtime.ts). A person restricts
 * any of them in "Permissões do chat" (`chat_default_restrictions`), and then it is asked again unless
 * one of their own grants covers it. Closed on purpose, like the sets above: delete_task, run_command,
 * answering a permission, `!`/control characters, an interrupting key, closing a tab at work, the
 * integrations, push_ticket_status and set_project_repo never become a default.
 */
export const DEFAULT_ALLOW_KINDS = ['open_tab', 'start_agent', 'link_tab_task', 'board', 'terminal', 'close_tab'] as const;
export type DefaultAllowKind = (typeof DEFAULT_ALLOW_KINDS)[number];
export const isDefaultAllowKind = (v: unknown): v is DefaultAllowKind => (DEFAULT_ALLOW_KINDS as readonly string[]).includes(v as string);

/** pt-BR, for "Permissões do chat" and the concierge's prompt. */
export const DEFAULT_KIND_LABEL: Record<DefaultAllowKind, string> = {
  open_tab: 'abrir abas',
  start_agent: 'iniciar agentes',
  link_tab_task: 'ligar aba a card',
  board: 'mexer no quadro (criar, mover e editar cards)',
  terminal: 'teclas e texto nas abas de agente',
  close_tab: 'fechar abas paradas',
};

/** Which default kind may cover this call, or null. Mirrors `standingKindOf`, plus `link_tab_task`, and
 * minus the interrupting keys (C-c, Escape): a default never stops a process mid-way. */
export function defaultKindOf(tool: string, args: Record<string, unknown>): DefaultAllowKind | null {
  if (tool === 'link_tab_task') return idArg(args.tab_id) && idArg(args.task_id) ? 'link_tab_task' : null;
  if (tool === 'send_key' && actionClass(tool, args) === 'irreversible') return null;
  return standingKindOf(tool, args);
}

/** The `chat_actions.grant_id` a default-allowed call is audited under: no grant row has it (ids are
 * random, never with a colon), and it names the user so the budget counts one person's calls. */
export const defaultGrantId = (userId: string, kind: DefaultAllowKind): string => `default:${kind}:${userId}`;
export const isDefaultGrantId = (id: string | null | undefined): boolean => typeof id === 'string' && id.startsWith('default:');

/** Calls one standing grant covers per rolling hour, per kind — a brake, not a quota (spec §2). */
export const STANDING_GRANT_BUDGETS: Record<StandingGrantKind, number> = { open_tab: 30, close_tab: 30, start_agent: 10, board: 30, terminal: 120 };

/** Calls the defaults cover per user and rolling hour, per kind (TER-627): the standing budgets, the same
 * brake, counted apart from any grant of the person's own. */
export const DEFAULT_ALLOW_BUDGETS: Record<DefaultAllowKind, number> = { ...STANDING_GRANT_BUDGETS, link_tab_task: 30 };
export const STANDING_BUDGET_WINDOW_MS = 60 * 60 * 1000;

/**
 * Decides whether to allow, ask, wait, or refuse a proposed action.
 * - No row + read class → allow (reads are always safe)
 * - No row + write/irreversible → ask (needs user confirmation)
 * - Pending row → waiting (a decision is pending on the same proposal)
 * - Approved row → allow (user already approved this exact action)
 * - Denied/expired row → refuse (user already rejected or it timed out)
 */
export function gateDecision(
  row: ChatAction | undefined,
  cls: ActionClass,
): 'allow' | 'ask' | 'refuse' | 'waiting' {
  if (!row) {
    // No prior row: reads are always auto-allowed, writes need permission
    return cls === 'read' ? 'allow' : 'ask';
  }

  const status: ChatActionStatus = row.status;

  // Waiting for a decision on the same proposal
  if (status === 'pending') {
    return 'waiting';
  }

  // User already decided: approved means proceed, anything else means no
  if (status === 'approved') {
    return 'allow';
  }

  // Denied, expired, executed, or failed all mean refuse
  return 'refuse';
}
