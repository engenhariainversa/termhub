/**
 * How a Claude turn that ended with nothing left running reads (TER-972): `finished` when its last message
 * is a report that asks nothing, else `waiting_input`. The rule is deliberately narrow: a question, an
 * offer, something left to the person or a blocker anywhere in the message keeps the tab waiting, and so
 * does anything it cannot read. Hiding a real request costs more than a false "esperando você". Pure; the
 * message is the person's terminal content and is never logged.
 */
export type TurnEnd = 'finished' | 'waiting_input';

/** Fenced blocks, inline code and URLs: a `?` in them is code, not a question. */
const CODE_BLOCK = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const URL = /\bhttps?:\/\/\S+/gi;

/**
 * Requests, offers, pending items and blockers, matched on the lower-cased message without accents, at
 * word starts. pt-BR and English: the agents answer in the language the person writes in.
 */
const ASKS = new RegExp(
  `(?:^|[^a-z])(?:${[
    // offers and questions without a question mark
    'se quiser', 'se preferir', 'quer que', 'queira', 'posso ', 'devo ', 'prefere', 'qual (?:opcao|delas|caminho|voce)',
    // the person decides, approves or acts
    'voce decide', 'voce escolhe', 'sua decisao', 'decida', 'escolha ', 'preciso que voce', 'preciso de voce',
    'preciso da sua', 'precisa de voce', 'voce precisa', 'voce pode ', 'me (?:diga|diz|avise|fala|confirme)',
    'confirme', 'aprove', 'autorize', 'aguardo', 'no aguardo', 'falta so', 'falta voce', 'para testar',
    'pendente', 'pendencia', 'ainda falta',
    // blockers
    'nao consegui', 'nao foi possivel', 'bloquead', 'impedid', 'falhou', 'falharam', 'erros?\\b', 'travad',
    // English
    'let me know', 'should i\\b', 'shall i\\b', 'do you want', 'would you like', 'want me to', 'your call',
    'up to you', 'you decide', 'need you', 'needs your', 'waiting (?:for|on) you', 'please ', 'approve\\b',
    'can you confirm', 'pending', 'blocked', 'could not', "couldn't", 'unable to', 'failed', 'failing',
  ].join('|')})`,
);

export function classifyTurnEnd(message: string | null): TurnEnd {
  const text = message?.trim();
  if (!text) return 'waiting_input';
  const prose = text.replace(CODE_BLOCK, ' ').replace(INLINE_CODE, ' ').replace(URL, ' ');
  if (prose.includes('?')) return 'waiting_input';
  const plain = prose.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');
  return ASKS.test(` ${plain} `) ? 'waiting_input' : 'finished';
}
