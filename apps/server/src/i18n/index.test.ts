import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
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
    expect(t('pt-BR', 'A máquina {{machine}} está desconectada', { machine: 'm1' })).toBe('A máquina m1 está desconectada');
    expect(t('en', 'A máquina {{machine}} está desconectada', { machine: 'm1' })).toBe('Machine m1 is disconnected');
  });

  it('leaves an unknown placeholder as it is', () => {
    expect(t('pt-BR', 'oi {{x}}')).toBe('oi {{x}}');
  });

  it('picks the plural form from count, in both languages', () => {
    const key = 'Isso exclui a tarefa "{{title}}" e {{count}} subtarefas; repita com confirm: true para confirmar';
    expect(t('pt-BR', key, { title: 'x', count: 1 })).toBe('Isso exclui a tarefa "x" e 1 subtarefa; repita com confirm: true para confirmar');
    expect(t('pt-BR', key, { title: 'x', count: 3 })).toBe('Isso exclui a tarefa "x" e 3 subtarefas; repita com confirm: true para confirmar');
    expect(t('en', key, { title: 'x', count: 1 })).toBe('This deletes the task "x" and 1 subtask; repeat with confirm: true to confirm');
    expect(t('en', key, { title: 'x', count: 3 })).toBe('This deletes the task "x" and 3 subtasks; repeat with confirm: true to confirm');
  });

  it('translates a LocalizedText value inside the vars into the same language', () => {
    const m = msg('Arquivo maior que o limite de {{size}} para {{kind}}', { size: '10 MB', kind: msg('imagem') });
    expect(t('en', m)).toBe('File larger than the 10 MB limit for image');
    expect(String(m)).toBe('Arquivo maior que o limite de 10 MB para imagem');
  });

  it('translates a LocalizedText with its own vars', () => {
    const m = msg('A máquina {{machine}} está desconectada', { machine: 'm1' });
    expect(m).toBeInstanceOf(LocalizedText);
    expect(String(m)).toBe('A máquina m1 está desconectada');
    expect(t('en', m)).toBe('Machine m1 is disconnected');
  });

  it('looks the Spanish entry up by the pt-BR text, with plurals', () => {
    expect(t('es', 'Não encontrado')).toBe('No encontrado');
    expect(t('es', 'A máquina {{machine}} está desconectada', { machine: 'm1' })).toBe('La máquina m1 está desconectada');
    const key = 'Isso exclui a tarefa "{{title}}" e {{count}} subtarefas; repita com confirm: true para confirmar';
    expect(t('es', key, { title: 'x', count: 1 })).not.toBe(t('es', key, { title: 'x', count: 3 }));
    expect(t('es', key, { title: 'x', count: 1_000_000 })).toBe(t('es', key, { title: 'x', count: 3 }).replace('3', '1000000'));
  });

  it('tk returns its argument unchanged', () => {
    expect(tk('Perfil')).toBe('Perfil');
  });
});

describe('parseLocale', () => {
  it('accepts only the three locales', () => {
    expect(parseLocale('pt-BR')).toBe('pt-BR');
    expect(parseLocale('en')).toBe('en');
    expect(parseLocale('es')).toBe('es');
    expect(parseLocale('fr')).toBeNull();
    expect(parseLocale(null)).toBeNull();
    expect(parseLocale(undefined)).toBeNull();
  });
});

describe('negotiateLocale', () => {
  it('maps pt* to pt-BR, en* to en and es* to es', () => {
    expect(negotiateLocale('pt-PT')).toBe('pt-BR');
    expect(negotiateLocale('en-GB')).toBe('en');
    expect(negotiateLocale('pt')).toBe('pt-BR');
    expect(negotiateLocale('es-AR')).toBe('es');
    expect(negotiateLocale('es')).toBe('es');
  });

  it('honours q order, then header order', () => {
    expect(negotiateLocale('pt-BR;q=0.5, en-US;q=0.9')).toBe('en');
    expect(negotiateLocale('en-US,en;q=0.9,pt-BR;q=0.8')).toBe('en');
    expect(negotiateLocale('es-ES, pt;q=0.7, en;q=0.7')).toBe('es');
    expect(negotiateLocale('fr-FR, pt;q=0.7, en;q=0.7')).toBe('pt-BR');
  });

  it('skips other languages and q=0', () => {
    expect(negotiateLocale('fr-FR, de')).toBeNull();
    expect(negotiateLocale('en;q=0, pt;q=0.1')).toBe('pt-BR');
    expect(negotiateLocale(undefined)).toBeNull();
    expect(negotiateLocale('')).toBeNull();
  });
});

describe('requestLocale', () => {
  it('prefers the signed-in user choice over the header', () => {
    expect(requestLocale(req({ user: { locale: 'en' }, acceptLanguage: 'pt-BR' }))).toBe('en');
    expect(requestLocale(req({ user: { locale: 'pt-BR' }, acceptLanguage: 'en' }))).toBe('pt-BR');
    expect(requestLocale(req({ user: { locale: 'es' }, acceptLanguage: 'en' }))).toBe('es');
  });

  it('falls back to Accept-Language when the user chose nothing', () => {
    expect(requestLocale(req({ user: { locale: null }, acceptLanguage: 'en-US' }))).toBe('en');
    expect(requestLocale(req({ acceptLanguage: 'en-US' }))).toBe('en');
  });

  it('falls back to pt-BR', () => {
    expect(requestLocale(req())).toBe('pt-BR');
    expect(requestLocale(req({ acceptLanguage: 'fr' }))).toBe('pt-BR');
  });

  it('reads the phone and /mcp users too', () => {
    const phone = { user: null, mobile: { user: { locale: 'en' } }, headers: {} } as unknown as FastifyRequest;
    expect(requestLocale(phone)).toBe('en');
    const mcp = { user: null, mcp: { ctx: { scope: { user: { locale: 'en' } } } }, headers: {} } as unknown as FastifyRequest;
    expect(requestLocale(mcp)).toBe('en');
  });
});
