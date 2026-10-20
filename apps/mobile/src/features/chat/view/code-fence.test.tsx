import { fireEvent, render, screen } from '@testing-library/react-native';
import { markdownStyle } from './markdown-style';

const mockSave = jest.fn((_name: string, _content: string, _ext: string) => Promise.resolve(true));
jest.mock('../viewmodel/code-file-save', () => ({ saveCodeFile: (name: string, content: string, ext: string) => mockSave(name, content, ext) }));

import { codeFenceRules } from './code-fence';

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
