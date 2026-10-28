/**
 * TER-1134: the cards that sit in a column marked "aguardando" — work that waits on a person or a third party
 * (a lawyer, a test on a device, a store or production authorization). The watcher leaves them out of its
 * alarms; the panel, `get_project_health` and the daily summary list them as "esperando você", each with the
 * note of what is missing when its description has one ("O que falta: …").
 */
import type { Repositories } from '../db/repositories/index.js';

export interface WaitingCard {
  task_id: string;
  ref: string;
  title: string;
  /** the column's name, as the person wrote it */
  column: string;
  /** what is missing, from a "O que falta: …" line of the description; null without one */
  note: string | null;
  /** when the card last changed */
  since: string;
}

export const WAITING_NOTE_MAX = 200;

// "O que falta:", "Falta:", "Aguardando:", "Esperando:", "Waiting on/for:", "Missing:", "Lo que falta:"; a list
// bullet and bold around the label are allowed (`- **O que falta:** …`)
const NOTE_LINE = /^\s*(?:[-*]\s+)?(?:\*\*|__)?(?:o que falta|lo que falta|falta|aguardando|esperando|waiting on|waiting for|missing)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+?)\s*$/im;

/** The "what is missing" line of a description, trimmed to WAITING_NOTE_MAX; null without one. */
export function waitingNote(description: string | null): string | null {
  const m = description ? NOTE_LINE.exec(description) : null;
  const note = m?.[1]?.replace(/^(?:\*\*|__)\s*/, '').trim();
  if (!note) return null;
  return note.length > WAITING_NOTE_MAX ? `${note.slice(0, WAITING_NOTE_MAX - 1)}…` : note;
}

/** The top-level cards of a project in its waiting columns, in board order (column, then card position). */
export async function waitingCards(repos: Repositories, projectId: string): Promise<WaitingCard[]> {
  const columns = (await repos.taskColumns.list(projectId)).filter((c) => c.waiting);
  if (columns.length === 0) return [];
  const order = new Map(columns.map((c, i) => [c.id, i]));
  const name = new Map(columns.map((c) => [c.id, c.name]));
  const tasks = (await repos.tasks.listByProject(projectId)).filter((t) => t.parent_id === null && t.type !== 'epic' && !!t.column_id && order.has(t.column_id));
  tasks.sort((a, b) => (order.get(a.column_id!) ?? 0) - (order.get(b.column_id!) ?? 0) || a.position - b.position);
  return tasks.map((t) => ({ task_id: t.id, ref: t.ref, title: t.title, column: name.get(t.column_id!) ?? '', note: waitingNote(t.description), since: t.updated_at }));
}
