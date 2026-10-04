import { afterEach, describe, expect, it, vi } from 'vitest';
import { jiraProvider } from './jira.js';

const issue = (k: string) => ({ id: `id-${k}`, key: k, fields: { summary: 's', description: null, updated: 'x', status: { name: 'To Do', statusCategory: { key: 'new' } } } });
const res = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const cfg = { baseUrl: 'https://acme.atlassian.net', email: 'a@b' };

afterEach(() => vi.unstubAllGlobals());

describe('jira.listTickets', () => {
  it('is open-only and follows nextPageToken', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(res({ issues: [issue('P-1')], nextPageToken: 'n1' }))
      .mockResolvedValueOnce(res({ issues: [issue('P-2')], isLast: true }));
    vi.stubGlobal('fetch', fetch);
    const r = await jiraProvider.listTickets('t', cfg, { provider: 'jira', integration_id: 'i', scope: 'P' });
    const first = JSON.parse(fetch.mock.calls[0][1].body);
    expect(first.jql).toContain('statusCategory != Done');
    expect(JSON.parse(fetch.mock.calls[1][1].body).nextPageToken).toBe('n1');
    expect(r.tickets.map((t) => [t.key, t.provider_id, t.sync_key])).toEqual([['P-1', 'id-P-1', 'jira:P-1'], ['P-2', 'id-P-2', 'jira:P-2']]);
  });
});

describe('jira.getTicket', () => {
  it('reads one issue by id, done or not', async () => {
    const done = { ...issue('P-3'), fields: { ...issue('P-3').fields, status: { name: 'Concluído', statusCategory: { key: 'done' } } } };
    const fetch = vi.fn().mockResolvedValueOnce(res(done));
    vi.stubGlobal('fetch', fetch);
    const t = await jiraProvider.getTicket('t', cfg, { provider_id: 'id-P-3', key: 'P-3', scope: 'P' });
    expect(fetch.mock.calls[0][0]).toMatch(/^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue\/id-P-3\?fields=summary,/);
    expect(t).toMatchObject({ sync_key: 'jira:P-3', key: 'P-3', state: 'Concluído', status: 'done' });
  });
});
