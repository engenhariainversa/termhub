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
