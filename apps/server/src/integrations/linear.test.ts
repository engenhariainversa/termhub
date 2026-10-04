import { afterEach, describe, expect, it, vi } from 'vitest';
import { linear } from './linear.js';

const node = (i: number) => ({ id: `u${i}`, identifier: `EI-${i}`, title: 't', description: null, url: 'u', updatedAt: 'x', priority: 0, state: { name: 'Todo', type: 'unstarted' }, assignee: null, labels: { nodes: [] } });
const page = (nodes: unknown[], next: string | null) =>
  new Response(JSON.stringify({ data: { issues: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } } }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('linear.listTickets', () => {
  it('follows endCursor and names key/provider_id/sync_key', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page([node(1)], 'c1')).mockResolvedValueOnce(page([node(2)], null));
    vi.stubGlobal('fetch', fetch);
    const r = await linear.listTickets('k', {}, { provider: 'linear', integration_id: 'i', scope: 'EI' });
    expect(JSON.parse(fetch.mock.calls[1][1].body).variables.after).toBe('c1');
    expect(r.tickets.map((t) => [t.key, t.provider_id, t.sync_key])).toEqual([['EI-1', 'u1', 'linear:u1'], ['EI-2', 'u2', 'linear:u2']]);
    expect(r.truncated).toBe(false);
  });

  it('keeps open-only with a name filter', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page([], null));
    vi.stubGlobal('fetch', fetch);
    await linear.listTickets('k', {}, { provider: 'linear', integration_id: 'i', scope: 'EI', filter: 'Todo, In Progress' });
    const filter = JSON.parse(fetch.mock.calls[0][1].body).variables.filter;
    expect(filter.state).toEqual({ type: { nin: ['completed', 'canceled'] }, name: { in: ['Todo', 'In Progress'] } });
  });
});

describe('linear.getTicket', () => {
  it('reads one issue by id, completed or not', async () => {
    const done = { ...node(3), state: { name: 'Done', type: 'completed' } };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { issue: done } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const t = await linear.getTicket('k', {}, { provider_id: 'u3', key: 'EI-3', scope: 'EI' });
    expect(JSON.parse(fetch.mock.calls[0][1].body).variables).toEqual({ id: 'u3' });
    expect(t).toMatchObject({ sync_key: 'linear:u3', key: 'EI-3', state: 'Done', status: 'done' });
  });

  it('throws when Linear does not know the issue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { issue: null } }), { status: 200 })));
    await expect(linear.getTicket('k', {}, { provider_id: 'gone', key: 'EI-9', scope: 'EI' })).rejects.toThrow('EI-9');
  });
});
