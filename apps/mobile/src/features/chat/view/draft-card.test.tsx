import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { draftPlainText } from '@termhub/mobile-api';
import { AccessibilityInfo } from 'react-native';
import { chatMarkdownIt, chatMarkdownRules } from './chat-links';
import { COPY_FLASH_MS } from './code-fence';
import { markdownStyle } from './markdown-style';

// The real renderer, here and inside the card: test/ui-setup.js swaps the package for a plain `Text`.
jest.mock('react-native-markdown-display', () => jest.requireActual('react-native-markdown-display'));
const Markdown = jest.requireActual('react-native-markdown-display').default as typeof import('react-native-markdown-display').default;
const show = (text: string) =>
  render(
    <Markdown style={markdownStyle('dark')} rules={chatMarkdownRules} markdownit={chatMarkdownIt}>
      {text}
    </Markdown>,
  );

const DRAFT = ['Hi @Ana,', '', '1. Ship **v2**', '   - check the logs', '2. Close the card'].join('\n');

// TER-1159: a ```draft fence is a "Mensagem pronta" card whose Copiar puts the draft on the clipboard as HTML.
describe('DraftCard', () => {
  const setString = Clipboard.setStringAsync as jest.Mock;
  let announce: jest.SpyInstance;
  beforeEach(() => {
    setString.mockClear();
    announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    jest.useFakeTimers();
  });
  afterEach(() => {
    announce.mockRestore();
    jest.useRealTimers();
  });
  const press = async () => {
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Copiar mensagem' }));
    });
  };

  it('renders the draft as Markdown under "Mensagem pronta", with no code header', async () => {
    await show(`Pronto:\n\n\`\`\`draft\n${DRAFT}\n\`\`\`\n`);
    expect(screen.getByText('Mensagem pronta')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.queryByText(/\*\*v2\*\*/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copiar código' })).toBeNull();
  });

  it('copies the draft as HTML with the nested list, says "Copiado ✓" and announces it', async () => {
    await show(`\`\`\`draft\n${DRAFT}\n\`\`\`\n`);
    await press();
    const [html, options] = setString.mock.calls[0];
    expect(options).toEqual({ inputFormat: 'html' });
    expect(html).toMatch(/<ol>\s*<li>[\s\S]*<strong>v2<\/strong>[\s\S]*<ul>\s*<li>check the logs<\/li>/);
    expect(screen.getByText('Copiado ✓')).toBeTruthy();
    expect(announce).toHaveBeenCalledWith('Mensagem copiada');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(COPY_FLASH_MS);
    });
    expect(screen.getByText('Copiar')).toBeTruthy();
  });

  // TER-1193: iOS parses the HTML into rich text from its UTF-8 bytes with no charset, which WebKit reads
  // as Windows-1252, so "👋" pasted as "ðŸ‘‹" and "ç" as "Ã§" (rich text and plain alike). The HTML
  // handed over must declare UTF-8 and carry no byte beyond ASCII.
  it('hands over ASCII-only HTML that declares UTF-8, so accents and emoji survive', async () => {
    await show('```draft\nOlá @Ana 👋, a peça do botão está pronta ✅ 🔄 🙏 — ç ã é ó\n```\n');
    await press();
    const [html] = setString.mock.calls[0];
    expect(html.startsWith('<meta charset="utf-8">')).toBe(true);
    expect(html).toMatch(/^[\x00-\x7f]*$/);
    expect(html).toContain('Ol&#xe1;');
    expect(html).toContain('&#x1f44b;');
    expect(html).toContain('&#x2705;');
    expect(html).toContain('&#x1f64f;');
    expect(html).not.toContain('&#xd83d;');
  });

  // TER-1200: what iOS does with the HTML, end to end: read its bytes as Windows-1252, then resolve the
  // references. The text that comes out must be the draft as shown, never "ðŸ‘‹", "â†’" or "â€œ".
  it('pastes back exactly what was shown when the HTML is read as Windows-1252', async () => {
    const source = 'Oi time 👋 → “pronto” — ação, peça, é, ó 🙏 ✅';
    await show(`\`\`\`draft\n${source}\n\`\`\`\n`);
    await press();
    const [html] = setString.mock.calls[0] as [string];
    type Codecs = { TextEncoder: new () => { encode(s: string): Uint8Array }; TextDecoder: new (label: string) => { decode(b: Uint8Array): string } };
    const { TextEncoder, TextDecoder } = jest.requireActual<Codecs>('util');
    const asIosReadsIt = new TextDecoder('windows-1252').decode(new TextEncoder().encode(html));
    expect(asIosReadsIt).toBe(html);
    const pasted = asIosReadsIt.replace(/&#x([0-9a-f]+);/g, (_: string, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
    expect(pasted).toBe(`<meta charset="utf-8">${chatMarkdownIt.render(source)}`);
    expect(pasted).toContain(source);
    expect(pasted).not.toMatch(/ð|â|Ã/);
  });

  it('falls back to Slack-flavoured plain text when HTML is refused', async () => {
    setString.mockRejectedValueOnce(new Error('no html'));
    await show(`\`\`\`draft\n${DRAFT}\n\`\`\`\n`);
    await press();
    expect(setString).toHaveBeenLastCalledWith(draftPlainText(DRAFT));
    expect(screen.getByText('Copiado ✓')).toBeTruthy();
  });

  it('says so when nothing could be copied', async () => {
    setString.mockRejectedValueOnce(new Error('no html')).mockRejectedValueOnce(new Error('no clipboard'));
    await show(`\`\`\`draft\n${DRAFT}\n\`\`\`\n`);
    await press();
    expect(screen.getByText('Não foi possível copiar')).toBeTruthy();
    expect(announce).toHaveBeenCalledWith('Não foi possível copiar a mensagem');
  });

  it('leaves any other fence a code block', async () => {
    await show('```bash\nnpm test\n```\n');
    expect(screen.queryByText('Mensagem pronta')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copiar código' })).toBeTruthy();
  });
});
