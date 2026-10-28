import { limitRepeatSentence, limitSentence, resetClause, sameLimit, swapSentence } from './notice';

// 2026-09-30 05:56 in São Paulo; the limit resets at 06:20 UTC, 03:20 there.
const NOW = new Date('2026-09-30T08:56:00.000Z');
const RESETS = '2026-09-30T06:20:00.000Z';
const TZ = 'America/Sao_Paulo';

describe('resetClause', () => {
  it('says the time on the same day, and the date too on another', () => {
    expect(resetClause('2026-09-30T20:20:00.000Z', NOW, TZ)).toBe('às 17:20');
    expect(resetClause('2026-10-01T06:20:00.000Z', NOW, TZ)).toBe('em 01/10 às 03:20');
    expect(resetClause(null, NOW, TZ)).toBeNull();
    expect(resetClause('not a date', NOW, TZ)).toBeNull();
  });
});

describe('limitSentence', () => {
  it('names the account, when it comes back and why no other account took over', () => {
    const at = (fallback: 'none_free' | 'no_other_account' | 'auto_swap_off', account: string | null = null) =>
      limitSentence({ kind: 'usage_limit', account, resets_at: '2026-09-30T20:20:00.000Z', fallback }, NOW, TZ);
    expect(at('none_free')).toBe('A conta padrão do Claude desta máquina atingiu o limite de uso e volta às 17:20. Nenhuma outra conta do Claude desta máquina tem limite livre agora.');
    expect(at('no_other_account', 'Pessoal')).toBe('A conta "Pessoal" do Claude atingiu o limite de uso e volta às 17:20. Cadastre outra conta do Claude nesta máquina (Contas de IA) para o chat trocar sozinho.');
    expect(at('auto_swap_off')).toMatch(/A troca automática está desligada nesta máquina\.$/);
  });

  it('still says it is the limit when the answer carries no notice', () => {
    expect(limitSentence(undefined, NOW, TZ)).toBe('A conta do Claude deste chat atingiu o limite de uso. Espere o limite voltar e mande a mensagem de novo.');
    expect(limitSentence({ kind: 'account_swap', from: null, to: 'x', resets_at: null }, NOW, TZ)).toBe(limitSentence(undefined, NOW, TZ));
  });
});

describe('swapSentence', () => {
  it('says which account hit the limit and which one took over', () => {
    expect(swapSentence({ kind: 'account_swap', from: null, to: 'Trabalho', resets_at: RESETS }, NOW, TZ)).toBe('A conta padrão do Claude desta máquina atingiu o limite de uso (volta às 03:20); a conta "Trabalho" assumiu esta resposta.');
    expect(swapSentence({ kind: 'account_swap', from: 'Pessoal', to: 'Trabalho', resets_at: null }, NOW, TZ)).toBe('A conta "Pessoal" do Claude atingiu o limite de uso; a conta "Trabalho" assumiu esta resposta.');
  });
});

describe('a project chat at its limit (TER-1144)', () => {
  const notice = { kind: 'usage_limit', account: 'Claude · jarvis', resets_at: null, fallback: 'none_free' } as const;

  it('speaks of the project and says the same limit only once in full', () => {
    expect(limitSentence(notice, undefined, undefined, true)).toBe('A conta "Claude · jarvis" do Claude atingiu o limite de uso. Nenhuma outra conta do projeto tem limite livre agora.');
    expect(sameLimit(notice, { ...notice })).toBe(true);
    expect(limitRepeatSentence(notice)).toBe('Ainda no mesmo limite de uso.');
  });
});
