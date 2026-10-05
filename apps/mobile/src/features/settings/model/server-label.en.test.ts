import { setLocale } from '@/i18n';
import { serverLabel } from './server-label';

afterEach(() => setLocale(null));

it('says "Server" in English', () => {
  setLocale('en');
  expect(serverLabel('mock', 'https://termhub.dev')).toBe('Server: mock');
  expect(serverLabel('http', 'https://staging.termhub.dev/')).toBe('Server: staging.termhub.dev');
});
