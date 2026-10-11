import { describe, expect, it } from 'vitest';
import { checkI18n, scanSource } from '../../scripts/i18n-check.js';
import { CATALOGS } from './catalog.js';

describe('i18n:check', () => {
  it('every server message has an English entry, and every entry is used', () => {
    const { problems } = checkI18n(CATALOGS);
    expect(problems).toEqual([]);
  });

  it('finds literal keys in each call shape', () => {
    const src = [
      "t(locale, 'Um')",
      "msg('Dois {{x}}', { x })",
      'tk("Três")',
      "badRequest('Quatro')",
      "new HttpError(409, 'Cinco', 'CODE')",
      "new ControlError('CODE', `Seis`)",
      "new TaskRuleError('CODE', 'Sete')",
      "notFound(variable)",
      "x.t('não é nosso')",
    ].join('\n');
    const { usages, problems } = scanSource(src, 'x.ts');
    expect(problems).toEqual([]);
    expect(usages.map((u) => u.key)).toEqual(['Um', 'Dois {{x}}', 'Três', 'Quatro', 'Cinco', 'Seis', 'Sete']);
  });

  it('flags interpolated template literals and concatenations', () => {
    const { problems } = scanSource("badRequest(`Conta ${id}`)\nconflict('a' + b)", 'x.ts');
    expect(problems).toHaveLength(2);
  });
});
