import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

/**
 * The web's i18n (spec 2026-10-04 i18n §2–§3). The pt-BR text is the key: `t('Salvar')` shows
 * "Salvar" in pt-BR (no catalog needed) and the `en` catalog's entry in English, falling back to the
 * pt-BR text when an entry is missing. How to translate a screen: ./README.md.
 */
export type Locale = 'pt-BR' | 'en';
export const LOCALES: Locale[] = ['pt-BR', 'en'];
export const DEFAULT_LOCALE: Locale = 'pt-BR';

/** The explicit choice kept in this browser (for the login screen, before the account is known). */
export const LOCALE_STORAGE_KEY = 'termhub:locale';

export function isLocale(value: unknown): value is Locale {
  return value === 'pt-BR' || value === 'en';
}

/**
 * The language to show: the explicit choice, else the first browser language termhub speaks (`pt*`
 * → pt-BR, `en*` → en), else pt-BR. A Spanish browser gets pt-BR until there is a Spanish catalog.
 */
export function resolveLocale(choice: Locale | null, systemLanguages: readonly string[]): Locale {
  if (choice) return choice;
  for (const lang of systemLanguages) {
    const base = lang.toLowerCase().split(/[-_]/)[0];
    if (base === 'pt') return 'pt-BR';
    if (base === 'en') return 'en';
  }
  return DEFAULT_LOCALE;
}

/** Marks a pt-BR key kept in data (a table of labels); translate it where it is shown, with `t(item.label)`. */
export const tk = <T extends string>(text: T): T => text;

export function readStoredLocale(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

function storeLocale(choice: Locale | null): void {
  try {
    if (choice) localStorage.setItem(LOCALE_STORAGE_KEY, choice);
    else localStorage.removeItem(LOCALE_STORAGE_KEY);
  } catch {
    // storage blocked: the choice still applies to this page, and the account keeps it
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

type Catalog = Record<string, string>;

/** `src/locales/<lang>/<area>.json`, merged per language. pt-BR files hold only plural forms. */
function loadCatalogs(): Record<Locale, Catalog> {
  const files = import.meta.glob<{ default: Catalog }>('../locales/*/*.json', { eager: true });
  const out: Record<Locale, Catalog> = { 'pt-BR': {}, en: {} };
  for (const [path, mod] of Object.entries(files)) {
    const lang = path.split('/').at(-2);
    if (isLocale(lang)) Object.assign(out[lang], mod.default);
  }
  return out;
}

const catalogs = loadCatalogs();

export const i18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources: { 'pt-BR': { translation: catalogs['pt-BR'] }, en: { translation: catalogs.en } },
  lng: resolveLocale(readStoredLocale(), browserLanguages()),
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: LOCALES,
  keySeparator: false,
  nsSeparator: false,
  returnEmptyString: false,
  returnNull: false,
  interpolation: { escapeValue: false },
  initAsync: false,
  react: { useSuspense: false },
});

function applyDocumentLang(lng: string) {
  if (typeof document !== 'undefined') document.documentElement.lang = lng;
}
applyDocumentLang(i18n.language);
i18n.on('languageChanged', applyDocumentLang);

/** The language on screen now. */
export function currentLocale(): Locale {
  return isLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
}

/** Changes the language on screen and keeps the choice in this browser; null = automatic (browser languages). */
export function setLocale(next: Locale | null): void {
  storeLocale(next);
  void i18n.changeLanguage(resolveLocale(next, browserLanguages()));
}

export { useTranslation, Trans } from 'react-i18next';
