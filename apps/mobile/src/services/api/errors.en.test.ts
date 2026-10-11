import { setLocale } from '@/i18n';
import { ApiError } from './errors';

afterEach(() => setLocale(null));

it("words the local fallback in English, but keeps the server's own message as it came", () => {
  setLocale('en');
  expect(ApiError.fromBody(500, {}, 'not json').message).toBe('Server error (500)');
  expect(ApiError.fromBody(423, {}, '{"error":"Device locked","code":"DEVICE_LOCKED"}').message).toBe('Device locked');
});
