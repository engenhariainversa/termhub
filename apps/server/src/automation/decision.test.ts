import { describe, expect, it } from 'vitest';
import { decisionException, questionOf } from './decision.js';
import { decisionSummary, DECISION_SUMMARY_MAX } from './decisions-taken.js';

describe('questionOf (TER-1043)', () => {
  it('keeps the lines that ask the person, with or without a question mark', () => {
    expect(questionOf('Feito o servidor.\n\nDecisão sua: A ou B? Recomendo A.')).toBe('Decisão sua: A ou B? Recomendo A.');
    expect(questionOf('Ficou assim. Você decide entre manter ou trocar o nome.')).toBe('Ficou assim. Você decide entre manter ou trocar o nome.');
    expect(questionOf('Done. Should I also update the docs')).toBe('Done. Should I also update the docs');
  });
  it('is null for a report that asks nothing, and for a ? that is only code or a URL', () => {
    expect(questionOf('Rodei os testes e abri o PR.')).toBeNull();
    expect(questionOf('Usei `a?.b` e https://x.dev/?q=1 no código.')).toBeNull();
    expect(questionOf(null)).toBeNull();
    expect(questionOf('   ')).toBeNull();
  });
});

describe('decisionException (TER-1043 §2)', () => {
  it.each([
    'Coloco a credencial no .env?',
    'Faço o deploy agora?',
    'Posso mesclar o PR?',
    'Publico no npm?',
    'Mando para a App Store?',
    'Rodo eas build?',
    'Apago a pasta com rm -rf fora da worktree?',
    'Reinicio o container docker?',
    'Rodo a migração em produção?',
    'Isso muda o escopo do card, sigo?',
  ])('stops on %s', (q) => expect(decisionException(q)).toBe(true));

  it.each(['Uso um select ou radio buttons?', 'Nomeio a função decideStop ou onQuestionStop?', 'Should the button be blue or green?'])('decides alone on %s', (q) =>
    expect(decisionException(q)).toBe(false),
  );
});

describe('decisionSummary', () => {
  it('is one line, question → choice, cut to the max', () => {
    expect(decisionSummary({ question: 'Cor\ndo botão?', choice: 'Azul' })).toBe('Cor do botão? → Azul');
    expect(decisionSummary({ question: 'q'.repeat(400), choice: 'c' }).length).toBe(DECISION_SUMMARY_MAX);
  });
});
