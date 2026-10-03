// `REPLY_EXCERPT_MAX` and `replyExcerpt` are copied from packages/mobile-api/src/chat.ts, which this
// app does not depend on: the server cuts the stored snapshot with that one, and a preview cut any
// other way would read differently from the quote the message ends up with (TER-447).
import type { ChatAction, ChatMessage, ChatReplyRef, ReplyCardKind, TabQuestion } from './types';

/** How much of a quoted message a reply keeps and shows. */
export const REPLY_EXCERPT_MAX = 200;

const cutExcerpt = (s: string): string => {
  const chars = [...s];
  return chars.length > REPLY_EXCERPT_MAX ? `${chars.slice(0, REPLY_EXCERPT_MAX).join('').trimEnd()}…` : s;
};

/**
 * What a quote shows of the message it answers: plain text on one line. An answer is markdown, so
 * fence lines, leading `#` and `>`, `*`, backticks and link targets go. Underscores stay: here they
 * are far more often part of an identifier than emphasis. A message of files alone is named by them.
 */
export function replyExcerpt(text: string, attachmentNames: readonly string[] = []): string {
  const plain = text
    .replace(/^[ \t]*```.*$/gm, ' ')
    .replace(/^[ \t]*(?:#{1,6}|>)[ \t]*/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain) return cutExcerpt(plain);
  const names = attachmentNames.join(', ').replace(/\s+/g, ' ').trim();
  return names ? cutExcerpt(`📎 ${names}`) : '';
}

/** The message the next send answers, as the composer previews it — or the card (TER-849), whose id
 *  `id` then is. */
export type ReplyTarget = { id: string; role: ChatReplyRef['role']; excerpt: string; card?: ReplyCardKind };

export const REPLY_AUTHOR: Record<ChatReplyRef['role'], string> = { assistant: 'Concierge', user: 'Você' };

/** What a quote of a card is labelled with, where a message's quote shows its author (TER-849).
 *  Copied from packages/mobile-api (`REPLY_CARD_LABEL`), like the excerpt above. */
export const REPLY_CARD_LABEL: Record<ReplyCardKind, string> = { action: 'Confirmação', tab_question: 'Pergunta da aba' };

/** Who or what a quote names: a message's author, or a card's kind. */
export function replyLabel(reply: { role: ChatReplyRef['role']; card?: ReplyCardKind | { kind: ReplyCardKind } }): string {
  const kind = typeof reply.card === 'string' ? reply.card : reply.card?.kind;
  return kind ? REPLY_CARD_LABEL[kind] : REPLY_AUTHOR[reply.role];
}

/** The words a tab question card asks, quoted by a reply to it. Copied from packages/mobile-api
 *  (`tabQuestionReplyText`): the server quotes the card with that one. */
export function tabQuestionReplyText(q: TabQuestion): string {
  if (q.kind === 'choice') return q.payload.questions.map((item) => item.question.trim()).filter(Boolean).join(' · ');
  return q.payload.question?.trim() || `Permissão para usar ${q.payload.tool_name}`;
}

/** The reference a reply to a confirmation card carries (TER-849): its summary, cut like any quote. */
export const replyTargetOfAction = (a: ChatAction): ReplyTarget => ({ id: a.id, role: 'assistant', excerpt: replyExcerpt(a.summary), card: 'action' });

/** The reference a reply to a tab's question card carries (TER-849): what it asks, cut like any quote. */
export const replyTargetOfQuestion = (q: TabQuestion): ReplyTarget => ({ id: q.id, role: 'assistant', excerpt: replyExcerpt(tabQuestionReplyText(q)), card: 'tab_question' });

/** A row the person can answer: it has words or files. An answer still being written does not. */
export const isReplyable = (m: ChatMessage): boolean => m.text.length > 0 || (m.attachments?.length ?? 0) > 0;

/** The reference a reply to `m` carries: what the composer previews and the server re-derives. */
export const replyTargetOf = (m: ChatMessage): ReplyTarget => ({ id: m.id, role: m.role, excerpt: replyExcerpt(m.text, (m.attachments ?? []).map((a) => a.name)) });
