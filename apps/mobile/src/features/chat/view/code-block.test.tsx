import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { AccessibilityInfo } from 'react-native';
import type { ASTNode } from 'react-native-markdown-display';
import { setLocale } from '@/i18n';
import { CodeBlock, COPY_FLASH_MS, codeOf, codeRules } from './code-block';

const setString = Clipboard.setStringAsync as jest.Mock;
const node = (over: Partial<ASTNode> & { sourceInfo?: string }) => ({ key: 'k', content: '', ...over }) as ASTNode;

const copyButton = () => screen.getByRole('button', { name: 'Copiar código' });
const press = async () => {
  await act(async () => {
    fireEvent.press(copyButton());
  });
};

// TER-994: the app's half of TER-992's copy button on an answer's code blocks.
describe('CodeBlock', () => {
  let announce: jest.SpyInstance;
  beforeEach(() => {
    setString.mockClear();
    announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  });
  afterEach(() => {
    announce.mockRestore();
    jest.useRealTimers();
  });

  it('copies the exact code, says "Copiado ✓" for a moment and announces it', async () => {
    jest.useFakeTimers();
    await render(<CodeBlock code={'npm ci\nnpm test'} language="bash" />);
    expect(screen.getByText('bash')).toBeTruthy();
    expect(screen.getByText('Copiar')).toBeTruthy();

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

  it('says so when the copy fails', async () => {
    setString.mockRejectedValueOnce(new Error('no clipboard'));
    await render(<CodeBlock code="x" />);
    await press();
    expect(screen.getByText('Não foi possível copiar')).toBeTruthy();
    expect(announce).toHaveBeenCalledWith('Não foi possível copiar o código');
    expect(screen.queryByText('Copiado ✓')).toBeNull();
  });

  it('reads in English', async () => {
    setLocale('en');
    try {
      const { unmount } = await render(<CodeBlock code="x" />);
      expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
      expect(screen.getByText('Copy')).toBeTruthy();
      await unmount();
    } finally {
      setLocale(null);
    }
  });
});

describe('codeRules', () => {
  beforeEach(() => setString.mockClear());

  it('drops only the trailing newline the parser adds', () => {
    expect(codeOf('a\n\nb\n')).toBe('a\n\nb');
    expect(codeOf('a')).toBe('a');
  });

  it('gives a fence the copy header with its language, copying its content without fences or language', async () => {
    const el = codeRules.fence!(node({ content: 'const a = 1;\n', sourceInfo: 'ts title="x"' }), [], [], { fence: {} }, {});
    await render(<>{el}</>);
    expect(screen.getByText('ts')).toBeTruthy();
    await press();
    expect(setString).toHaveBeenCalledWith('const a = 1;');
  });

  it('gives an indented block the same button', async () => {
    const el = codeRules.code_block!(node({ content: 'echo oi\n' }), [], [], { code_block: {} }, {});
    await render(<>{el}</>);
    await press();
    expect(setString).toHaveBeenCalledWith('echo oi');
  });

  it('leaves inline code alone', () => {
    expect(codeRules.code_inline).toBeUndefined();
  });
});
