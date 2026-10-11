import { t } from '@/i18n';
import { replyExcerpt, type ReplyCardKind, type ReplyCardRef } from '@/services/api/contract';
import type { ChatAction, ChatMessage, TabQuestion } from './types';

/** What the next send answers, while it is being written and on the optimistic row (TER-447): a
 * message, or a card of the thread (TER-849), whose id `id` then is. */
export type ReplyRef = { id: string; role: 'user' | 'assistant'; excerpt: string; card?: ReplyCardKind };

/** A quote as a message carries it (the server's snapshot). */
export type ReplyOnRow = NonNullable<ChatMessage['reply_to']>;

export const REPLY_AUTHOR: Record<ReplyRef['role'], string> = {
  assistant: 'Concierge',
  get user() {
    return t('Você');
  },
};

/** What a quote of a card is labelled with, where a message's quote shows its author (TER-849): the
 * contract's `REPLY_CARD_LABEL` (pt-BR, shared with the server) in the language the app shows. */
export const REPLY_CARD_LABEL: Record<ReplyCardKind, string> = {
  get action() {
    return t('Confirmação');
  },
  get tab_question() {
    return t('Pergunta da aba');
  },
};

/** The words a tab question card asks, quoted by a reply to it (TER-849): the contract's
 * `tabQuestionReplyText` with its one sentence of its own in the language the app shows. */
export function tabQuestionReplyText(
  q: { kind: 'choice'; payload: { questions: readonly { question: string }[] } } | { kind: 'permission'; payload: { tool_name: string; question?: string } },
): string {
  if (q.kind === 'choice') return q.payload.questions.map((item) => item.question.trim()).filter(Boolean).join(' · ');
  return q.payload.question?.trim() || t('Permissão para usar {{tool}}', { tool: q.payload.tool_name });
}

/** Who or what a quote names: a message's author, or a card's kind. */
export function replyLabel(reply: { role: ReplyRef['role']; card?: ReplyCardKind | ReplyCardRef }): string {
  const kind = typeof reply.card === 'string' ? reply.card : reply.card?.kind;
  return kind ? REPLY_CARD_LABEL[kind] : REPLY_AUTHOR[reply.role];
}

/** A row the person can answer: the server has it (not a local row) and it has words or files. An
 * answer still being written has neither, and the server would refuse it. */
export const isReplyable = (m: ChatMessage): boolean => m.local === undefined && (m.text.length > 0 || (m.attachments?.length ?? 0) > 0);

/** The reference a reply to `m` carries, its excerpt cut the way the server cuts the snapshot. */
export const replyRefOf = (m: ChatMessage): ReplyRef => ({ id: m.id, role: m.role, excerpt: replyExcerpt(m.text, (m.attachments ?? []).map((a) => a.name)) });

/** The cards a drag can answer (TER-849): a confirmation, or a tab's question. */
export type ReplyableCard = { kind: 'action'; action: ChatAction } | { kind: 'tab_question'; question: TabQuestion };

/** The reference a reply to a card carries: what the card shows, cut the way the server cuts it. */
export function replyRefOfCard(card: ReplyableCard): ReplyRef {
  if (card.kind === 'action') return { id: card.action.id, role: 'assistant', excerpt: replyExcerpt(card.action.summary), card: 'action' };
  return { id: card.question.id, role: 'assistant', excerpt: replyExcerpt(tabQuestionReplyText(card.question)), card: 'tab_question' };
}

/** What a send's body says it answers. */
export const replyBody = (ref: ReplyRef): { reply_to_id: string } | { reply_to_card: ReplyCardRef } =>
  ref.card ? { reply_to_card: { kind: ref.card, id: ref.id } } : { reply_to_id: ref.id };

/** The quote on the optimistic row, shaped like the one the server will store. */
export const replyOnRow = (ref: ReplyRef): ReplyOnRow =>
  ref.card ? { id: null, role: ref.role, excerpt: ref.excerpt, card: { kind: ref.card, id: ref.id } } : { id: ref.id, role: ref.role, excerpt: ref.excerpt };

/** A failed row's quote, to send it again as the same reply; none once the original message is gone. */
export function replyRefOfRow(reply: ReplyOnRow | undefined): ReplyRef | undefined {
  if (reply?.card) return { id: reply.card.id, role: reply.role, excerpt: reply.excerpt, card: reply.card.kind };
  return reply && reply.id !== null ? { id: reply.id, role: reply.role, excerpt: reply.excerpt } : undefined;
}
