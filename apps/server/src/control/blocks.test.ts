import { describe, expect, it, vi } from 'vitest';
import type { ControlContext } from './context.js';
import { blockAction, listBlocksTool, unblockAction } from './blocks.js';

function ctxWith(on: boolean) {
  const created: unknown[] = [];
  const repos = {
    featureFlags: { overrideFor: vi.fn(async () => (on ? true : null)), instanceValue: vi.fn(async () => null) },
    chatDefaultRestrictions: { listForUser: vi.fn(async () => new Set()) },
    chatBlocks: {
      listActive: vi.fn(async () => []),
      countActive: vi.fn(async () => 0),
      create: vi.fn(async (input: Record<string, unknown>) => { created.push(input); return { block: { id: 'b1', conversation_id: null, created_at: 'now', revoked_at: null, words: [], ...input }, created: true }; }),
      revoke: vi.fn(async () => undefined),
    },
    projects: { findByIdsForOwner: vi.fn(async (ids: string[]) => ids.filter((i) => i === 'p1').map((id) => ({ id, name: 'Piki' }))) },
  };
  const scoped = { project: vi.fn(async (id: string) => { if (id !== 'p1') throw Object.assign(new Error('nf'), { code: 'NOT_FOUND' }); return { project: { id, name: 'Piki' } }; }) };
  const ctx = { repos, scoped, scope: { user: { id: 'u1' } }, token: { gated: true, chat_conversation_id: 'c1' } } as unknown as ControlContext;
  return { ctx, repos, created };
}

describe('block tools (TER-1164)', () => {
  it('refuse while the open model is off, and list says on: false', async () => {
    const { ctx, repos } = ctxWith(false);
    await expect(blockAction(ctx, { kind: 'board' })).rejects.toMatchObject({ code: 'OPEN_PERMISSIONS_OFF' });
    await expect(unblockAction(ctx, { block_id: 'b1' })).rejects.toMatchObject({ code: 'OPEN_PERMISSIONS_OFF' });
    expect(await listBlocksTool(ctx, {})).toMatchObject({ on: false, blocks: [] });
    expect(repos.chatBlocks.create).not.toHaveBeenCalled();
  });

  it('block_action records a run_command block for a project, in the person\'s words', async () => {
    const { ctx, created } = ctxWith(true);
    const { block } = await blockAction(ctx, { kind: 'run_command', project_id: 'p1', command: 'git push' });
    expect(created).toEqual([{ user_id: 'u1', project_id: 'p1', kind: 'run_command', words: ['git', 'push'], effect: 'ask', conversation_id: 'c1' }]);
    expect(block.text).toBe('rodar «git push…» no projeto Piki (pedir antes; id b1)');
  });

  it('block_action refuses a command for another kind', async () => {
    const { ctx } = ctxWith(true);
    await expect(blockAction(ctx, { kind: 'board', command: 'git push' })).rejects.toMatchObject({ code: 'BLOCK_INVALID' });
  });

  it('unblock_action sends a restricted default to Permissões do chat, and 404s an unknown block', async () => {
    const { ctx } = ctxWith(true);
    await expect(unblockAction(ctx, { block_id: 'restriction:terminal' })).rejects.toMatchObject({ code: 'BLOCK_IS_RESTRICTION' });
    await expect(unblockAction(ctx, { block_id: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
