import { setLocale } from '@/i18n';
import { effectiveDate, LEGAL_MSG } from './messages';

afterEach(() => setLocale(null));

it('writes the acceptance copy and its date in English', () => {
  setLocale('en');
  const date = effectiveDate(new Date(2026, 9, 7, 12).toISOString())!;
  expect(date).toBe('October 7, 2026');
  expect(LEGAL_MSG.title).toBe('Terms of Use and Privacy Policy');
  expect(LEGAL_MSG.documentName('privacy')).toBe('Privacy Policy');
  expect(LEGAL_MSG.versionSince('2.0', date)).toBe('version 2.0, in effect since October 7, 2026');
  expect(LEGAL_MSG.consent).toBe('I have read and accept the Terms of Use and the Privacy Policy');
  setLocale('pt-BR');
  expect(LEGAL_MSG.versionSince('2.0', effectiveDate(new Date(2026, 9, 7, 12).toISOString())!)).toBe('versão 2.0, em vigor desde 7 de outubro de 2026');
  expect(effectiveDate('not a date')).toBeNull();
});
