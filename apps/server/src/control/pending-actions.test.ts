import { describe, expect, it, vi } from 'vitest';
import type { ControlContext } from './context.js';
import { denyPendingActions, listPendingActions } from './pending-actions.js';
import { chatBus, type ChatEvent } from '../chat/bus.js';
import { actionClass } from '../chat/gate.js';
import { TAB_TOKEN_TOOLS } from '../mcp/tab-token.js';

vi.mock('../db/repositories/chat-actions-view.js', () => ({
  describeActions: vi.fn(async (_repos: unknown, rows: Array<{ id: string; tool: string }>) => rows.map((r) => ({ id: r.id, summary: `resumo de ${r.tool} ${r.id}` }))),
}));

const NOW = new Date('2026-11-16T21:00:00.000Z');

type Row = { id: string; conversation_id: string; status: string; subagent_id: string | null; class?: string; owner?: string };

function ctxWith(rows: Row[], opts: { tab?: boolean; here?: string | null } = {}) {
  const store = new Map(rows.map((r) => [r.id, { ...r, owner: r.owner ?? 'u1' }]));
  const subagents = [
    { id: 's-done', description: 'Criar cards (board liberado)', status: 'completed' },
    { id: 's-live', description: 'Ler o log', status: 'running' },
  ];
  const events: Record<string, unknown>[] = [];
  const full = (r: Row) => ({
    id: r.id,
    conversation_id: r.conversation_id,
    tool: 'create_task',
    class: r.class ?? 'write',
    status: r.status,
    subagent_id: r.subagent_id,
    created_at: '2026-11-16T20:42:47.000Z',
    conversation_project_id: r.conversation_id === 'c-auvp' ? 'p-auvp' : null,
    conversation_project_name: r.conversation_id === 'c-auvp' ? 'auvp' : null,
  });
  const repos = {
    chat: { findByIdForUser: vi.fn(async (id: string, userId: string) => (userId === 'u1' && ['c-auvp', 'c-here'].includes(id) ? { id } : undefined)) },
    chatActions: {
      listPendingForUser: vi.fn(async (userId: string, o: { conversationId?: string; limit: number }) => {
        const mine = [...store.values()].filter((r) => r.owner === userId && r.status === 'pending' && (!o.conversationId || r.conversation_id === o.conversationId));
        return { rows: mine.slice(0, o.limit).map(full), total: mine.length };
      }),
      decide: vi.fn(async (id: string, userId: string, status: string) => {
        const r = store.get(id);
        if (!r || r.owner !== userId || r.status !== 'pending') return undefined;
        r.status = status;
        return full(r);
      }),
      findByIdForUser: vi.fn(async (id: string, userId: string) => {
        const r = store.get(id);
        return r && r.owner === userId ? full(r) : undefined;
      }),
      markInjectedMany: vi.fn(async (ids: string[]) => ids.length),
    },
    chatSubagents: { listByIds: vi.fn(async (ids: string[]) => subagents.filter((s) => ids.includes(s.id))) },
    securityEvents: { record: vi.fn(async (e: Record<string, unknown>) => void events.push(e)) },
  };
  const here = opts.here === undefined ? 'c-here' : opts.here;
  const token = opts.tab ? { id: 'k1', scopes: ['read'], tab: { id: 't1', project_id: 'p1' } } : { id: 'k1', scopes: ['read'], gated: true, chat_conversation_id: here };
  const ctx = {
    repos,
    scope: { user: { id: 'u1', email: 'pessoa@example.com' } },
    scoped: { project: vi.fn(async (id: string) => ({ project: { id } })) },
    token,
  } as unknown as ControlContext;
  return { ctx, repos, events, store };
}

const thirtyOrphans = (): Row[] => Array.from({ length: 30 }, (_, i) => ({ id: `o${i}`, conversation_id: 'c-auvp', status: 'pending', subagent_id: 's-done' }));

