// The session's copy in English (i18n spec 2026-10-04): MSG getters follow the language at read time.
import { setLocale } from '@/i18n';
import { attemptsSuffix, MSG } from './messages';

afterEach(() => setLocale(null));

it('reads MSG and the attempts suffix in the language the app shows at that moment', () => {
  setLocale('en');
  expect(MSG.pinInvalid).toBe('Wrong PIN.');
  expect(MSG.network).toBe('Could not reach the server. Try again.');
  expect(attemptsSuffix(1)).toBe(' 1 attempt left.');
  expect(attemptsSuffix(2)).toBe(' 2 attempts left.');
  setLocale('pt-BR');
  expect(MSG.pinInvalid).toBe('PIN incorreto.');
  expect(attemptsSuffix(2)).toBe(' 2 tentativas restantes.');
});
