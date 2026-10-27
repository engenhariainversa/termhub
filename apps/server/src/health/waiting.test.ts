import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { WAITING_NOTE_MAX, waitingCards, waitingNote } from './waiting.js';

describe('waitingNote (TER-1134)', () => {
  it('reads the "O que falta" line of a description, bullet and bold allowed', () => {
    expect(waitingNote('Contexto.\n\nO que falta: parecer do advogado')).toBe('parecer do advogado');
    expect(waitingNote('- **O que falta:** teste no iPhone')).toBe('teste no iPhone');
    expect(waitingNote('**Falta**: autorização do Pedro')).toBe('autorização do Pedro');
    expect(waitingNote('Waiting on: store review')).toBe('store review');
  });
  it('null without such a line, and trims a long one', () => {
    expect(waitingNote(null)).toBeNull();
    expect(waitingNote('Só contexto, falta nada aqui')).toBeNull();
    expect(waitingNote('O que falta:   ')).toBeNull();
    const note = waitingNote(`O que falta: ${'x'.repeat(500)}`)!;
    expect(note).toHaveLength(WAITING_NOTE_MAX);
    expect(note.endsWith('…')).toBe(true);
  });
});

describe('waitingCards (TER-1134)', () => {
  const t = (id: string, column_id: string | null, position: number, over: object = {}) => ({ id, ref: `TER-${id}`, title: `t${id}`, parent_id: null, type: 'task', column_id, position, description: null, updated_at: '2026-10-27T10:00:00.000Z', ...over });
  it('lists the top-level cards of the waiting columns in board order, with their note', async () => {
    const repos = {
      taskColumns: { list: vi.fn(async () => [{ id: 'doing', name: 'Fazendo', waiting: false }, { id: 'w1', name: 'Esperando validação', waiting: true }, { id: 'w2', name: 'Loja', waiting: true }]) },
      tasks: {
        listByProject: vi.fn(async () => [
          t('3', 'w2', 0),
          t('2', 'w1', 1),
          t('1', 'w1', 0, { description: 'O que falta: parecer do advogado' }),
          t('4', 'doing', 0),
          t('5', 'w1', 2, { type: 'epic' }),
        ]),
      },
    } as unknown as Repositories;
    expect(await waitingCards(repos, 'p1')).toEqual([
      { task_id: '1', ref: 'TER-1', title: 't1', column: 'Esperando validação', note: 'parecer do advogado', since: '2026-10-27T10:00:00.000Z' },
      { task_id: '2', ref: 'TER-2', title: 't2', column: 'Esperando validação', note: null, since: '2026-10-27T10:00:00.000Z' },
      { task_id: '3', ref: 'TER-3', title: 't3', column: 'Loja', note: null, since: '2026-10-27T10:00:00.000Z' },
    ]);
  });
  it('reads no card when the project has no waiting column', async () => {
    const listByProject = vi.fn();
    const repos = { taskColumns: { list: vi.fn(async () => [{ id: 'doing', waiting: false }]) }, tasks: { listByProject } } as unknown as Repositories;
    expect(await waitingCards(repos, 'p1')).toEqual([]);
    expect(listByProject).not.toHaveBeenCalled();
  });
});
