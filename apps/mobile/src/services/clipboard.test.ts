// TER-1200: on iOS, expo-clipboard only re-reads the text (from its UTF-8 bytes, as Windows-1252) when it
// is handed HTML. Plain text goes to UIPasteboard as the string itself, so this service must never ask
// for HTML and must hand the text over untouched.
const mockSetString = jest.fn(async () => true);
jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn(() => ({ setStringAsync: mockSetString })) }));

import { copyToClipboard } from './clipboard';

describe('copyToClipboard', () => {
  it('hands the text over as plain text, accents, emoji and typographic quotes untouched', async () => {
    const text = 'Oi time 👋 → “pronto” — ação, peça, é 🙏';
    await expect(copyToClipboard(text)).resolves.toBe(true);
    expect(mockSetString).toHaveBeenCalledWith(text, {});
  });
});
