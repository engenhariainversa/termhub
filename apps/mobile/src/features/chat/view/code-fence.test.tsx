import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { AccessibilityInfo } from 'react-native';
import { setLocale } from '@/i18n';
import { markdownStyle } from './markdown-style';

const mockSave = jest.fn((_name: string, _content: string, _ext: string) => Promise.resolve(true));
jest.mock('../viewmodel/code-file-save', () => ({ saveCodeFile: (name: string, content: string, ext: string) => mockSave(name, content, ext) }));

import { CodeFence, COPY_FLASH_MS, codeFenceRules, codeOf } from './code-fence';

// The real renderer: test/ui-setup.js swaps the package for a plain `Text`.
const Markdown = jest.requireActual('react-native-markdown-display').default as typeof import('react-native-markdown-display').default;
const show = (text: string) =>
  render(
    <Markdown style={markdownStyle('dark')} rules={codeFenceRules}>
      {text}
    </Markdown>,
  );

beforeEach(() => {
  mockSave.mockClear();
  jest.useFakeTimers({ now: new Date(2026, 9, 14, 16, 30) });
});
afterEach(() => {
  jest.useRealTimers();
});

// TER-1084: "Baixar" on every code block of an answer.
describe('CodeFence', () => {
  it('saves a multi-line text block as a .txt with exactly its content', async () => {
    await show('Aqui:\n\n```text\nPrompt integração Keycloak\nlinha 2 🚀\n\nfim\n```\n');
    expect(screen.getByText('text')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Baixar como arquivo' }));
    expect(mockSave).toHaveBeenCalledWith('prompt-integracao-keycloak-2026-10-14-1630.txt', 'Prompt integração Keycloak\nlinha 2 🚀\n\nfim\n', 'txt');
  });

  it.each([
    ['bash', 'sh'],
    ['json', 'json'],
    ['toml', 'toml'],
  ])('a ```%s block saves as .%s', async (language, ext) => {
    await show(`\`\`\`${language}\nvalor\n\`\`\`\n`);
    fireEvent.press(screen.getByRole('button', { name: 'Baixar como arquivo' }));
    expect(mockSave).toHaveBeenCalledWith(`valor-2026-10-14-1630.${ext}`, 'valor\n', ext);
  });

  it('shows the code without the fence or the language line, and gives a block with no language "código" and a .txt', async () => {
    await show('```\nsem linguagem\n```\n');
    expect(screen.getByText('sem linguagem')).toBeTruthy();
    expect(screen.queryByText(/```/)).toBeNull();
    expect(screen.getByText('código')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Baixar como arquivo' }));
    expect(mockSave).toHaveBeenCalledWith('sem-linguagem-2026-10-14-1630.txt', 'sem linguagem\n', 'txt');
  });

  it('gives inline code no button', async () => {
    await show('rode `npm test` agora');
    expect(screen.queryByRole('button', { name: 'Baixar como arquivo' })).toBeNull();
  });
});

// TER-994: "Copiar" next to "Baixar" on the same header.
describe('CodeFence copy', () => {
  const setString = Clipboard.setStringAsync as jest.Mock;
  const copyButton = () => screen.getByRole('button', { name: 'Copiar código' });
  const press = async () => {
    await act(async () => {
      fireEvent.press(copyButton());
    });
  };
  let announce: jest.SpyInstance;
  beforeEach(() => {
    setString.mockClear();
    announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  });
  afterEach(() => {
    announce.mockRestore();
  });

  it('drops only the trailing newline the parser adds', () => {
    expect(codeOf('a\n\nb\n')).toBe('a\n\nb');
    expect(codeOf('a')).toBe('a');
  });

  it('copies the exact code of a fence, says "Copiado ✓" for a moment and announces it', async () => {
    await show('```bash title="x"\nnpm ci\nnpm test\n```\n');
    expect(screen.getByText('bash')).toBeTruthy();
    expect(screen.getByText('Copiar')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Baixar como arquivo' })).toBeTruthy();

    await press();
    expect(setString).toHaveBeenCalledWith('npm ci\nnpm test');
    expect(screen.getByText('Copiado ✓')).toBeTruthy();
    expect(announce).toHaveBeenCalledWith('Código copiado');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(COPY_FLASH_MS);
    });
    expect(screen.getByText('Copiar')).toBeTruthy();
    expect(screen.queryByText('Copiado ✓')).toBeNull();
  });

  it('gives an indented block the same button', async () => {
    await show('Rode:\n\n    echo oi\n');
    await press();
    expect(setString).toHaveBeenCalledWith('echo oi');
  });

  it('says so when the copy fails', async () => {
    setString.mockRejectedValueOnce(new Error('no clipboard'));
    await render(<CodeFence content={'x\n'} info="" style={{}} />);
    await press();
    expect(screen.getByText('Não foi possível copiar')).toBeTruthy();
    expect(announce).toHaveBeenCalledWith('Não foi possível copiar o código');
    expect(screen.queryByText('Copiado ✓')).toBeNull();
  });

  it('gives inline code no copy button', async () => {
    await show('rode `npm test` agora');
    expect(screen.queryByRole('button', { name: 'Copiar código' })).toBeNull();
  });

  it('reads in English', async () => {
    setLocale('en');
    try {
      const { unmount } = await render(<CodeFence content={'x\n'} info="" style={{}} />);
      expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
      expect(screen.getByText('Copy')).toBeTruthy();
      await unmount();
    } finally {
      setLocale(null);
    }
  });
});
