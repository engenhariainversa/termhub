import { updateLabel } from './update-label';

describe('updateLabel', () => {
  it('names the embedded bundle and an OTA update by its short id', () => {
    expect(updateLabel(null, true)).toBe('OTA: binário');
    expect(updateLabel('0b7e6c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b', true)).toBe('OTA: binário');
    expect(updateLabel(null, false)).toBe('OTA: binário');
    expect(updateLabel('0b7e6c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b', false)).toBe('OTA: 0b7e6c1a');
  });
});
