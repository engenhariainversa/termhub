// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { i18n } from '../i18n';

function answer(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

const events: string[] = [];
const record = (e: Event) => events.push(e.type);

beforeEach(() => {
  events.length = 0;
  window.addEventListener('termhub:unauthorized', record);
  window.addEventListener('termhub:pending-deletion', record);
});
afterEach(() => {
  window.removeEventListener('termhub:unauthorized', record);
  window.removeEventListener('termhub:pending-deletion', record);
  vi.unstubAllGlobals();
});

describe('account deletion API errors', () => {
  it('posts the re-authentication to /api/account/deletion', async () => {
    answer(200, { pending: true, requested_at: 'a', scheduled_at: 'b' });
    await api.account.requestDeletion({ code: '123456' });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/account/deletion');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ code: '123456' });
  });

  it('a wrong password does not sign the person out', async () => {
    answer(401, { error: 'Senha incorreta', code: 'REAUTH_FAILED' });
    await expect(api.account.requestDeletion({ password: 'x' })).rejects.toBeInstanceOf(ApiError);
    expect(events).toEqual([]);
  });

  it('any other 401 still does', async () => {
    answer(401, { error: 'Não autenticado' });
    await expect(api.auth.me()).rejects.toBeInstanceOf(ApiError);
    expect(events).toEqual(['termhub:unauthorized']);
  });

  it('a 403 ACCOUNT_PENDING_DELETION tells the auth layer', async () => {
    answer(403, { error: 'Sua conta está desativada', code: 'ACCOUNT_PENDING_DELETION' });
    await expect(api.machines.list()).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_PENDING_DELETION' });
    expect(events).toEqual(['termhub:pending-deletion']);
  });
});

describe('language of the request', () => {
  afterEach(() => {
    void i18n.changeLanguage('pt-BR');
  });

  it('sends Accept-Language with the language on screen', async () => {
    answer(200, { user: {}, view_as: null });
    await api.auth.me();
    void i18n.changeLanguage('en');
    await api.auth.me();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    expect((calls[0][1].headers as Record<string, string>)['accept-language']).toBe('pt-BR');
    expect((calls[1][1].headers as Record<string, string>)['accept-language']).toBe('en');
  });

  it('PATCHes /auth/me/locale with the choice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await api.auth.setLocale(null);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/me/locale');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ locale: null });
  });
});
