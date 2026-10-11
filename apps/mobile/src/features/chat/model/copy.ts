// Ported from apps/web/src/components/chat/ChatTurn.tsx (the `FAILURE_LINE` table, ~lines 10-36)
// and apps/web/src/components/chat/ChatHost.tsx (the per-state sentences, design spec §6): the
// sentences a person reads under a stopped answer, or above the thread, kept verbatim from the web
// (the pt-BR text is the key) so a person who uses both never reads two different explanations of the
// same thing.
import { t, tk } from '@/i18n';
import type { ChatErrorCode, ChatHostState } from './types';

/** What an answer that stopped says when nothing was said about why — also the fallback for a code
 * this bundle does not know (a server newer than the app). */
const GENERIC_FAILURE = tk('A resposta não terminou — tente de novo.');

/**
 * One sentence per stored failure, transcribed verbatim from `ChatTurn.tsx`'s `FAILURE_LINE`.
 * `RUNNER_FAILED` is deliberately absent here: it falls back to `GENERIC_FAILURE` below, exactly as
 * an unknown code does.
 */
const FAILURE_LINE: Partial<Record<ChatErrorCode, string>> = {
  TOKEN_FAILED: tk('O servidor não conseguiu criar a credencial do concierge. Tente de novo.'),
  CLI_MISSING: tk('Essa máquina não tem o Claude Code instalado. Instale o claude nela e mande a mensagem de novo.'),
  CLI_REJECTED: tk('O Claude Code dessa máquina recusou os parâmetros do chat. Atualize o claude nela e tente de novo.'),
  MISSING_SESSION: tk('A sessão do Claude nessa máquina não existe mais. Mande a mensagem de novo para começar uma nova.'),
  RUN_FAILED: tk('O Claude parou no meio da resposta. Mande a mensagem de novo.'),
  // Unreachable on a stored row today, and kept anyway: the agent only ever sends `killed` in answer
  // to the server's own `close`, and the connection layer swallows that ack (a locally closed
  // channel reports no exit), so nothing writes KILLED. The sentence stays because the label is the
  // protocol's and a future path may store it.
  KILLED: tk('A resposta foi interrompida antes de terminar. Mande a mensagem de novo.'),
  HOST_GONE: tk('A máquina do chat saiu do ar no meio da resposta. Ligue-a e mande a mensagem de novo.'),
  // Not a machine that went away: it is up, and this sentence must not send anyone looking for a
  // problem with it. What unblocks the chat is closing a few terminals, and nothing else.
  HOST_BUSY: tk('A máquina do chat está com terminais demais abertos e não sobrou espaço para a conversa. Feche algumas abas e mande a mensagem de novo.'),
  AGENT_TOO_OLD: tk('O agente dessa máquina ainda não sabe rodar o chat. Atualize o agente e tente de novo.'),
  // The answer's notice says more (which account, when it resets): see `notice.ts`'s `limitSentence`.
  USAGE_LIMIT: tk('A conta do Claude deste chat atingiu o limite de uso. Espere o limite voltar e mande a mensagem de novo.'),
  MODEL_UNAVAILABLE: tk('O Claude Code dessa máquina não reconhece o modelo escolhido para o chat. Escolha outro modelo ou atualize o claude nela.'),
  AUTH_FAILED: tk('A conta do Claude deste chat não está logada nessa máquina. Faça o login nela (claude, depois /login) e mande a mensagem de novo.'),
};

/** The sentence a stopped answer shows, one per `ChatErrorCode` (`ChatTurn.tsx`'s `FAILURE_LINE`). */
export function errorSentence(code: ChatErrorCode): string {
  return t(FAILURE_LINE[code] ?? GENERIC_FAILURE);
}

