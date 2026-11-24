import { describe, expect, it, vi } from 'vitest';
import { maskNumber, noticeMessage, normalizeNumber, whatsappNotice, type WhatsappRepos } from './service.js';
import type { WhatsappSettings } from '../db/repositories/whatsapp-settings.js';
import type { OutgoingNotice } from '../chat/notices/dispatcher.js';

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn(async () => [{ address: '104.21.1.1', family: 4 }]);
  return { lookup, default: { lookup } };
});

const settings: WhatsappSettings = {
  user_id: 'u1',
  server_url: 'https://wpp.example.com',
  instance: 'termhub',
  number: '5562999998888',
  enabled: true,
  notify_needs_you: true,
  notify_done: false,
  last_sent_at: null,
  last_error: null,
  last_error_at: null,
  updated_at: '2026-11-23T00:00:00.000Z',
};

function reposWith(s: WhatsappSettings | null, flag = true) {
  const whatsapp = { get: vi.fn(async () => s), apiKey: vi.fn(async () => (s ? 'k-1' : null)), noteDelivery: vi.fn(async () => undefined) };
  const repos = {
    whatsapp,
    featureFlags: { overrideFor: vi.fn(async () => flag), instanceValue: vi.fn(async () => null) },
    users: { findById: vi.fn(async () => ({ id: 'u1', locale: 'pt-BR' })) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', name: 'termhub' })) },
  } as unknown as WhatsappRepos;
  return { repos, whatsapp };
}

const notice = (level: 'needs_you' | 'done'): OutgoingNotice => ({ userId: 'u1', conversationId: 'c1', projectId: 'p1', messageId: 'm1', level, headline: 'PR #12 precisa da sua aprovação', count: 1 });
const log = { info: vi.fn(), warn: vi.fn() };

describe('numbers', () => {
  it('keeps digits with the country code and refuses the rest', () => {
    expect(normalizeNumber('+55 (62) 99999-8888')).toBe('5562999998888');
    expect(normalizeNumber('12345')).toBeNull();
    expect(normalizeNumber('55 62 abc')).toBeNull();
  });
  it('masks all but the country code and the last four digits', () => {
    expect(maskNumber('5562999998888')).toBe('+55 •••• 8888');
  });
});

describe('noticeMessage', () => {
  it('is the push title in bold, the headline and the link to the project', () => {
    const text = noticeMessage(notice('needs_you'), 'termhub', 'pt-BR');
    expect(text.split('\n')).toEqual(['*termhub precisa de você*', 'PR #12 precisa da sua aprovação', expect.stringMatching(/\/projects\/p1$/)]);
  });
});

describe('whatsappNotice', () => {
  it('sends a level the person ticked, to their own number, and records it', async () => {
    const { repos, whatsapp } = reposWith(settings);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 201 }));
    await expect(whatsappNotice({ repos, log, fetchImpl: fetchImpl as unknown as typeof fetch }, notice('needs_you'))).resolves.toBe('sent');
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).number).toBe('5562999998888');
    expect(whatsapp.noteDelivery).toHaveBeenCalledWith('u1', null);
  });

  it('skips a level left off for WhatsApp, a paused setup, no setup and the flag off', async () => {
    const fetchImpl = vi.fn();
    const deps = (s: WhatsappSettings | null, flag = true) => ({ repos: reposWith(s, flag).repos, log, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(whatsappNotice(deps(settings), notice('done'))).resolves.toBe('skipped');
    await expect(whatsappNotice(deps({ ...settings, enabled: false }), notice('needs_you'))).resolves.toBe('skipped');
    await expect(whatsappNotice(deps(null), notice('needs_you'))).resolves.toBe('skipped');
    await expect(whatsappNotice(deps(settings, false), notice('needs_you'))).resolves.toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws: a failure is logged by code and kept as the last error', async () => {
    const { repos, whatsapp } = reposWith(settings);
    const fetchImpl = vi.fn(async () => new Response('{"apikey":"k-1"}', { status: 401 }));
    await expect(whatsappNotice({ repos, log, fetchImpl: fetchImpl as unknown as typeof fetch }, notice('needs_you'))).resolves.toBe('failed');
    expect(whatsapp.noteDelivery).toHaveBeenCalledWith('u1', 'AUTH');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('k-1');
  });
});
