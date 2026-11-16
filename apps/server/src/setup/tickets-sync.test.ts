import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { ExternalTicket } from '../integrations/types.js';

const listTickets = vi.fn();
const getTicket = vi.fn();
vi.mock('../integrations/index.js', () => ({ getProvider: () => ({ listTickets, getTicket }) }));

const { forgetSync, lastSync, startTicketSyncScheduler, syncProjectTickets, ticketRepoKeys } = await import('./tickets-sync.js');
const { effectiveRepos } = await import('./repos.js');
const { normalizeSetup, SETUP_VERSION } = await import('./schema.js');

const ext = (scope: string, n: number): ExternalTicket => ({
  sync_key: `github:${scope}#${n}`, provider: 'github', provider_id: String(n), key: `${scope}#${n}`, title: 't', description: null,
  url: 'u', state: 'open', status: 'backlog', updatedAt: 'x',
});
const src = (scope: string) => ({ provider: 'github' as const, integration_id: 'g', scope, filter: null, sync_minutes: 0 });

function makeRepos() {
  const upsertMany = vi.fn(async () => ({ created: 1, updated: 0, linked: [{ id: 'tk', sync_key: 'github:acme/api#1', task_id: 'task1' }] }));
  const pruneMissing = vi.fn(async () => 0);
  const setExternalRef = vi.fn(async () => undefined);
  const listLeftImported = vi.fn(async (): Promise<unknown[]> => []);
  const markLeftSource = vi.fn(async () => ({}));
  const repos = {
    integrations: { findById: vi.fn(async () => ({ id: 'g', provider: 'github', config: {} })), getSecret: vi.fn(async () => 'tok') },
    tickets: { upsertMany, pruneMissing, listLeftImported, markLeftSource },
    tasks: { setExternalRef },
  } as unknown as Repositories;
  return { repos, upsertMany, pruneMissing, setExternalRef, listLeftImported, markLeftSource };
}

// Block body: an arrow returning the mock itself would be treated as an implicit teardown callback by Vitest.
beforeEach(() => {
  listTickets.mockReset();
  getTicket.mockReset();
});

describe('syncProjectTickets', () => {
  it('syncs every source; two sources on one integration prune only their own scope', async () => {
    listTickets.mockImplementation(async (_s: string, _c: unknown, source: { scope: string }) => ({ tickets: [ext(source.scope, 1)], truncated: source.scope === 'acme/web' }));
    const { repos, pruneMissing, upsertMany } = makeRepos();
    const r = await syncProjectTickets(repos, 'p1', [src('acme/api'), src('acme/web')]);
    expect(pruneMissing).toHaveBeenNthCalledWith(1, 'p1', { integration_id: 'g', scope: 'acme/api' }, ['github:acme/api#1'], false);
    expect(pruneMissing).toHaveBeenNthCalledWith(2, 'p1', { integration_id: 'g', scope: 'acme/web' }, ['github:acme/web#1'], false);
    expect(upsertMany.mock.calls[0][1][0]).toMatchObject({ scope: 'acme/api', key: 'acme/api#1', sync_key: 'github:acme/api#1' });
    expect(r.sources.map((s) => [s.scope, s.truncated])).toEqual([['acme/api', false], ['acme/web', true]]);
    expect(lastSync('p1')?.sources).toHaveLength(2);
  });

  it('a failing source does not stop the others', async () => {
    listTickets.mockRejectedValueOnce(new Error('GitHub 401: bad token')).mockResolvedValueOnce({ tickets: [ext('acme/web', 1)], truncated: false });
    const { repos } = makeRepos();
    const r = await syncProjectTickets(repos, 'p1', [src('acme/api'), src('acme/web')]);
    expect(r.sources[0]).toMatchObject({ scope: 'acme/api', error: 'Falha ao consultar github: GitHub 401: bad token' });
    expect(r.sources[1]).toMatchObject({ scope: 'acme/web', fetched: 1 });
  });

  it('one source on its integration also clears pre-scope rows', async () => {
    listTickets.mockResolvedValue({ tickets: [], truncated: false });
    const { repos, pruneMissing } = makeRepos();
    await syncProjectTickets(repos, 'p1', [src('acme/api')]);
    expect(pruneMissing).toHaveBeenCalledWith('p1', { integration_id: 'g', scope: 'acme/api' }, [], true);
  });

  it('refreshes the link of imported cards with integration_id', async () => {
    listTickets.mockResolvedValue({ tickets: [ext('acme/api', 1)], truncated: false });
    const { repos, setExternalRef } = makeRepos();
    await syncProjectTickets(repos, 'p1', [src('acme/api')]);
    expect(setExternalRef).toHaveBeenCalledWith('task1', expect.objectContaining({ key: 'acme/api#1', integration_id: 'g', scope: 'acme/api' }));
  });

  it('a write failure after fetching does not stop the other sources either', async () => {
    listTickets.mockResolvedValue({ tickets: [ext('acme/web', 1)], truncated: false });
    const { repos, upsertMany } = makeRepos();
    upsertMany.mockRejectedValueOnce(new Error('write failed'));
    const r = await syncProjectTickets(repos, 'p1', [src('acme/api'), src('acme/web')]);
    expect(r.sources[0]).toMatchObject({ scope: 'acme/api', error: 'Falha ao gravar os tickets: write failed' });
    expect(r.sources[1]).toMatchObject({ scope: 'acme/web', fetched: 1 });
  });
});

