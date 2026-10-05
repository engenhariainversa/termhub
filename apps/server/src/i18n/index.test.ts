import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { CATALOGS } from './catalog.js';
import { LocalizedText, msg, negotiateLocale, parseLocale, requestLocale, t, tk } from './index.js';

const req = (opts: { user?: { locale: string | null } | null; acceptLanguage?: string } = {}) =>
  ({ user: opts.user ?? null, headers: opts.acceptLanguage ? { 'accept-language': opts.acceptLanguage } : {} }) as unknown as FastifyRequest;

describe('t', () => {
  it('returns the pt-BR key itself in pt-BR', () => {
    expect(t('pt-BR', 'Não encontrado')).toBe('Não encontrado');
  });

  it('looks the English entry up by the pt-BR text', () => {
    expect(t('en', 'Não encontrado')).toBe('Not found');
  });

  it('falls back to the key when there is no entry', () => {
    expect(t('en', 'Texto que não existe no catálogo')).toBe('Texto que não existe no catálogo');
  });

  it('interpolates {{placeholders}} in both languages', () => {
    expect(t('pt-BR', 'A máquina {{name}} está desconectada', { name: 'hulk' })).toBe('A máquina hulk está desconectada');
    expect(t('en', 'A máquina {{name}} está desconectada', { name: 'hulk' })).toBe('Machine hulk is disconnected');
  });

  it('leaves an unknown placeholder as it is', () => {
    expect(t('pt-BR', 'oi {{x}}')).toBe('oi {{x}}');
  });

  it('picks the plural form from count, in both languages', () => {
    const key = 'Excluir {{count}} cards';
    expect(CATALOGS.en[`${key}_one`]).toBeDefined();
    expect(t('pt-BR', key, { count: 1 })).toBe(CATALOGS['pt-BR'][`${key}_one`].replace('{{count}}', '1'));
    expect(t('en', key, { count: 3 })).toBe(CATALOGS.en[`${key}_other`].replace('{{count}}', '3'));
  });

  it('translates a LocalizedText with its own vars', () => {
    const m = msg('A máquina {{name}} está desconectada', { name: 'hulk' });
    expect(m).toBeInstanceOf(LocalizedText);
    expect(String(m)).toBe('A máquina hulk está desconectada');
    expect(t('en', m)).toBe('Machine hulk is disconnected');
  });

  it('tk returns its argument unchanged', () => {
    expect(tk('Perfil')).toBe('Perfil');
  });
});

describe('parseLocale', () => {
  it('accepts only the two locales', () => {
    expect(parseLocale('pt-BR')).toBe('pt-BR');
    expect(parseLocale('en')).toBe('en');
    expect(parseLocale('es')).toBeNull();
    expect(parseLocale(null)).toBeNull();
    expect(parseLocale(undefined)).toBeNull();
  });
});

describe('negotiateLocale', () => {
  it('maps pt* to pt-BR and en* to en', () => {
    expect(negotiateLocale('pt-PT')).toBe('pt-BR');
    expect(negotiateLocale('en-GB')).toBe('en');
    expect(negotiateLocale('pt')).toBe('pt-BR');
  });

  it('honours q order, then header order', () => {
    expect(negotiateLocale('pt-BR;q=0.5, en-US;q=0.9')).toBe('en');
    expect(negotiateLocale('en-US,en;q=0.9,pt-BR;q=0.8')).toBe('en');
    expect(negotiateLocale('es-ES, pt;q=0.7, en;q=0.7')).toBe('pt-BR');
  });

  it('skips other languages and q=0', () => {
    expect(negotiateLocale('es-ES, fr')).toBeNull();
    expect(negotiateLocale('en;q=0, pt;q=0.1')).toBe('pt-BR');
    expect(negotiateLocale(undefined)).toBeNull();
    expect(negotiateLocale('')).toBeNull();
  });
});

describe('requestLocale', () => {
  it('prefers the signed-in user choice over the header', () => {
    expect(requestLocale(req({ user: { locale: 'en' }, acceptLanguage: 'pt-BR' }))).toBe('en');
    expect(requestLocale(req({ user: { locale: 'pt-BR' }, acceptLanguage: 'en' }))).toBe('pt-BR');
  });

  it('falls back to Accept-Language when the user chose nothing', () => {
    expect(requestLocale(req({ user: { locale: null }, acceptLanguage: 'en-US' }))).toBe('en');
    expect(requestLocale(req({ acceptLanguage: 'en-US' }))).toBe('en');
  });

  it('falls back to pt-BR', () => {
    expect(requestLocale(req())).toBe('pt-BR');
    expect(requestLocale(req({ acceptLanguage: 'es' }))).toBe('pt-BR');
  });

  it('reads the phone and /mcp users too', () => {
    const phone = { user: null, mobile: { user: { locale: 'en' } }, headers: {} } as unknown as FastifyRequest;
    expect(requestLocale(phone)).toBe('en');
    const mcp = { user: null, mcp: { ctx: { scope: { user: { locale: 'en' } } } }, headers: {} } as unknown as FastifyRequest;
    expect(requestLocale(mcp)).toBe('en');
  });
});
