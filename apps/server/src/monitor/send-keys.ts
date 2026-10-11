import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { INPUT_MAX_CHARS, sendTextToSession } from '../terminal/session-ops.js';
import { tk } from '../i18n/index.js';

// Declared once in session-ops.ts (a future control/terminals.ts will use it too); re-exported
// here so apps/server/src/routes/tabs.ts keeps its existing named import.
export { INPUT_MAX_CHARS };

/**
 * Types `text` into the tab's tmux session (literal keys) and, with `enter`, presses Enter after a
 * short pause. Works on agent machines too (named RPCs) as well as local/ssh, with or without a
 * terminal attached in the browser.
 */
export async function sendKeysToSession(machine: Machine, session: string, text: string, enter: boolean): Promise<{ ok: boolean; error: string | null }> {
  if (text.length > INPUT_MAX_CHARS) throw new Error('Texto longo demais');
  try {
    await sendTextToSession(machine, session, text, enter);
    return { ok: true, error: null };
  } catch (e) {
    // The monitor route reports the failure in the response body instead of a 5xx; keep that contract.
    // HttpError messages are already pt-BR and meant for the user; anything else (e.g. a Node/OS
    // error surfacing from execFile) is an internal detail that must not leak — log it and answer
    // with a generic, actionable message instead.
    if (e instanceof HttpError) return { ok: false, error: e.message };
    console.error('sendKeysToSession: falha inesperada ao enviar para o tmux', e);
    return { ok: false, error: tk('Não foi possível enviar o texto para o terminal. Tente novamente.') };
  }
}