/** Every `ChatErrorCode`, keyed so the compiler flags a code added to the union but not here. */
const KNOWN_CODES: Record<ChatErrorCode, true> = {
  RUNNER_FAILED: true,
  TOKEN_FAILED: true,
  CLI_MISSING: true,
  CLI_REJECTED: true,
  MISSING_SESSION: true,
  RUN_FAILED: true,
  KILLED: true,
  HOST_GONE: true,
  AGENT_TOO_OLD: true,
  HOST_BUSY: true,
  USAGE_LIMIT: true,
  MODEL_UNAVAILABLE: true,
  AUTH_FAILED: true,
};

/** Narrows the contract's `error_code: string` (a newer server may send a code this bundle does
 * not know) to the union `errorSentence` takes. */
export function isChatErrorCode(code: string): code is ChatErrorCode {
  return Object.prototype.hasOwnProperty.call(KNOWN_CODES, code);
}

/** The sentence under a stopped answer for whatever `error_code` the wire carried — the generic
 * line for an unknown code, or for an answer left empty with no code at all. */
export function failureSentence(code: string | null): string {
  return code !== null && isChatErrorCode(code) ? errorSentence(code) : t(GENERIC_FAILURE);
}

/** Which login runs the conversation, in the clause `hostLine`'s `ready` sentence ends with
 * (`ChatHost.tsx`'s `accountClause`). `lost` reads as the default login too, same as the web: the
 * chosen account no longer applies to this machine, and the default is what is actually running —
 * the separate sentence about the account being lost is not part of this line. */
function accountClause(account: Extract<ChatHostState, { kind: 'ready' }>['account']): string {
  if (account.kind === 'chosen' && account.via === 'project') return t('na conta {{label}}, definida pelo projeto', { label: account.label });
  return account.kind === 'chosen' ? t('na conta {{label}}', { label: account.label }) : t('na conta padrão do Claude dela');
}

/** Whether a project chat runs on the account its project chose (TER-589): the account is the project's
 * to change, so no picker is offered for it. */
export function accountFromProject(host: ChatHostState): boolean {
  return host.kind === 'ready' && host.account.kind === 'chosen' && host.account.via === 'project';
}

/** The host sheet's line about the account (spec 2026-09-30 project AI accounts §8): the project's own
 * account when it chose one, else where the chat runs (`hostLine`). */
export function hostAccountLine(host: ChatHostState): string {
  if (host.kind === 'ready' && host.account.kind === 'chosen' && host.account.via === 'project') return t('Conta definida pelo projeto: {{label}}', { label: host.account.label });
  return hostLine(host).text;
}

export interface HostLine {
  text: string;
  tone: 'ok' | 'warn' | 'info';
}

/**
 * The line above the thread that says where the conversation runs, or why it cannot — ported from
 * `ChatHost.tsx`'s five states, one sentence per state (the two-paragraph states on the web,
 * `agent_too_old`, are folded into one sentence here).
 *
 * `tone` is this port's own addition — the web renders each state with its own layout instead of a
 * single line, so nothing there names a tone directly: `ok` for the one state that can actually
 * send a message, `warn` for the two that name an actual problem with a machine already on file
 * (offline, an agent to update), and `info` for the two that are not failures at all — no machine
 * registered yet, or more than one to choose between.
 */
export function hostLine(host: ChatHostState): HostLine {
  switch (host.kind) {
    case 'ready':
      return { text: t('Esta conversa roda na máquina {{machine}}, {{account}}.', { machine: host.machine.name, account: accountClause(host.account) }), tone: 'ok' };
    case 'offline':
      return { text: t('A máquina {{machine}} está offline agora.', { machine: host.machine.name }), tone: 'warn' };
    case 'not_chosen':
      return { text: t('Você tem mais de uma máquina: escolha em qual o chat vai rodar.'), tone: 'info' };
    case 'no_machine':
      return { text: t('O chat roda em uma máquina sua, e você ainda não cadastrou nenhuma.'), tone: 'info' };
    case 'agent_too_old':
      return { text: t('O agente da máquina {{machine}} ainda não sabe rodar o chat. Atualize o agente dessa máquina para conversar por aqui.', { machine: host.machine.name }), tone: 'warn' };
  }
}
