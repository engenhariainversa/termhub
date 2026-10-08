/**
 * How a Claude turn that ended with nothing left running reads: `finished` when its last message is a
 * report that asks the person nothing, `auth_required` when it is Claude Code's own login error, else
 * `waiting_input`.
 *
 * TER-972 kept any offer, pending item or next step as a wait, and most reports name one ("Se quiser, apago
 * também", "Para testar: …", "você pode…"): tabs that had only reported filled "Precisa de você" (TER-1046).
 * A wait is now a direct question: a question mark in the last block, or an explicit request for the
 * person's decision, approval or action anywhere ("Preciso que você decida", "Para o Pedro decidir", "let me
 * know"). A blocker the agent could not get past still waits ("Não consegui…"). Offers, next steps and
 * pending lists are a report. A blank message still waits: there is nothing to read. Pure; the message is
 * the person's terminal content and is never logged.
 */
export type TurnEnd = 'finished' | 'waiting_input' | 'auth_required';

/** Fenced blocks, inline code and URLs: a `?` in them is code, not a question. */
const CODE_BLOCK = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const URL = /\bhttps?:\/\/\S+/gi;

/**
 * Claude Code's own messages when its account cannot be used (2.1.x): "Login expired · Please run /login",
 * "Invalid API key · Please run /login", "OAuth token has expired", "API Error: 401 … authentication_error".
 */
const AUTH = /please run \/login|login expired|invalid api key|oauth token (?:has )?expired|authentication_error/i;
/** The longest text read as Claude Code's login error: a report that quotes one is still a report. */
export const AUTH_MESSAGE_MAX = 300;

/** Whether a short text is Claude Code's login error (also read off the screen, monitor/screen-state.ts). */
export const isAuthMessage = (text: string): boolean => text.length <= AUTH_MESSAGE_MAX && AUTH.test(text);

/**
 * Direct requests to the person and blockers, matched on the lower-cased message without accents, at word
 * starts. pt-BR and English: the agents answer in the language the person writes in.
 */
const ASKS = new RegExp(
  `(?:^|[^a-z])(?:${[
    // the person decides, chooses, approves or acts
    'voce decide', 'voce escolhe', 'sua decisao', 'decisao (?:sua|do|da)\\b', 'decisoes suas', 'preciso de (?:algumas |uma |umas )?decisoes?\\b',
    'para (?:o|a|voce) (?:[a-z]+ )?(?:decidir|escolher|aprovar|autorizar)\\b', 'decida\\b', 'escolha (?:uma|entre|qual)\\b',
    'quer que eu', 'qual (?:opcao|delas|caminho|voce prefere)', 'preciso que voce', 'preciso de voce', 'preciso da sua', 'precisa de voce',
    'voce precisa', 'me (?:diga|diz|avise|fala|confirme|responda)\\b', 'confirme\\b', 'aprove\\b', 'autorize\\b',
    'aguardo (?:sua|seu|o seu|a sua|confirmacao|aprovacao|resposta|retorno|decisao)\\b', 'no aguardo',
    // blockers the agent could not get past
    'nao consegui', 'nao foi possivel', '(?:estou|fiquei|sigo|continuo) (?:bloquead|impedid|travad)', 'bloquead[oa] (?:por|pel|em|no|na)\\b',
    // English
    'let me know', 'should i\\b', 'shall i\\b', 'do you want', 'would you like', 'want me to', 'your call',
    'up to you', 'you decide', 'need you\\b', 'needs your', 'need your', 'waiting (?:for|on) you',
    'please (?:confirm|approve|choose|decide)\\b', 'can you confirm', 'which (?:one|option)\\b',
    "(?:i am|i'm) blocked", 'blocked (?:on|by)\\b', 'could not', "couldn't", 'unable to',
  ].join('|')})`,
);

/** The last block of prose: what follows the last blank line. */
function lastBlock(prose: string): string {
  const blocks = prose.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks[blocks.length - 1] ?? '';
}

export function classifyTurnEnd(message: string | null): TurnEnd {
  const text = message?.trim();
  if (!text) return 'waiting_input';
  if (isAuthMessage(text)) return 'auth_required';
  const prose = text.replace(CODE_BLOCK, ' ').replace(INLINE_CODE, ' ').replace(URL, ' ');
  if (lastBlock(prose).includes('?')) return 'waiting_input';
  const plain = prose.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');
  return ASKS.test(` ${plain} `) ? 'waiting_input' : 'finished';
}
