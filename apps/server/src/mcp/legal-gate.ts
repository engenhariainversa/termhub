import { config } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import { t, type Locale } from '../i18n/index.js';

/**
 * API tokens and the MCP wait for the Terms (TER-742, decided on TER-717): while a version that requires
 * acceptance is in force and its owner has not accepted it, every tool call made with one of the
 * account's tokens is refused with this message — personal tokens, agent tab tokens and the chat's
 * token alike. With no version registered, or every one accepted, it is null and nothing changes.
 * initialize and tools/list still answer, so a client connects and the person reads why.
 */
export async function legalRefusal(repos: Repositories, userId: string, locale: Locale): Promise<string | null> {
  const { pending } = await repos.legal.statusFor(userId);
  if (pending.length === 0) return null;
  const terms = pending.some((v) => v.document === 'terms');
  const privacy = pending.some((v) => v.document === 'privacy');
  const url = config.publicUrl;
  if (terms && privacy) {
    return t(locale, 'Falta aceitar os Termos de Uso e a Política de Privacidade em vigor. Até lá, as ferramentas do termhub ficam bloqueadas para os tokens desta conta. Para aceitar, entre no termhub ({{url}}) ou abra o app.', { url });
  }
  if (terms) {
    return t(locale, 'Falta aceitar os Termos de Uso em vigor. Até lá, as ferramentas do termhub ficam bloqueadas para os tokens desta conta. Para aceitar, entre no termhub ({{url}}) ou abra o app.', { url });
  }
  return t(locale, 'Falta aceitar a Política de Privacidade em vigor. Até lá, as ferramentas do termhub ficam bloqueadas para os tokens desta conta. Para aceitar, entre no termhub ({{url}}) ou abra o app.', { url });
}
