import type { TaskType } from './types.js';
import { LocalizedText, tk } from '../../i18n/index.js';

/** Rules the board repositories enforce. Routes answer 409 for EPIC_HAS_CHILDREN and COLUMN_LAST_OF_CATEGORY, 400 for the rest. */
export type TaskRuleCode =
  | 'PARENT_NOT_FOUND'
  | 'PARENT_IS_SUBTASK'
  | 'SUBTASK_CANNOT_MOVE'
  | 'NOT_A_SUBTASK'
  | 'TOO_MANY_SUBTASKS'
  | 'EPIC_REQUIRED'
  | 'EPIC_NOT_FOUND'
  | 'PARENT_TYPE'
  | 'HAS_SUBTASKS'
  | 'TYPE_LOCKED'
  | 'EPIC_HAS_CHILDREN'
  | 'COLUMN_NOT_FOUND'
  | 'COLUMN_NOT_DOING'
  | 'COLUMN_LAST_OF_CATEGORY'
  | 'TOO_MANY_COLUMNS'
  | 'AUTO_NOT_FOR_SUBTASK';

/** Enforced both here and in the route's zod schema (which uses this constant too). */
export const MAX_SUBTASKS_PER_CALL = 50;
export const MAX_COLUMNS = 12;
export const COLUMN_NAME_MAX = 40;

const MESSAGES: Record<TaskRuleCode, string> = {
  PARENT_NOT_FOUND: tk('Tarefa pai não encontrada neste projeto'),
  PARENT_IS_SUBTASK: tk('Uma subtarefa não pode ter subtarefas'),
  SUBTASK_CANNOT_MOVE: tk('Subtarefas não ficam em colunas; mude o status ou reordene'),
  NOT_A_SUBTASK: tk('Só subtarefas são reordenadas aqui; use mover para tarefas do quadro'),
  TOO_MANY_SUBTASKS: tk('No máximo 50 subtarefas por vez'),
  EPIC_REQUIRED: tk('Escolha um épico'),
  EPIC_NOT_FOUND: tk('Épico não encontrado'),
  PARENT_TYPE: tk('Subtarefa só pode ficar em uma história ou tarefa'),
  HAS_SUBTASKS: tk('Tire as subtarefas antes de mudar para bug ou spike'),
  TYPE_LOCKED: tk('Épico e subtarefa não mudam de tipo'),
  EPIC_HAS_CHILDREN: tk('Este épico ainda tem cards'),
  COLUMN_NOT_FOUND: tk('Coluna não encontrada'),
  COLUMN_NOT_DOING: tk('A coluna do agente precisa ser do tipo Fazendo'),
  COLUMN_LAST_OF_CATEGORY: tk('O board precisa de ao menos uma coluna de cada tipo'),
  TOO_MANY_COLUMNS: tk('Limite de 12 colunas'),
  AUTO_NOT_FOR_SUBTASK: tk('Subtarefas não levam a tag automático; marque o card'),
};

/** A board rule was broken. `message` is pt-BR and safe to show to the user; replies translate `localized`. */
export class TaskRuleError extends Error {
  /** Non-enumerable, so equality checks on the error (tests, logs) see only code and message. */
  declare readonly localized: LocalizedText;
  constructor(
    readonly code: TaskRuleCode,
    message: string | LocalizedText = MESSAGES[code],
  ) {
    const localized = message instanceof LocalizedText ? message : new LocalizedText(message);
    super(localized.toString());
    Object.defineProperty(this, 'localized', { value: localized, enumerable: false });
    this.name = 'TaskRuleError';
  }
}

/** The work: what the board shows by default and what every counter counts. */
export const WORK_TYPES: TaskType[] = ['story', 'task', 'bug', 'spike'];
/** The only types that may hold subtasks. */
export const PARENT_TYPES: TaskType[] = ['story', 'task'];

/** Spec §3: types change only among story/task/bug/spike, and a card with subtasks stays a story or task. */
export function checkTypeChange(from: TaskType, to: TaskType, subtaskCount: number): void {
  if (from === to) return;
  if (from === 'epic' || from === 'subtask' || to === 'epic' || to === 'subtask') throw new TaskRuleError('TYPE_LOCKED');
  if (subtaskCount > 0 && !PARENT_TYPES.includes(to)) throw new TaskRuleError('HAS_SUBTASKS');
}

/** A subtask's parent is a top-level story or task (a row with a parent is a subtask, whatever its type says). */
export function checkSubtaskParent(parent: { type: TaskType; parentId: string | null }): void {
  if (parent.parentId || parent.type === 'subtask') throw new TaskRuleError('PARENT_IS_SUBTASK');
  if (!PARENT_TYPES.includes(parent.type)) throw new TaskRuleError('PARENT_TYPE');
}

const REF_RE = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]{0,8})$/;

/** "TER-12" → { key: "TER", number: 12 }; the key is case-insensitive. Null when it is not a ref. */
export function parseRef(ref: string): { key: string; number: number } | null {
  const m = REF_RE.exec(ref.trim());
  return m ? { key: m[1].toUpperCase(), number: Number(m[2]) } : null;
}