describe('imported tickets that left their source (TER-718)', () => {
  const imported = { id: 'tk9', provider: 'github', sync_key: 'github:acme/api#9', key: 'acme/api#9', task_id: 'task9', meta: {} };

  it('asks the provider once, stores the real state on the row and the card, and marks it', async () => {
    listTickets.mockResolvedValue({ tickets: [ext('acme/api', 1)], truncated: false });
    getTicket.mockResolvedValue({ ...ext('acme/api', 9), state: 'closed', status: 'done' });
    const { repos, listLeftImported, markLeftSource, setExternalRef } = makeRepos();
    listLeftImported.mockResolvedValueOnce([imported]);
    const r = await syncProjectTickets(repos, 'p1', [src('acme/api')]);
    expect(listLeftImported).toHaveBeenCalledWith('p1', { integration_id: 'g', scope: 'acme/api' }, ['github:acme/api#1'], true, 50);
    expect(getTicket).toHaveBeenCalledWith('tok', {}, { provider_id: '9', key: 'acme/api#9', scope: 'acme/api' });
    expect(markLeftSource).toHaveBeenCalledWith('tk9', expect.objectContaining({ state: 'closed', status: 'done' }));
    expect(setExternalRef).toHaveBeenCalledWith('task9', expect.objectContaining({ key: 'acme/api#9', state: 'closed', scope: 'acme/api' }));
    expect(r.sources[0]).toMatchObject({ left: 1 });
  });

  it('a lookup that fails still marks it, with the last known fields', async () => {
    listTickets.mockResolvedValue({ tickets: [], truncated: false });
    getTicket.mockRejectedValue(new Error('GitHub 404: Not Found'));
    const { repos, listLeftImported, markLeftSource, setExternalRef } = makeRepos();
    listLeftImported.mockResolvedValueOnce([imported]);
    const r = await syncProjectTickets(repos, 'p1', [src('acme/api')]);
    expect(markLeftSource).toHaveBeenCalledWith('tk9');
    expect(setExternalRef).not.toHaveBeenCalledWith('task9', expect.anything());
    expect(r.sources[0]).toMatchObject({ left: 1 });
  });

  it('a truncated source marks nothing: it cannot tell which tickets left', async () => {
    listTickets.mockResolvedValue({ tickets: [ext('acme/api', 1)], truncated: true });
    const { repos, listLeftImported, markLeftSource } = makeRepos();
    const r = await syncProjectTickets(repos, 'p1', [src('acme/api')]);
    expect(listLeftImported).not.toHaveBeenCalled();
    expect(markLeftSource).not.toHaveBeenCalled();
    expect(r.sources[0]).toMatchObject({ left: 0, truncated: true });
  });
});

