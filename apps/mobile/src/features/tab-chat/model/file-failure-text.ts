// Why a file for a session did not reach the tab's machine (TER-1105), in the language the app shows.
// The server's own refusals (machine offline, no access, too large) already come translated; what is
// left is a proxy's answer (an HTML 413 has no JSON) or no answer at all.
import { TAB_FILE_MAX_BYTES } from '@termhub/mobile-api';
import { t } from '@/i18n';
import { ApiError } from '@/services/api/errors';

const MAX_MB = Math.round(TAB_FILE_MAX_BYTES / (1024 * 1024));

/** "Arquivo grande demais", with the limit: the size check before the upload and a 413 say the same. */
export function tabFileTooLargeText(): string {
  return t('Arquivo grande demais: o limite numa sessão é {{max}} MB.', { max: MAX_MB });
}

/** Whether a picked file is over the limit of a session's files; an unknown size goes through (the server measures it). */
export const tabFileTooLarge = (bytes: number | null): boolean => bytes !== null && bytes > TAB_FILE_MAX_BYTES;

export function tabFileFailureText(e: unknown): string {
  if (!(e instanceof ApiError)) return t('Não foi possível enviar o arquivo: sem conexão com o servidor.');
  if (e.status === 413) return tabFileTooLargeText();
  // `HTTP_<status>`: the body was not the server's JSON, so its message says nothing about the file.
  if (e.code.startsWith('HTTP_')) return t('Não foi possível enviar o arquivo (erro {{status}}).', { status: e.status });
  return t('Não foi possível enviar o arquivo: {{reason}}', { reason: e.message });
}
