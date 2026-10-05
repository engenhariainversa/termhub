import type { FastifyRequest } from 'fastify';
import { CATALOGS } from './catalog.js';

/**
 * Server-side translation (spec 2026-10-04 i18n). The pt-BR text is the key: `t('en', 'Projeto não
 * encontrado')` looks the English entry up in `locales/en/*.json` and falls back to the key itself, so
 * a missing entry shows Portuguese instead of a key. `{{name}}` placeholders are interpolated; with a
 * numeric `count`, i18next-style plural suffixes (`_one`, `_other`) are looked up first, and plural
 * keys have entries in both catalogs (pt-BR included). `npm run i18n:check` keeps the catalogs honest.
 */
export type Locale = 'pt-BR' | 'en';
export const LOCALES: readonly Locale[] = ['pt-BR', 'en'];
export const DEFAULT_LOCALE: Locale = 'pt-BR';

/** Interpolation values; a LocalizedText value is translated into the same language (a label inside a message). */
export type Vars = Record<string, string | number | LocalizedText>;

/** A message whose language is decided later (an HttpError or ControlError translated at reply time). */
export class LocalizedText {
  constructor(
    readonly text: string,
    readonly vars?: Vars,
  ) {}
  /** The pt-BR rendering: what `Error.message` carries and what logs and pt-BR tests see. */
  toString(): string {
    return t(DEFAULT_LOCALE, this.text, this.vars);
  }
}

/** A lazily translated message: `new HttpError(404, msg('Projeto {{name}} não existe', { name }))`. */
export function msg(text: string, vars?: Vars): LocalizedText {
  return new LocalizedText(text, vars);
}

/** Marks a pt-BR key kept in a constant or table so `i18n:check` finds it; returns it unchanged. */
export const tk = <T extends string>(text: T): T => text;

const pluralRules = new Map<Locale, Intl.PluralRules>();
function pluralCategory(locale: Locale, count: number): string {
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)));
  return rules.select(count);
}

function lookup(locale: Locale, key: string, vars: Vars | undefined): string | undefined {
  const catalog = CATALOGS[locale];
  if (vars && typeof vars.count === 'number') {
    const form = catalog[`${key}_${pluralCategory(locale, vars.count)}`] ?? catalog[`${key}_other`];
    if (form !== undefined) return form;
  }
  return catalog[key];
}

function interpolate(locale: Locale, text: string, vars: Vars | undefined): string {
  if (!vars) return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => {
    if (!(name in vars)) return whole;
    const v = vars[name];
    return v instanceof LocalizedText ? t(locale, v) : String(v);
  });
}

/** Translates a pt-BR key (or a LocalizedText, whose own vars are used) into `locale`. */
export function t(locale: Locale, text: string | LocalizedText, vars?: Vars): string {
  if (text instanceof LocalizedText) return t(locale, text.text, text.vars);
  const found = lookup(locale, text, vars) ?? (locale !== DEFAULT_LOCALE ? lookup(DEFAULT_LOCALE, text, vars) : undefined) ?? text;
  return interpolate(locale, found, vars);
}

/** A stored or sent value narrowed to a Locale; anything else (null included) is null = automatic. */
export function parseLocale(value: unknown): Locale | null {
  return value === 'pt-BR' || value === 'en' ? value : null;
}

/** The locale for someone with this stored choice (null/unknown → pt-BR). */
export function localeOf(value: unknown): Locale {
  return parseLocale(value) ?? DEFAULT_LOCALE;
}

/**
 * Picks a locale from an `Accept-Language` header: languages in q order (ties keep header order),
 * the first `pt*` → pt-BR, the first `en*` → en; nothing usable → null. Spanish and other languages
 * are skipped on purpose (a Spanish reader is closer to pt-BR until TER-406).
 */
export function negotiateLocale(header: string | string[] | undefined): Locale | null {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return null;
  const ranked = raw
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((r) => r.tag && r.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranked) {
    if (tag === 'pt' || tag.startsWith('pt-')) return 'pt-BR';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return null;
}

interface MaybeUser {
  locale?: string | null;
}

/** The signed-in person behind a request, whichever door it came through (web session, phone, /mcp). */
function requestUser(request: FastifyRequest): MaybeUser | null {
  const r = request as FastifyRequest & {
    user?: MaybeUser | null;
    mobile?: { user?: MaybeUser };
    mcp?: { ctx: { scope: { user: MaybeUser } } };
  };
  return r.user ?? r.mobile?.user ?? r.mcp?.ctx.scope.user ?? null;
}

/** The person's choice → `Accept-Language` → pt-BR (for a WebSocket upgrade, which is not a Fastify request). */
export function pickLocale(userLocale: unknown, acceptLanguage: string | string[] | undefined): Locale {
  return parseLocale(userLocale) ?? negotiateLocale(acceptLanguage) ?? DEFAULT_LOCALE;
}

/** A request's language: the signed-in user's choice → `Accept-Language` → pt-BR. */
export function requestLocale(request: FastifyRequest): Locale {
  return pickLocale(requestUser(request)?.locale, request.headers['accept-language']);
}
