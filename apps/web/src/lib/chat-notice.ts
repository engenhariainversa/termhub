import type { ChatNotice } from './types';
import { dateTimeFormat } from './format';

/**
 * The sentences of a chat answer's notice (TER-588): the usage limit it hit, or the account that took
 * over. Ported verbatim to `apps/mobile/src/features/chat/model/notice.ts`, so a person who uses both
 * reads the same words. `timeZone` is only for tests: the screen uses the viewer's own clock.
 */

const two = (n: number) => String(n).padStart(2, '0');

function parts(d: Date, timeZone?: string) {
  const f = dateTimeFormat({ timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const get = (type: string) => Number(f.formatToParts(d).find((p) => p.type === type)?.value ?? '0');
  return { day: get('day'), month: get('month'), hour: get('hour'), minute: get('minute') };
}

/** "às 03:20" today, "em 01/10 às 03:20" on another day; null without a usable time. */
export function resetClause(resetsAt: string | null, now: Date = new Date(), timeZone?: string): string | null {
  if (!resetsAt) return null;
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return null;
  const p = parts(at, timeZone);
  const today = parts(now, timeZone);
  const time = `às ${two(p.hour)}:${two(p.minute)}`;
  return p.day === today.day && p.month === today.month ? time : `em ${two(p.day)}/${two(p.month)} ${time}`;
}

const whose = (label: string | null) => (label ? `A conta "${label}" do Claude` : 'A conta padrão do Claude desta máquina');

const FALLBACK: Record<Extract<ChatNotice, { kind: 'usage_limit' }>['fallback'], string> = {
  none_free: 'Nenhuma outra conta do Claude desta máquina tem limite livre agora.',
  no_other_account: 'Cadastre outra conta do Claude nesta máquina (Contas de IA) para o chat trocar sozinho.',
  // The same words as the tabs' limit banner (TER-587).
  auto_swap_off: 'A troca automática está desligada nesta máquina.',
};

/** The line under an answer stored as USAGE_LIMIT. */
export function limitSentence(notice: ChatNotice | undefined, now: Date = new Date(), timeZone?: string): string {
  if (notice?.kind !== 'usage_limit') return 'A conta do Claude deste chat atingiu o limite de uso. Espere o limite voltar e mande a mensagem de novo.';
  const reset = resetClause(notice.resets_at, now, timeZone);
  return `${whose(notice.account)} atingiu o limite de uso${reset ? ` e volta ${reset}` : ''}. ${FALLBACK[notice.fallback]}`;
}

/** The line above an answer another account gave. */
export function swapSentence(notice: Extract<ChatNotice, { kind: 'account_swap' }>, now: Date = new Date(), timeZone?: string): string {
  const reset = resetClause(notice.resets_at, now, timeZone);
  return `${whose(notice.from)} atingiu o limite de uso${reset ? ` (volta ${reset})` : ''}; a conta "${notice.to}" assumiu esta resposta.`;
}
