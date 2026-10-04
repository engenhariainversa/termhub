import { afterEach, describe, expect, it, vi } from 'vitest';
import { github } from './github.js';

const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n, title: `T${n}`, body: null, html_url: `https://github.com/acme/api/issues/${n}`, state: 'open', updated_at: 'x', labels: [], assignee: null, ...extra,
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('github.listTickets', () => {
  it('pulls open issues only, pages until a short page, skips PRs, keys as owner/repo#n', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(Array.from({ length: 100 }, (_, i) => issue(i + 1, i === 0 ? { pull_request: {} } : {}))))
      .mockResolvedValueOnce(json([issue(101)]));
    vi.stubGlobal('fetch', fetch);
    const r = await github.listTickets('tok', {}, { provider: 'github', integration_id: 'i', scope: 'acme/api', filter: null });
    expect(fetch.mock.calls[0][0]).toContain('/repos/acme/api/issues?state=open&per_page=100&page=1');
    expect(fetch.mock.calls[1][0]).toContain('page=2');
    expect(r.truncated).toBe(false);
    expect(r.tickets).toHaveLength(100);
    expect(r.tickets[0]).toMatchObject({ sync_key: 'github:acme/api#2', key: 'acme/api#2', provider_id: '2' });
  });

  it('stops at 500 and reports truncated', async () => {
    const fetch = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return json(Array.from({ length: 100 }, (_, i) => issue((page - 1) * 100 + i + 1)));
    });
    vi.stubGlobal('fetch', fetch);
    const r = await github.listTickets('tok', {}, { provider: 'github', integration_id: 'i', scope: 'acme/api' });
    expect(r.tickets).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });
});

describe('github.getTicket', () => {
  it('reads one issue whatever its state; a closed one is done', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(issue(7, { state: 'closed' })));
    vi.stubGlobal('fetch', fetch);
    const t = await github.getTicket('tok', {}, { provider_id: '7', key: 'acme/api#7', scope: 'acme/api' });
    expect(fetch.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/api/issues/7');
    expect(t).toMatchObject({ sync_key: 'github:acme/api#7', key: 'acme/api#7', state: 'closed', status: 'done' });
  });
});
