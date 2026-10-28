import type { ChatMessage } from './types';
import { t, tk } from '@/i18n';
import { dateTimeFormat } from '@/i18n/format';

type ChatNotice = NonNullable<ChatMessage['notice']>;

/**
 * Ported verbatim from `apps/web/src/lib/chat-notice.ts` (TER-588): the sentences of a chat answer's
 * notice — the usage limit it hit, or the account that took over — so a person who uses both reads the
 * same words. `timeZone` is only for tests: the screen uses the phone's own clock.
 */

const two = (n: number) => String(n).padStart(2, '0');

function parts(d: Date, timeZone?: string) {
  // The phone's own clock needs no Intl (whose time zone support varies across Hermes builds); a zone
  // is only ever given by the tests.
  if (!timeZone) return { day: d.getDate(), month: d.getMonth() + 1, hour: d.getHours(), minute: d.getMinutes() };
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
  const time = `${two(p.hour)}:${two(p.minute)}`;
  if (p.day === today.day && p.month === today.month) return t('às {{time}}', { time });
  // Day and month in the order the language writes them ("01/10" in pt-BR, "10/01" in English).
  const date = t('{{day}}/{{month}}', { day: two(p.day), month: two(p.month) });
  return t('em {{date}} às {{time}}', { date, time });
}

const whose = (label: string | null) => (label ? t('A conta "{{label}}" do Claude', { label }) : t('A conta padrão do Claude desta máquina'));

const FALLBACK: Record<Extract<ChatNotice, { kind: 'usage_limit' }>['fallback'], string> = {
  none_free: tk('Nenhuma outra conta do Claude desta máquina tem limite livre agora.'),
  no_other_account: tk('Cadastre outra conta do Claude nesta máquina (Contas de IA) para o chat trocar sozinho.'),
  // The same words as the tabs' limit banner (TER-587).
  auto_swap_off: tk('A troca automática está desligada nesta máquina.'),
};

/** A project chat looks for room in every account of the project, on any machine (TER-1144). */
const PROJECT_FALLBACK: Record<Extract<ChatNotice, { kind: 'usage_limit' }>['fallback'], string> = {
  none_free: tk('Nenhuma outra conta do projeto tem limite livre agora.'),
  no_other_account: tk('Coloque outra conta do Claude no Setup do projeto (Contas de IA e modelo) para o chat trocar sozinho.'),
  auto_swap_off: tk('Nenhuma outra conta do projeto tem limite livre agora.'),
};

/** The line under an answer stored as USAGE_LIMIT. `project`: the answer is a project chat's (TER-1144). */
export function limitSentence(notice: ChatNotice | undefined, now: Date = new Date(), timeZone?: string, project = false): string {
  if (notice?.kind !== 'usage_limit') return t('A conta do Claude deste chat atingiu o limite de uso. Espere o limite voltar e mande a mensagem de novo.');
  const reset = resetClause(notice.resets_at, now, timeZone);
  const who = whose(notice.account);
  const hit = reset ? t('{{who}} atingiu o limite de uso e volta {{reset}}.', { who, reset }) : t('{{who}} atingiu o limite de uso.', { who });
  return `${hit} ${t((project ? PROJECT_FALLBACK : FALLBACK)[notice.fallback])}`;
}

/** Whether two answers stopped on the same limit: the same account, back at the same time (TER-1144). */
export function sameLimit(a: ChatNotice | undefined, b: ChatNotice | undefined): boolean {
  return a?.kind === 'usage_limit' && b?.kind === 'usage_limit' && a.account === b.account && a.resets_at === b.resets_at;
}

/** The short line under an answer that stopped on the same limit as the one before it (TER-1144): said once in full. */
export function limitRepeatSentence(notice: ChatNotice | undefined, now: Date = new Date(), timeZone?: string): string {
  const reset = notice?.kind === 'usage_limit' ? resetClause(notice.resets_at, now, timeZone) : null;
  return reset ? t('Ainda no mesmo limite de uso (volta {{reset}}).', { reset }) : t('Ainda no mesmo limite de uso.');
}

/** The line above an answer another account gave. */
export function swapSentence(notice: Extract<ChatNotice, { kind: 'account_swap' }>, now: Date = new Date(), timeZone?: string): string {
  const reset = resetClause(notice.resets_at, now, timeZone);
  const who = whose(notice.from);
  return reset
    ? t('{{who}} atingiu o limite de uso (volta {{reset}}); a conta "{{to}}" assumiu esta resposta.', { who, reset, to: notice.to })
    : t('{{who}} atingiu o limite de uso; a conta "{{to}}" assumiu esta resposta.', { who, to: notice.to });
}
