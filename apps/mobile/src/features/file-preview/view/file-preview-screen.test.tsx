import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';

const mockPush = jest.fn();
let mockParams: Record<string, string> = { path: 'docs/a.md', project_id: 'p1' };
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
}));
const mockFilePreview = jest.fn();
jest.mock('@/services/api', () => ({ api: { filePreview: (...a: unknown[]) => mockFilePreview(...a) } }));
jest.mock('@/features/session/viewmodel/useSessionStore', () => ({
  useSessionStore: { getState: () => ({ auth: () => ({ accessToken: 't' }), handleApiError: () => false }) },
}));
const mockSendFileToChat = jest.fn(async () => undefined);
jest.mock('@/features/chat/model/chat-inbox', () => ({ sendFileToChat: (...a: unknown[]) => mockSendFileToChat(...(a as [])) }));

import { FilePreviewScreen, fileRules, onFileLink } from './file-preview-screen';

const { props: markdownProps } = jest.requireMock('react-native-markdown-display') as {
  props: { children: string; onLinkPress?: (url: string) => boolean; rules?: Record<string, unknown> }[];
};
const lastMarkdown = () => markdownProps[markdownProps.length - 1]!;

const ok = (content: string, over: Record<string, unknown> = {}) => ({
  status: 'ok',
  machine: { id: 'm1', name: 'jarvis' },
  project_id: 'p1',
  path: '/home/u/p/docs/a.md',
  rel_path: 'docs/a.md',
  name: 'a.md',
  size: content.length,
  mtime: '2026-10-04T10:00:00.000Z',
  content,
  github_url: 'https://github.com/o/r/blob/main/docs/a.md',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { path: 'docs/a.md', project_id: 'p1' };
});

describe('FilePreviewScreen', () => {
  it('reads the file of the route and renders it with the image rule and the link handler', async () => {
    mockFilePreview.mockResolvedValue(ok('# Relatório\n\n![gráfico](https://attacker/x.png)'));
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await render(<FilePreviewScreen />);
    expect(await screen.findByText(/# Relatório/)).toBeTruthy();
    expect(mockFilePreview).toHaveBeenCalledWith({ accessToken: 't' }, { path: 'docs/a.md', project_id: 'p1', tab_id: undefined });
    const md = lastMarkdown();
    expect(md.rules?.image).toBeDefined();
    // a link inside the file: a relative .md opens another preview of the same project
    expect(md.onLinkPress?.('b.md')).toBe(false);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/file-preview', params: { path: 'docs/b.md', project_id: 'p1' } });
    expect(md.onLinkPress?.('javascript:alert(1)')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('shows a .txt file as plain text', async () => {
    mockFilePreview.mockResolvedValue(ok('# não é título', { name: 'notas.txt' }));
    await render(<FilePreviewScreen />);
    expect(await screen.findByText('# não é título')).toBeTruthy();
  });

  it('says why a file was refused', async () => {
    mockFilePreview.mockResolvedValue({ status: 'outside', machine: { id: 'm1', name: 'jarvis' } });
    await render(<FilePreviewScreen />);
    expect(await screen.findByText(/fora das pastas que o agente pode ler/)).toBeTruthy();
  });

  it('says to update an old agent', async () => {
    const { ApiError } = jest.requireActual('@/services/api/errors');
    mockFilePreview.mockRejectedValue(new ApiError(409, 'AGENT_OUTDATED', 'Atualize o agente desta máquina (npm i -g @termhub/agent, versão 0.16.0 ou mais nova) para ver arquivos'));
    await render(<FilePreviewScreen />);
    expect(await screen.findByText(/Atualize o agente desta máquina/)).toBeTruthy();
  });

  it('sends the file to the project chat and opens it', async () => {
    mockFilePreview.mockResolvedValue(ok('# a'));
    await render(<FilePreviewScreen />);
    fireEvent.press(await screen.findByText('Mandar para o chat'));
    await screen.findByText('Mandar para o chat');
    expect(mockSendFileToChat).toHaveBeenCalledWith('p1', 'a.md', '# a');
    expect(mockPush).toHaveBeenCalledWith('/chat/p1');
  });
});

describe('fileRules', () => {
  it('draws an image as a tappable line that fetches nothing until tapped', async () => {
    const onImage = jest.fn();
    const image = fileRules(onImage).image as (node: unknown) => React.ReactElement;
    await render(image({ key: 'i', attributes: { src: 'https://attacker/x.png', alt: 'gráfico' } }));
    expect(onImage).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('imagem: gráfico'));
    expect(onImage).toHaveBeenCalledWith('https://attacker/x.png');
  });
});

describe('onFileLink', () => {
  it('opens a relative Markdown link as a preview, http(s) in the browser, and nothing else', () => {
    const open = { file: jest.fn(), web: jest.fn() };
    expect(onFileLink('../plans/x.md', 'docs/specs', open)).toBe(false);
    expect(open.file).toHaveBeenCalledWith('docs/plans/x.md');
    onFileLink('https://termhub.dev', 'docs', open);
    expect(open.web).toHaveBeenCalledWith('https://termhub.dev');
    onFileLink('javascript:alert(1)', 'docs', open);
    expect(open.file).toHaveBeenCalledTimes(1);
    expect(open.web).toHaveBeenCalledTimes(1);
  });
});
