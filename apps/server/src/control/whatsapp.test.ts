import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listWhatsappGroups, sendWhatsapp } from './whatsapp.js';
import type { ControlContext } from './context.js';
import type { WhatsappSettings } from '../db/repositories/whatsapp-settings.js';

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn(async () => [{ address: '104.21.1.1', family: 4 }]);
  return { lookup, default: { lookup } };
});

const settings: WhatsappSettings = {
  user_id: 'u1',
  server_url: 'https://wpp.example.com',
  instance: 'Minha Instância',
  number: '5562999998888',
  enabled: true,
  notify_needs_you: false,
  notify_done: false,
  last_sent_at: null,
  last_error: null,
  last_error_at: null,
  updated_at: '2026-11-24T00:00:00.000Z',
};

const groups = [
  { id: '120363000000000001@g.us', subject: 'CustomEasy Gestão', size: 5 },
  { id: '120363000000000002@g.us', subject: 'Família', size: 9 },
  { id: '120363000000000003@g.us', subject: 'Futebol', size: 20 },
  { id: '120363000000000004@g.us', subject: 'futebol', size: 3 },
];

let fetchMock: ReturnType<typeof vi.fn>;
let whatsapp: { get: ReturnType<typeof vi.fn>; apiKey: ReturnType<typeof vi.fn>; noteDelivery: ReturnType<typeof vi.fn> };

function ctx(): ControlContext {
  whatsapp = { get: vi.fn(async () => settings), apiKey: vi.fn(async () => 'k-1'), noteDelivery: vi.fn(async () => undefined) };
  return {
    repos: { whatsapp, featureFlags: { overrideFor: vi.fn(async () => true), instanceValue: vi.fn(async () => null) } },
    scope: { user: { id: 'u1', locale: 'pt-BR' } },
  } as unknown as ControlContext;
}

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) =>
    String(url).includes('/group/fetchAllGroups/') ? new Response(JSON.stringify(groups), { status: 200 }) : new Response('{}', { status: 201 }),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const sentBody = () => {
  const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/message/sendText/'));
  return call ? { url: String(call[0]), body: JSON.parse(String((call[1] as RequestInit).body)) } : null;
};

describe('list_whatsapp_groups', () => {
  it('lists the instance groups by name, filtered ignoring accents and case, sending nothing', async () => {
    const all = await listWhatsappGroups(ctx(), {});
    expect(all.total).toBe(4);
    expect(all.groups[0]).toEqual({ id: '120363000000000001@g.us', name: 'CustomEasy Gestão', size: 5 });
    expect(fetchMock.mock.calls[0][0]).toBe('https://wpp.example.com/group/fetchAllGroups/Minha%20Inst%C3%A2ncia?getParticipants=false');
    const some = await listWhatsappGroups(ctx(), { query: 'gestao' });
    expect(some.groups.map((g) => g.name)).toEqual(['CustomEasy Gestão']);
    expect(sentBody()).toBeNull();
  });
});

describe('send_whatsapp destinations', () => {
  it('goes to the person own number without a destination', async () => {
    const r = await sendWhatsapp(ctx(), { text: 'oi' });
    expect(sentBody()?.body).toEqual({ number: '5562999998888', text: 'oi' });
    expect(r.to).toEqual({ kind: 'own', number: '+55 •••• 8888' });
  });

  it('sends to a group by its name (accents and case ignored) or by its id', async () => {
    const r = await sendWhatsapp(ctx(), { text: 'oi', group: 'customeasy gestao' });
    expect(sentBody()?.body.number).toBe('120363000000000001@g.us');
    expect(r.to).toEqual({ kind: 'group', id: '120363000000000001@g.us', name: 'CustomEasy Gestão' });
    fetchMock.mockClear();
    await sendWhatsapp(ctx(), { text: 'oi', group: '120363000000000002@g.us' });
    expect(sentBody()?.body.number).toBe('120363000000000002@g.us');
  });

  it('refuses an unknown or ambiguous group and sends nothing', async () => {
    await expect(sendWhatsapp(ctx(), { text: 'oi', group: 'Trabalho' })).rejects.toMatchObject({ code: 'WHATSAPP_GROUP_NOT_FOUND' });
    await expect(sendWhatsapp(ctx(), { text: 'oi', group: 'Futebol' })).rejects.toMatchObject({ code: 'WHATSAPP_GROUP_AMBIGUOUS' });
    await expect(sendWhatsapp(ctx(), { text: 'oi', group: '999@g.us' })).rejects.toMatchObject({ code: 'WHATSAPP_GROUP_NOT_FOUND' });
    expect(sentBody()).toBeNull();
  });

  it('sends to a contact number, normalized, and refuses a bad one or two destinations', async () => {
    const r = await sendWhatsapp(ctx(), { text: 'oi', number: '+55 (11) 98888-7777' });
    expect(sentBody()?.body.number).toBe('5511988887777');
    expect(r.to).toEqual({ kind: 'number', number: '5511988887777' });
    fetchMock.mockClear();
    await expect(sendWhatsapp(ctx(), { text: 'oi', number: '123' })).rejects.toMatchObject({ code: 'WHATSAPP_BAD_NUMBER' });
    await expect(sendWhatsapp(ctx(), { text: 'oi', number: '5511988887777', group: 'Família' })).rejects.toMatchObject({ code: 'WHATSAPP_TWO_DESTINATIONS' });
    expect(sentBody()).toBeNull();
  });

  it('refuses when paused, whatever the destination', async () => {
    const c = ctx();
    whatsapp.get.mockResolvedValue({ ...settings, enabled: false });
    await expect(sendWhatsapp(c, { text: 'oi', group: 'Família' })).rejects.toMatchObject({ code: 'WHATSAPP_DISABLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
