import { describe, expect, it } from 'vitest';
import { REPLY_EXCERPT_MAX, isReplyable, replyExcerpt, replyLabel, replyTargetOf, replyTargetOfAction, replyTargetOfQuestion } from './chat-reply';
import type { ChatAction, ChatMessage, TabQuestion } from './types';

// The same cases as packages/mobile-api/src/chat.test.ts: the two copies must cut alike.
describe('replyExcerpt', () => {
  it('collapses whitespace and keeps a short text whole', () => {
    expect(replyExcerpt('  abri a aba\n\n build  ')).toBe('abri a aba build');
  });
  it('drops markdown noise but keeps identifiers with underscores', () => {
    expect(replyExcerpt('## Feito\n> nota\n**Rodei** `npm test` em [api](https://x.dev) com reply_to_id\n```ts\nconst a = 1\n```')).toBe('Feito nota Rodei npm test em api com reply_to_id const a = 1');
  });
  it('cuts at 200 characters with an ellipsis, by code point', () => {
    const out = replyExcerpt('á'.repeat(250));
    expect([...out]).toHaveLength(REPLY_EXCERPT_MAX + 1);
    expect(out.endsWith('…')).toBe(true);
  });
  it('names the files of a message with no text', () => {
    expect(replyExcerpt('', ['relatorio.pdf', 'foto.jpg'])).toBe('📎 relatorio.pdf, foto.jpg');
    expect(replyExcerpt('   ', [])).toBe('');
  });
});

describe('isReplyable / replyTargetOf', () => {
  const m = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm1', conversation_id: 'c1', role: 'assistant', text: 'feito', error_code: null, created_at: '', ...over });

  it('only a message with something in it can be answered', () => {
    expect(isReplyable(m())).toBe(true);
    expect(isReplyable(m({ text: '' }))).toBe(false);
    expect(isReplyable(m({ role: 'user', text: '', attachments: [{ name: 'a.pdf' } as never] }))).toBe(true);
  });

  it('the reference carries the excerpt the server will store', () => {
    expect(replyTargetOf(m({ text: '**Feito**' }))).toEqual({ id: 'm1', role: 'assistant', excerpt: 'Feito' });
  });
});

describe('replies to a card (TER-849)', () => {
  it('a confirmation is quoted by its summary, a question by what it asks — the same text the server quotes', () => {
    expect(replyTargetOfAction({ id: 'a1', summary: 'rodar `npm test`' } as ChatAction)).toEqual({ id: 'a1', role: 'assistant', excerpt: 'rodar npm test', card: 'action' });
    const choice = { id: 'q1', kind: 'choice', payload: { questions: [{ question: 'Qual banco?' }, { question: ' Migrar? ' }] } } as unknown as TabQuestion;
    expect(replyTargetOfQuestion(choice)).toEqual({ id: 'q1', role: 'assistant', excerpt: 'Qual banco? · Migrar?', card: 'tab_question' });
    const permission = { id: 'q2', kind: 'permission', payload: { tool_name: 'Bash' } } as unknown as TabQuestion;
    expect(replyTargetOfQuestion(permission).excerpt).toBe('Permissão para usar Bash');
  });

  it('a card is labelled by its kind, a message by its author', () => {
    expect(replyLabel({ role: 'assistant' })).toBe('Concierge');
    expect(replyLabel({ role: 'assistant', card: 'action' })).toBe('Confirmação');
    expect(replyLabel({ role: 'assistant', card: { kind: 'tab_question' } })).toBe('Pergunta da aba');
  });
});
