import { quotedText } from './reply-text';

describe('quotedText (TER-1090)', () => {
  const reply = { id: 'm1', role: 'assistant' as const, excerpt: 'Rodei os testes' };

  it('puts the quote above what was written', () => {
    expect(quotedText(reply, 'e o build?')).toBe('> Rodei os testes\n\ne o build?');
  });

  it('sends the text alone without a reply', () => {
    expect(quotedText(null, 'oi')).toBe('oi');
  });
});
