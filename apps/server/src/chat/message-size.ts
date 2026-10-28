import { msg } from '../i18n/index.js';
import { HttpError } from '../lib/errors.js';

/**
 * Refuses a message whose text is past `max` with a reason the person can act on (TER-1139), before the
 * body's schema would refuse it as a bare "Dados inválidos". Counted as the schema counts, in UTF-16
 * units: trimmed for the chat's, as is for a tab's (`trim: false`). Anything that is not a body with a
 * string `text` is left to the schema.
 */
export function assertMessageFits(body: unknown, max: number, { trim = true }: { trim?: boolean } = {}): void {
  const text = body && typeof body === 'object' ? (body as { text?: unknown }).text : undefined;
  if (typeof text !== 'string') return;
  const length = trim ? text.trim().length : text.length;
  if (length > max) throw new HttpError(400, msg('Mensagem grande demais: {{length}} de {{max}} caracteres. Envie o texto como anexo .txt', { length, max }), 'MESSAGE_TOO_LONG');
}
