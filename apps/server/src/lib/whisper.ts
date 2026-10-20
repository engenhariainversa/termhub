import { negotiateLocale, parseLocale, type Locale } from '../i18n/index.js';

/** Headers of a POST to docker/whisper: the clip's type and, when there is one, the shared secret. */
export function whisperHeaders(mime: string, secret: string | null | undefined): Record<string, string> {
  return secret ? { 'content-type': mime, authorization: `Bearer ${secret}` } : { 'content-type': mime };
}

const WHISPER_CODE: Record<Locale, string> = { 'pt-BR': 'pt', en: 'en', es: 'es' };

/**
 * The languages a clip is likely in, best first (TER-1096): the language the client shows (both send it as
 * `Accept-Language`), then the one chosen on the account. Whisper detects the language itself and only
 * falls back to these when it is unsure.
 */
export function languageHints(acceptLanguage: string | string[] | undefined, accountLocale: unknown): string[] {
  const out: string[] = [];
  for (const locale of [negotiateLocale(acceptLanguage), parseLocale(accountLocale)]) {
    const code = locale ? WHISPER_CODE[locale] : null;
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/** Hints kept on a row's meta are only trusted as far as their shape. */
export function hintsOf(meta: Record<string, unknown> | null | undefined): string[] {
  const raw = meta?.language_hints;
  return Array.isArray(raw) ? raw.filter((h): h is string => typeof h === 'string' && /^[a-z]{2,3}$/.test(h)).slice(0, 5) : [];
}

/**
 * The `/transcribe` URL: `language` is "auto" (detect, the default) or a code the operator forced with
 * `WHISPER_LANGUAGE`; never a translation, the text stays in the language spoken.
 */
export function transcribeUrl(base: string, language: string | null | undefined, hints: string[]): string {
  const q = new URLSearchParams({ language: language || 'auto' });
  if (hints.length > 0) q.set('hints', hints.join(','));
  return `${base}/transcribe?${q.toString()}`;
}