describe('list_pending_actions (TER-1192)', () => {
  it('lists the person\'s pending cards of every chat with who asked, whether that subagent still runs, and the age', async () => {
    const { ctx } = ctxWith([
      { id: 'a1', conversation_id: 'c-auvp', status: 'pending', subagent_id: 's-done' },
      { id: 'a2', conversation_id: 'c-here', status: 'pending', subagent_id: 's-live' },
      { id: 'a3', conversation_id: 'c-here', status: 'pending', subagent_id: null, class: 'irreversible' },
      { id: 'a4', conversation_id: 'c-here', status: 'executed', subagent_id: null },
      { id: 'x1', conversation_id: 'c-other', status: 'pending', subagent_id: null, owner: 'u2' },
    ]);
    const r = await listPendingActions(ctx, {}, NOW);
    expect(r.total).toBe(3);
    expect(r.pending.map((p) => p.id)).toEqual(['a1', 'a2', 'a3']);
    expect(r.pending[0]).toMatchObject({
      conversation_id: 'c-auvp',
      this_chat: false,
      project: { id: 'p-auvp', name: 'auvp' },
      summary: 'resumo de create_task a1',
      requested_by: { kind: 'subagent', description: 'Criar cards (board liberado)', running: false },
      orphan: true,
      age_minutes: 17,
    });
    expect(r.pending[1]).toMatchObject({ this_chat: true, requested_by: { kind: 'subagent', running: true }, orphan: false });
    expect(r.pending[2]).toMatchObject({ requested_by: { kind: 'concierge' }, orphan: false, irreversible: true });
  });

  it('refuses a conversation that is not the person\'s', async () => {
    const { ctx } = ctxWith([]);
    await expect(listPendingActions(ctx, { conversation_id: 'c-other' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is never callable from an agent tab', async () => {
    const { ctx, repos } = ctxWith(thirtyOrphans(), { tab: true });
    await expect(listPendingActions(ctx, {})).rejects.toMatchObject({ code: 'NOT_FOR_TABS' });
    await expect(denyPendingActions(ctx, { action_ids: ['o1'] })).rejects.toMatchObject({ code: 'NOT_FOR_TABS' });
    expect(repos.chatActions.decide).not.toHaveBeenCalled();
    expect(TAB_TOKEN_TOOLS).not.toContain('list_pending_actions');
    expect(TAB_TOKEN_TOOLS).not.toContain('deny_pending_action');
  });
});

describe('deny_pending_action (TER-1192)', () => {
  it('is a brake that runs with no card; listing is a read', () => {
    expect(actionClass('deny_pending_action', { action_ids: ['a1'] })).toBe('self_mediated');
    expect(actionClass('list_pending_actions', {})).toBe('read');
  });

  it('refuses every orphan of a chat in one call (50 of them), publishes each and writes one trail row', async () => {
    const rows = [...thirtyOrphans(), ...Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, conversation_id: 'c-auvp', status: 'pending', subagent_id: 's-done' })), { id: 'live', conversation_id: 'c-auvp', status: 'pending', subagent_id: 's-live' }, { id: 'own', conversation_id: 'c-auvp', status: 'pending', subagent_id: null }];
    const { ctx, events, store, repos } = ctxWith(rows);
    const seen: ChatEvent[] = [];
    const off = chatBus.subscribe((e) => seen.push(e));
    const r = await denyPendingActions(ctx, { orphans_of_conversation: 'c-auvp' }, NOW);
    off();
    expect(r.denied).toHaveLength(50);
    expect(store.get('live')!.status).toBe('pending'); // its subagent still runs
    expect(store.get('own')!.status).toBe('pending'); // the concierge's own card is not an orphan
    expect(seen.filter((e) => e.type === 'decision')).toHaveLength(50);
    expect(repos.chatActions.markInjectedMany).not.toHaveBeenCalled(); // another chat: it hears on its next run
    expect(events).toEqual([expect.objectContaining({ action: 'chat_action.deny', actor_id: 'u1', meta: expect.objectContaining({ via: 'mcp', count: 50, orphans_of_conversation: 'c-auvp', conversation_ids: ['c-auvp'] }) })]);
  });

  it('refuses by id across chats, skips what is not pending or not the person\'s, and never approves', async () => {
    const { ctx, repos, store } = ctxWith([
      { id: 'a1', conversation_id: 'c-here', status: 'pending', subagent_id: null },
      { id: 'a2', conversation_id: 'c-auvp', status: 'pending', subagent_id: 's-done' },
      { id: 'a3', conversation_id: 'c-here', status: 'approved', subagent_id: null },
      { id: 'x1', conversation_id: 'c-other', status: 'pending', subagent_id: null, owner: 'u2' },
    ]);
    const r = await denyPendingActions(ctx, { action_ids: ['a1', 'a2', 'a3', 'x1', 'nope'] }, NOW);
    expect(r.denied.map((d) => d.id)).toEqual(['a1', 'a2']);
    expect(r.skipped).toEqual([
      { id: 'a3', reason: 'already_decided' },
      { id: 'x1', reason: 'not_found' },
      { id: 'nope', reason: 'not_found' },
    ]);
    expect(store.get('x1')!.status).toBe('pending');
    expect(repos.chatActions.decide.mock.calls.every((c) => c[2] === 'denied')).toBe(true);
    // This chat's own refusal is not injected back into it as a new turn.
    expect(repos.chatActions.markInjectedMany).toHaveBeenCalledWith(['a1']);
  });

  it('takes exactly one target, and an orphans conversation must be the person\'s', async () => {
    const { ctx, events } = ctxWith(thirtyOrphans());
    await expect(denyPendingActions(ctx, {})).rejects.toMatchObject({ code: 'BAD_TARGET' });
    await expect(denyPendingActions(ctx, { action_ids: ['o1'], orphans_of_conversation: 'c-auvp' })).rejects.toMatchObject({ code: 'BAD_TARGET' });
    await expect(denyPendingActions(ctx, { orphans_of_conversation: 'c-other' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(events).toEqual([]);
  });

  it('writes no trail row when nothing was pending', async () => {
    const { ctx, events } = ctxWith([{ id: 'a1', conversation_id: 'c-here', status: 'denied', subagent_id: null }]);
    const r = await denyPendingActions(ctx, { action_ids: ['a1'] });
    expect(r.denied).toEqual([]);
    expect(events).toEqual([]);
  });
});
