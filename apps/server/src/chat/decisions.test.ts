import { expect, it, vi } from 'vitest';
import { chatBus, type ChatEvent } from './bus.js';
import { decideMany, pendingBatch } from './decisions.js';
import { HttpError } from '../lib/errors.js';

const row = (id: string, over: Record<string, unknown> = {}) => ({ id, conversation_id: 'c1', status: 'pending', tool: 'move_task', args: {}, class: 'write', ...over });

function repos(rows: Record<string, ReturnType<typeof row>>) {
  return {
    chatActions: {
      findByIdForUser: vi.fn(async (id: string) => rows[id]),
      decide: vi.fn(async (id: string, _u: string, status: string) => (rows[id]?.status === 'pending' ? { ...rows[id], status } : undefined)),
    },
  } as never;
}

it('decides each pending row, publishes each decision, and reports what it skipped', async () => {
  const r = repos({ a1: row('a1'), a2: row('a2', { status: 'approved' }) });
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  try {
    const res = await decideMany(r, 'u1', [{ id: 'a1', decision: 'approve' }, { id: 'a2', decision: 'deny' }, { id: 'nope', decision: 'deny' }]);
    expect(res.decided.map((a) => [a.id, a.status])).toEqual([['a1', 'approved']]);
    expect(res.skipped).toEqual([{ id: 'a2', reason: 'already_decided' }, { id: 'nope', reason: 'not_found' }]);
  } finally {
    off();
  }
  expect(events).toContainEqual(expect.objectContaining({ type: 'decision', action_id: 'a1', status: 'approved', conversation_id: 'c1' }));
});

it('refuses ids of two conversations before deciding anything', async () => {
  const r = repos({ a1: row('a1'), b1: row('b1', { conversation_id: 'c2' }) });
  await expect(decideMany(r, 'u1', [{ id: 'a1', decision: 'approve' }, { id: 'b1', decision: 'approve' }])).rejects.toMatchObject({ statusCode: 400, code: 'MIXED_CONVERSATIONS' });
  expect((r as unknown as { chatActions: { decide: ReturnType<typeof vi.fn> } }).chatActions.decide).not.toHaveBeenCalled();
});

it('409 when nothing is left to decide', async () => {
  const r = repos({ a1: row('a1', { status: 'denied' }) });
  await expect(decideMany(r, 'u1', [{ id: 'a1', decision: 'approve' }])).rejects.toBeInstanceOf(HttpError);
});

it('pendingBatch splits pending rows from the rest, owner-scoped', async () => {
  const r = repos({ a1: row('a1'), a2: row('a2', { status: 'expired' }) });
  expect(await pendingBatch(r, 'u1', ['a1', 'a2', 'x'])).toEqual({ pending: [expect.objectContaining({ id: 'a1' })], skipped: [{ id: 'a2', reason: 'already_decided' }, { id: 'x', reason: 'not_found' }] });
});
