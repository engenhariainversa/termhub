import { formatDateTime } from '@/i18n/format';
import { updateLabel } from './update-label';

const ID = '0b7e6c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b';
const AT = new Date('2026-10-08T21:27:21.132Z');

describe('updateLabel', () => {
  it('names the embedded bundle', () => {
    expect(updateLabel({ updateId: null, isEmbeddedLaunch: true, createdAt: null })).toBe('OTA: binário');
    expect(updateLabel({ updateId: ID, isEmbeddedLaunch: true, createdAt: AT })).toBe('OTA: binário');
    expect(updateLabel({ updateId: null, isEmbeddedLaunch: false, createdAt: null })).toBe('OTA: binário');
  });

  it('shows an OTA update by its full id and publish time', () => {
    expect(updateLabel({ updateId: ID, isEmbeddedLaunch: false, createdAt: AT })).toBe(`OTA: ${ID} · ${formatDateTime(AT)}`);
    expect(updateLabel({ updateId: ID, isEmbeddedLaunch: false, createdAt: null })).toBe(`OTA: ${ID}`);
  });
});
