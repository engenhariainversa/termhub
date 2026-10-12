import { mmkv, resetPersistedStores } from '@/services/storage';
import { currentLocale, i18n, LOCALE_STORAGE_KEY, resolveLocale, setLocale, systemLanguages, t, tk, useLocaleStore } from './index';
import { formatDate, formatTime, intlLocale } from './format';
import { cardinalCategory, ensurePluralRules, MinimalPluralRules } from './plural-rules';

afterEach(() => setLocale(null));

describe('resolveLocale (i18n spec §5)', () => {
  it('takes an explicit choice over the system languages', () => {
    expect(resolveLocale('en', ['pt-BR'])).toBe('en');
    expect(resolveLocale('pt-BR', ['en-US'])).toBe('pt-BR');
  });

  it('maps the first pt*, en* or es* system language, in order', () => {
    expect(resolveLocale(null, ['pt-PT'])).toBe('pt-BR');
    expect(resolveLocale(null, ['en-GB'])).toBe('en');
    expect(resolveLocale(null, ['es-AR'])).toBe('es');
    expect(resolveLocale(null, ['fr-FR', 'en-US', 'pt-BR'])).toBe('en');
    expect(resolveLocale(null, ['es-ES', 'en-US', 'pt-BR'])).toBe('es');
    expect(resolveLocale(null, ['fr', 'pt'])).toBe('pt-BR');
  });

  it('falls back to pt-BR for any other language, or none', () => {
    expect(resolveLocale(null, ['fr'])).toBe('pt-BR');
    expect(resolveLocale(null, [])).toBe('pt-BR');
  });
});

describe('the device choice', () => {
  it('runs in pt-BR under the test setup', () => {
    expect(systemLanguages()).toEqual(['pt-BR']);
    expect(currentLocale()).toBe('pt-BR');
    expect(t('Ajustes')).toBe('Ajustes');
  });

  it('switches at once, persists the choice and goes back to automatic with null', () => {
    setLocale('en');
    expect(currentLocale()).toBe('en');
    expect(i18n.language).toBe('en');
    expect(t('Ajustes')).toBe('Settings');
    expect(mmkv.getString(LOCALE_STORAGE_KEY)).toBe('en');
    expect(useLocaleStore.getState()).toEqual({ choice: 'en', locale: 'en' });

    setLocale(null);
    expect(mmkv.getString(LOCALE_STORAGE_KEY)).toBeUndefined();
    expect(useLocaleStore.getState()).toEqual({ choice: null, locale: 'pt-BR' });
    expect(t('Ajustes')).toBe('Ajustes');
  });

  it('keeps the choice when the persisted stores are wiped', () => {
    setLocale('en');
    mmkv.set('theme', '{}');
    resetPersistedStores();
    expect(mmkv.getString('theme')).toBeUndefined();
    expect(mmkv.getString(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('falls back to the pt-BR key when English has no entry, and interpolates without escaping', () => {
    setLocale('en');
    expect(t('Uma frase que nenhum catálogo tem')).toBe('Uma frase que nenhum catálogo tem');
    expect(t('há {{n}} min', { n: 5 })).toBe('5 min ago');
    expect(tk('Perfil')).toBe('Perfil');
  });

  it('shows Spanish from the es catalog', () => {
    setLocale('es');
    expect(currentLocale()).toBe('es');
    expect(t('há {{n}} min', { n: 5 })).toBe('hace 5 min');
    expect(intlLocale()).toBe('es');
  });
});

describe('plurals', () => {
  beforeAll(() => {
    i18n.addResourceBundle('pt-BR', 'translation', { 'test {{count}} abas_one': '{{count}} aba', 'test {{count}} abas_other': '{{count}} abas' }, true, true);
    i18n.addResourceBundle('en', 'translation', { 'test {{count}} abas_one': '{{count}} tab', 'test {{count}} abas_other': '{{count}} tabs' }, true, true);
    i18n.addResourceBundle('es', 'translation', { 'test {{count}} abas_one': '{{count}} pestaña', 'test {{count}} abas_other': '{{count}} pestañas' }, true, true);
  });

  it('pick CLDR forms in both languages', () => {
    expect(t('test {{count}} abas', { count: 1 })).toBe('1 aba');
    expect(t('test {{count}} abas', { count: 0 })).toBe('0 aba'); // CLDR pt: 0 and 1 are "one"
    expect(t('test {{count}} abas', { count: 3 })).toBe('3 abas');
    setLocale('en');
    expect(t('test {{count}} abas', { count: 1 })).toBe('1 tab');
    expect(t('test {{count}} abas', { count: 0 })).toBe('0 tabs');
    setLocale('es');
    expect(t('test {{count}} abas', { count: 1 })).toBe('1 pestaña');
    expect(t('test {{count}} abas', { count: 0 })).toBe('0 pestañas');
  });

  it('the fallback rules (for Hermes, which has no Intl.PluralRules) agree with Node', () => {
    for (const locale of ['pt-BR', 'en', 'es']) {
      const real = new Intl.PluralRules(locale);
      for (const n of [0, 1, 1.5, 2, 5, 21, 100, -1]) expect([locale, n, cardinalCategory(locale, n)]).toEqual([locale, n, real.select(n)]);
    }
  });

  it('installs the fallback only where PluralRules is missing', () => {
    const bare: { Intl: Record<string, unknown> } = { Intl: {} };
    ensurePluralRules(bare);
    expect(bare.Intl.PluralRules).toBe(MinimalPluralRules);
    const rules = new MinimalPluralRules('pt-BR');
    expect(rules.select(0)).toBe('one');
    expect(rules.resolvedOptions().pluralCategories).toEqual(['one', 'other']);

    const own = function PluralRules() {};
    const full: { Intl: Record<string, unknown> } = { Intl: { PluralRules: own } };
    ensurePluralRules(full);
    expect(full.Intl.PluralRules).toBe(own);
  });
});

describe('date helpers', () => {
  const at = new Date(2026, 9, 4, 14, 5);

  it('format in the language the app shows', () => {
    expect(intlLocale()).toBe('pt-BR');
    expect(formatDate(at)).toBe('04/10/2026');
    expect(formatTime(at)).toBe('14:05');
    setLocale('en');
    expect(intlLocale()).toBe('en-US');
    expect(formatDate(at)).toBe('10/4/2026');
    expect(formatTime(at)).toMatch(/^02:05\sPM$/);
  });
});
