// The catalogs, merged per language. One JSON file per area of the source tree (spec 2026-10-04 §2):
// adding a file under locales/<lang>/ means adding its import here (`npm run i18n:check` says so).
import type { Locale } from './index.js';

type Catalog = Record<string, string>;
const merge = (...parts: Catalog[]): Catalog => Object.assign({}, ...parts);

export const CATALOGS: Record<Locale, Catalog> = {
  'pt-BR': merge(),
  en: merge(),
};
