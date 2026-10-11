// i18next picks a plural suffix (`_one`, `_other`) through `Intl.PluralRules`. Hermes ships `Intl`
// without `PluralRules`, and i18next then falls back to "1 is one, everything else is other" —
// which is wrong for pt-BR (CLDR: 0 and 1 are both `one`) and would make the phone disagree with
// Jest, which runs on Node's full `Intl`. This installs the CLDR cardinal rules of the three
// languages the app ships, and only when the runtime has no `PluralRules` of its own.

type Category = 'one' | 'other';

/** CLDR cardinal rules: pt — `i = 0..1` (integer part 0 or 1); en — `i = 1 and v = 0`; es — `n = 1` (its `many`, a million and up, reads `_other` here). */
export function cardinalCategory(locale: string, n: number): Category {
  const abs = Math.abs(n);
  const integer = Math.floor(abs);
  if (locale.toLowerCase().startsWith('pt')) return integer === 0 || integer === 1 ? 'one' : 'other';
  return abs === 1 ? 'one' : 'other';
}

class MinimalPluralRules {
  private readonly locale: string;

  constructor(locales?: string | readonly string[]) {
    const first = Array.isArray(locales) ? locales[0] : locales;
    this.locale = typeof first === 'string' && first ? first : 'en';
  }

  select(n: number): Category {
    return cardinalCategory(this.locale, Number(n));
  }

  resolvedOptions(): { locale: string; pluralCategories: Category[]; type: 'cardinal' } {
    return { locale: this.locale, pluralCategories: ['one', 'other'], type: 'cardinal' };
  }

  static supportedLocalesOf(locales: string | readonly string[]): string[] {
    return (Array.isArray(locales) ? [...locales] : [locales]) as string[];
  }
}

/** Installs `MinimalPluralRules` as `Intl.PluralRules` when the runtime lacks one. */
export function ensurePluralRules(target: { Intl?: unknown } = globalThis as { Intl?: unknown }): void {
  if (typeof target.Intl !== 'object' || target.Intl === null) return; // i18next copes with no Intl at all
  const intl = target.Intl as { PluralRules?: unknown };
  if (typeof intl.PluralRules === 'function') return;
  try {
    Object.defineProperty(intl, 'PluralRules', { value: MinimalPluralRules, configurable: true, writable: true });
  } catch {
    // A frozen Intl: i18next's own fallback still yields one/other.
  }
}

export { MinimalPluralRules };
