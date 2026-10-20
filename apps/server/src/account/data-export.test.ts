import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { DataExport, UserDataBundle } from '../db/repositories/data-exports.js';
import type { User } from '../db/repositories/types.js';
import type { Mail } from '../email/mailer.js';
import { DataExportService, EXPORT_COOLDOWN_MS, EXPORT_STALE_MS, EXPORT_TTL_MS } from './data-export.js';
import { safeFileName } from './export-archive.js';

function user(id: string, overrides: Partial<User> = {}): User {
  return {
    id, email: `${id}@example.com`, name: id, avatar_url: null, nickname: null, city_short_url_partner: null, city_short_url_custom: null,
    password_hash: 'x', google_id: null, role: 'member', role_id: 'r', invited_at: null, last_login_at: null, review_enabled_until: null,
    review_enabled_by: null, deletion_requested_at: null, deletion_scheduled_at: null, created_at: '', ...overrides,
  };
}

function bundle(userId: string): UserDataBundle {
  return {
    account: { id: userId, email: `${userId}@example.com` },
    projects: [{ id: `p-${userId}`, key: 'ABC', name: 'Projeto' }],
    project_machines: [], project_setups: [], project_groups: [], columns: [],
    cards: [{ id: `t-${userId}`, project_id: `p-${userId}`, title: 'Card' }],
    pull_requests: [],
    notes: [{ id: `n-${userId}`, project_id: `p-${userId}`, content: '# Nota' }],
    tickets: [], tabs: [], last_answers: [], tab_questions: [], conversations: [], messages: [], actions: [], decisions: [],
    attachments: [
      { id: 'a1', name: 'foto/../x.png', kind: 'image' },
      { id: 'a2', name: 'sumiu.txt', kind: 'text' },
    ],
    memory: [], machines: [], integrations: [], ai_accounts: [], api_tokens: [], uploads: [], devices: [], device_events: [], notifications: [],
  };
}