describe('forgetSync', () => {
  it('drops the project\'s last sync, so the next sync is not throttled', async () => {
    listTickets.mockResolvedValue({ tickets: [], truncated: false });
    await syncProjectTickets(makeRepos().repos, 'p-forget', [src('acme/api')]);
    expect(lastSync('p-forget')).not.toBeNull();
    forgetSync('p-forget');
    expect(lastSync('p-forget')).toBeNull();
  });
});

describe('startTicketSyncScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records each scheduled source in the last sync, replacing that source\'s entry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T12:00:00.000Z'));
    listTickets.mockImplementation(async (_s: string, _c: unknown, source: { scope: string }) => ({ tickets: [ext(source.scope, 1)], truncated: source.scope === 'acme/web' }));
    const { repos } = makeRepos();
    // a manual sync left both sources; acme/web was not truncated then
    listTickets.mockResolvedValueOnce({ tickets: [], truncated: false }).mockResolvedValueOnce({ tickets: [], truncated: false });
    await syncProjectTickets(repos, 'p-sched', [src('acme/api'), src('acme/web')]);
    const auto = { ...src('acme/web'), sync_minutes: 5 };
    Object.assign(repos, {
      projectSetup: {
        listWithAutoSync: vi.fn(async () => [{ project_id: 'p-sched', sources: [auto] }, { project_id: 'p-fresh', sources: [auto] }]),
        get: vi.fn(async () => ({ data: { ticket_sources: [src('acme/api'), auto] } })),
      },
    });
    vi.setSystemTime(new Date('2026-09-26T12:10:00.000Z'));
    const stop = startTicketSyncScheduler(repos, { info: vi.fn(), warn: vi.fn() });
    await vi.advanceTimersByTimeAsync(5_000);
    stop();
    const sched = lastSync('p-sched')!;
    expect(sched.synced_at).toBe('2026-09-26T12:10:05.000Z');
    expect(sched.sources.map((s) => [s.scope, s.truncated])).toEqual([['acme/api', false], ['acme/web', true]]);
    // a project only the scheduler syncs gets a last sync too, so list_tickets shows truncated
    expect(lastSync('p-fresh')?.sources.map((s) => [s.scope, s.truncated])).toEqual([['acme/web', true]]);
  });
});

describe('ticketRepoKeys (spec 2026-10-07 multi-repo §6)', () => {
  const row = (full_name: string, key: string) => ({ id: `r-${key}`, project_id: 'p1', full_name, key, description: null, status: 'ok' as const, discovered_at: '', updated_at: '', checkouts: [] });
  const multi = effectiveRepos(normalizeSetup({ repos: [{ full_name: 'acme/off', enabled: false }] }, SETUP_VERSION), [row('acme/api', 'api'), row('acme/web', 'web'), row('acme/off', 'off')]);

  it("a GitHub ticket whose owner/repo is a repository of the project gets that repository's key", () => {
    expect(ticketRepoKeys({ provider: 'github', scope: 'acme/web' }, multi)).toEqual(['web']);
    expect(ticketRepoKeys({ provider: 'github', scope: 'ACME/API' }, multi)).toEqual(['api']);
  });

  it('anything else is born with no repository', () => {
    expect(ticketRepoKeys({ provider: 'github', scope: 'other/repo' }, multi)).toEqual([]);
    expect(ticketRepoKeys({ provider: 'github', scope: 'acme/off' }, multi)).toEqual([]);
    expect(ticketRepoKeys({ provider: 'github', scope: null }, multi)).toEqual([]);
    expect(ticketRepoKeys({ provider: 'linear', scope: 'acme/api' }, multi)).toEqual([]);
  });

  it('a single-repo project keeps the empty list', () => {
    const single = effectiveRepos(normalizeSetup({ repo: { full_name: 'acme/api' } }, SETUP_VERSION), []);
    expect(ticketRepoKeys({ provider: 'github', scope: 'acme/api' }, single)).toEqual([]);
  });
});
