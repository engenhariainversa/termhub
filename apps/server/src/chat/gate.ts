import { createHash } from 'node:crypto';
import type { ChatAction, ChatActionStatus } from '../db/repositories/chat-actions.js';

export type ActionClass = 'read' | 'write' | 'irreversible';

// Tools classified by reversibility
const readTools = new Set([
  'list_machines',
  'list_projects',
  'list_tabs',
  'list_ai_accounts',
  'find',
  'read_screen',
  'wait_for_state',
  'list_tasks',
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
  'link_project_machine',
  'set_project_machine_cwd',
]);

const irreversibleTools = new Set(['close_tab', 'delete_task']);

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
