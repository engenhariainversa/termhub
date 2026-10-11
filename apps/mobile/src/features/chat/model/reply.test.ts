import { isReplyable, replyBody, replyLabel, replyOnRow, replyRefOf, replyRefOfCard, replyRefOfRow } from './reply';
import type { ChatAction, ChatMessage, TabQuestion } from './types';

const m = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm1', conversation_id: 'c1', role: 'assistant', text: 'Feito', usage: null, error_code: null, created_at: '', ...over });

it('a stored message with something in it can be answered', () => {
  expect(isReplyable(m())).toBe(true);
  expect(isReplyable(m({ text: '' }))).toBe(false);
  expect(isReplyable(m({ role: 'user', text: 'oi', local: 'sending' }))).toBe(false);
  expect(isReplyable(m({ role: 'user', text: 'oi', local: 'failed' }))).toBe(false);
  expect(isReplyable(m({ role: 'user', text: '', attachments: [{ name: 'a.pdf' } as never] }))).toBe(true);
});

it('the reference carries the excerpt the server will cut too', () => {
  expect(replyRefOf(m({ text: '**Feito**, abri a aba' }))).toEqual({ id: 'm1', role: 'assistant', excerpt: 'Feito, abri a aba' });
  expect(replyRefOf(m({ role: 'user', text: '', attachments: [{ name: 'a.pdf' } as never] }))).toEqual({ id: 'm1', role: 'user', excerpt: '📎 a.pdf' });
});

describe('replies to a card (TER-849)', () => {
  const action = { id: 'a1', summary: 'rodar `npm test` na aba api', status: 'pending' } as ChatAction;
  const choice = { id: 'q1', kind: 'choice', payload: { questions: [{ question: 'Qual banco?', header: 'Banco', multi_select: false, options: [] }] } } as unknown as TabQuestion;
  const permission = { id: 'q2', kind: 'permission', payload: { tool_name: 'Bash' } } as unknown as TabQuestion;

  it('a confirmation card is quoted by its summary, a question card by what it asks', () => {
    expect(replyRefOfCard({ kind: 'action', action })).toEqual({ id: 'a1', role: 'assistant', excerpt: 'rodar npm test na aba api', card: 'action' });
    expect(replyRefOfCard({ kind: 'tab_question', question: choice })).toEqual({ id: 'q1', role: 'assistant', excerpt: 'Qual banco?', card: 'tab_question' });
    expect(replyRefOfCard({ kind: 'tab_question', question: permission }).excerpt).toBe('Permissão para usar Bash');
  });

  it('a card is labelled by its kind, a message by its author', () => {
    expect(replyLabel({ role: 'assistant' })).toBe('Concierge');
    expect(replyLabel({ role: 'user' })).toBe('Você');
    expect(replyLabel({ role: 'assistant', card: 'action' })).toBe('Confirmação');
    expect(replyLabel({ role: 'assistant', card: { kind: 'tab_question', id: 'q1' } })).toBe('Pergunta da aba');
  });

  it('goes on the wire as reply_to_card, and on the row with the card named and no message id', () => {
    const ref = replyRefOfCard({ kind: 'action', action });
    expect(replyBody(ref)).toEqual({ reply_to_card: { kind: 'action', id: 'a1' } });
    expect(replyOnRow(ref)).toEqual({ id: null, role: 'assistant', excerpt: 'rodar npm test na aba api', card: { kind: 'action', id: 'a1' } });
    expect(replyRefOfRow(replyOnRow(ref))).toEqual(ref);
  });

  it('a message reference keeps its old wire and row shapes', () => {
    const ref = replyRefOf(m());
    expect(replyBody(ref)).toEqual({ reply_to_id: 'm1' });
    expect(replyOnRow(ref)).toEqual({ id: 'm1', role: 'assistant', excerpt: 'Feito' });
    expect(replyRefOfRow(replyOnRow(ref))).toEqual(ref);
    // A quote whose original is gone cannot be sent again as a reply.
    expect(replyRefOfRow({ id: null, role: 'assistant', excerpt: 'x' })).toBeUndefined();
  });
});
