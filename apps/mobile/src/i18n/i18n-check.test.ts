// `npm run i18n:check` as a unit test (i18n spec §2), so CI catches a missing English entry, a
// placeholder mismatch, an unused entry or untranslated copy in a guarded folder.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkI18n } = require('../../scripts/i18n-check.js') as { checkI18n: () => { problems: string[] } };

describe('i18n:check', () => {
  it('finds no problems in the catalogs or the guarded folders', () => {
    expect(checkI18n().problems).toEqual([]);
  });
});
