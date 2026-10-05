// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { currentLocale, i18n, LOCALE_STORAGE_KEY, readStoredLocale, resolveLocale, setLocale, tk } from '.';

afterEach(() => {
  localStorage.clear();
  void i18n.changeLanguage('pt-BR');
});

describe('resolveLocale', () => {
  it('maps any Portuguese to pt-BR', () => {
    expect(resolveLocale(null, ['pt-PT'])).toBe('pt-BR');
    expect(resolveLocale(null, ['pt'])).toBe('pt-BR');
    expect(resolveLocale(null, ['pt-BR', 'en-US'])).toBe('pt-BR');
  });

  it('maps any English to en', () => {
    expect(resolveLocale(null, ['en-GB'])).toBe('en');
    expect(resolveLocale(null, ['en'])).toBe('en');
  });

  it('takes the first language termhub speaks, in the browser order', () => {
    expect(resolveLocale(null, ['de-DE', 'en-US', 'pt-BR'])).toBe('en');
    expect(resolveLocale(null, ['fr', 'pt-PT', 'en'])).toBe('pt-BR');
  });

  it('falls back to pt-BR for a language it does not speak, or none', () => {
    expect(resolveLocale(null, ['es'])).toBe('pt-BR');
    expect(resolveLocale(null, ['es-AR', 'fr'])).toBe('pt-BR');
    expect(resolveLocale(null, [])).toBe('pt-BR');
  });

  it('lets an explicit choice win over the browser', () => {
    expect(resolveLocale('en', ['pt-BR'])).toBe('en');
    expect(resolveLocale('pt-BR', ['en-US'])).toBe('pt-BR');
  });
});

describe('setLocale', () => {
  it('keeps the choice in this browser and changes the screen and <html lang>', () => {
    setLocale('en');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    expect(readStoredLocale()).toBe('en');
    expect(currentLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('null forgets the choice and follows the browser again', () => {
    setLocale('en');
    setLocale(null);
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
    expect(currentLocale()).toBe(resolveLocale(null, navigator.languages));
  });
});

describe('t', () => {
  it('shows the pt-BR key itself in pt-BR, and the catalog entry in English', () => {
    expect(i18n.t('Carregando…')).toBe('Carregando…');
    void i18n.changeLanguage('en');
    expect(i18n.t('Carregando…')).toBe('Loading…');
  });

  it('falls back to the pt-BR text when English has no entry', () => {
    void i18n.changeLanguage('en');
    expect(i18n.t('Uma frase que ninguém traduziu')).toBe('Uma frase que ninguém traduziu');
  });

  it('interpolates without escaping (React escapes)', () => {
    expect(i18n.t('Vendo como {{name}}', { name: '<Ana & Bia>' })).toBe('Vendo como <Ana & Bia>');
  });

  it('picks plural forms in both languages', () => {
    expect(i18n.t('{{count}} usuários', { count: 1 })).toBe('1 usuário');
    expect(i18n.t('{{count}} usuários', { count: 3 })).toBe('3 usuários');
    expect(i18n.t('{{count}} usuários', { count: 0 })).toBe('0 usuários');
    void i18n.changeLanguage('en');
    expect(i18n.t('{{count}} usuários', { count: 1 })).toBe('1 user');
    expect(i18n.t('{{count}} usuários', { count: 0 })).toBe('0 users');
  });

  it('tk returns its argument unchanged', () => {
    expect(tk('Perfil')).toBe('Perfil');
  });
});