/** The repository in memory, with the same conditional transitions as the real one. */
function fakeRepo(now: () => Date) {
  const rows = new Map<string, DataExport>();
  let seq = 0;
  const latest = (userId: string, ok: (r: DataExport) => boolean = () => true) =>
    [...rows.values()].filter((r) => r.user_id === userId && ok(r)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const stale = (r: DataExport, before: Date) => r.status === 'running' && !!r.started_at && new Date(r.started_at) < before;
  return {
    rows,
    create: async (userId: string) => {
      const r: DataExport = { id: `x${++seq}`, user_id: userId, status: 'pending', attempts: 0, bytes: null, error_code: null, started_at: null, completed_at: null, expires_at: null, downloaded_at: null, created_at: now().toISOString() };
      rows.set(r.id, r);
      return { ...r };
    },
    findById: async (id: string) => rows.get(id),
    latestForUser: async (userId: string) => latest(userId),
    latestCountedSince: async (userId: string, since: Date) => latest(userId, (r) => r.status !== 'failed' && new Date(r.created_at) > since),
    claim: async (id: string, at: Date, before: Date, max: number) => {
      const r = rows.get(id);
      if (!r || r.attempts >= max || !(r.status === 'pending' || stale(r, before))) return undefined;
      Object.assign(r, { status: 'running', started_at: at.toISOString(), attempts: r.attempts + 1 });
      return r;
    },
    listClaimable: async (before: Date) => [...rows.values()].filter((r) => r.status === 'pending' || stale(r, before)).map((r) => r.id),
    failExhausted: async () => 0,
    markReady: async (id: string, bytes: number, at: Date, expiresAt: Date) => {
      const r = rows.get(id);
      if (r?.status !== 'running') return false;
      Object.assign(r, { status: 'ready', bytes, completed_at: at.toISOString(), expires_at: expiresAt.toISOString() });
      return true;
    },
    markFailed: async (id: string, code: string) => {
      const r = rows.get(id);
      if (r?.status === 'running') Object.assign(r, { status: 'failed', error_code: code });
    },
    markDownloaded: async (id: string, at: Date) => {
      const r = rows.get(id);
      if (r && !r.downloaded_at) r.downloaded_at = at.toISOString();
    },
    expireDue: async (at: Date) => {
      const due = [...rows.values()].filter((r) => r.status === 'ready' && r.expires_at && new Date(r.expires_at) <= at);
      for (const r of due) r.status = 'expired';
      return due.map((r) => r.id);
    },
    liveFileIds: async (ids: string[]) => new Set(ids.filter((id) => ['pending', 'running', 'ready'].includes(rows.get(id)?.status ?? ''))),
    collect: vi.fn(async (userId: string) => bundle(userId)),
  };
}

describe('DataExportService', () => {
  let dir: string;
  let clock: Date;
  let repo: ReturnType<typeof fakeRepo>;
  let sent: Mail[];
  let service: DataExportService;
  const ana = user('ana', { locale: 'en' } as Partial<User>);
  const bia = user('bia');

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'th-export-'));
    clock = new Date('2026-10-07T12:00:00.000Z');
    repo = fakeRepo(() => clock);
    sent = [];
    const users = new Map([ana, bia].map((u) => [u.id, u]));
    const repos = { dataExports: repo, users: { findById: async (id: string) => users.get(id) } } as unknown as Repositories;
    service = new DataExportService({
      repos,
      mailer: { send: async (m: Mail) => void sent.push(m) } as never,
      dir: path.join(dir, '.exports'),
      readAttachment: async (_userId, id) => {
        if (id === 'a1') return new Uint8Array([1, 2, 3]);
        throw new Error('ENOENT');
      },
      appUrl: 'https://app.example.com',
      log: { info: () => {}, warn: () => {} } as never,
      now: () => clock,
    });
    vi.spyOn(global, 'setImmediate').mockImplementation((() => 0) as never);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('builds a zip of the account, mails a link to Perfil and serves it to its own account only', async () => {
    const status = await service.request(ana);
    expect(status.export?.status).toBe('pending');
    const id = status.export!.id;
    expect(await service.build(id)).toBe(true);
    expect(repo.collect).toHaveBeenCalledWith('ana');

    const row = repo.rows.get(id)!;
    expect(row.status).toBe('ready');
    expect(new Date(row.expires_at!).getTime()).toBe(clock.getTime() + EXPORT_TTL_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('ana@example.com');
    expect(sent[0]!.text).toContain('https://app.example.com/settings/profile');

    const download = await service.openDownload(ana, id);
    expect(download.filename).toBe('termhub-2026-10-07.zip');
    const files = unzipSync(new Uint8Array(await readFile(download.file)));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['README.txt', 'account.json', 'projects/cards.json', 'projects/notes/ABC.md', 'chat/attachments.json']));
    expect(strFromU8(files['README.txt']!)).toContain('Export of your termhub data');
    expect(JSON.parse(strFromU8(files['projects/cards.json']!))).toEqual([{ id: 't-ana', project_id: 'p-ana', title: 'Card' }]);
    expect(strFromU8(files['projects/notes/ABC.md']!)).toBe('# Nota');
    // The attachment that is still on the volume goes in; the one that is gone is listed with file: null.
    const attachments = JSON.parse(strFromU8(files['chat/attachments.json']!));
    expect(attachments.map((a: { file: string | null }) => a.file)).toEqual([`chat/attachments/a1-${safeFileName('foto/../x.png')}`, null]);
    expect([...files[attachments[0].file]!]).toEqual([1, 2, 3]);
    expect(repo.rows.get(id)!.downloaded_at).not.toBeNull();

    // Another account never gets it, nor learns it exists.
    await expect(service.openDownload(bia, id)).rejects.toMatchObject({ statusCode: 404, code: 'EXPORT_NOT_FOUND' });
  });

  it('allows one request a day, and none while one is being built', async () => {
    const first = await service.request(ana);
    await expect(service.request(ana)).rejects.toMatchObject({ statusCode: 409, code: 'EXPORT_IN_PROGRESS' });
    await service.build(first.export!.id);
    await expect(service.request(ana)).rejects.toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    const status = await service.status(ana);
    expect(status.next_allowed_at).toBe(new Date(clock.getTime() + EXPORT_COOLDOWN_MS).toISOString());
    // Another person is not limited by Ana's request.
    await expect(service.request(bia)).resolves.toMatchObject({ export: { status: 'pending' } });
    clock = new Date(clock.getTime() + EXPORT_COOLDOWN_MS);
    await expect(service.request(ana)).resolves.toMatchObject({ export: { status: 'pending' } });
  });

  it('a failed build does not count against the daily limit', async () => {
    repo.collect.mockRejectedValueOnce(new Error('db down'));
    const first = await service.request(ana);
    expect(await service.build(first.export!.id)).toBe(false);
    expect(repo.rows.get(first.export!.id)!.status).toBe('failed');
    expect(await readdir(path.join(dir, '.exports')).catch(() => [])).toEqual([]);
    clock = new Date(clock.getTime() + 1000);
    await expect(service.request(ana)).resolves.toMatchObject({ export: { status: 'pending' } });
  });

  it('the job builds what waits, takes over a build cut short, then expires and removes old archives', async () => {
    const { export: e } = await service.request(ana);
    // Another color claimed it and went away mid-build.
    await repo.claim(e!.id, clock, new Date(0), 3);
    await service.runDue();
    expect(repo.rows.get(e!.id)!.status).toBe('running');
    clock = new Date(clock.getTime() + EXPORT_STALE_MS + 1000);
    await service.runDue();
    expect(repo.rows.get(e!.id)!.status).toBe('ready');
    expect(repo.rows.get(e!.id)!.attempts).toBe(2);

    // A stray file with no live row (an account deleted meanwhile) is swept.
    await writeFile(path.join(dir, '.exports', 'gone1.zip'), 'x');
    clock = new Date(clock.getTime() + EXPORT_TTL_MS);
    expect((await service.status(ana)).export?.status).toBe('expired');
    await service.runDue();
    expect(repo.rows.get(e!.id)!.status).toBe('expired');
    expect(await readdir(path.join(dir, '.exports'))).toEqual([]);
    await expect(service.openDownload(ana, e!.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
