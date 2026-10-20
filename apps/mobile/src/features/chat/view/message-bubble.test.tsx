import { render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock('./message-attachments', () => {
  const { Text } = require('react-native');
  return { MessageAttachments: ({ attachments, tone }: { attachments: { name: string }[]; tone?: string }) => <Text>{`anexos:${tone}:${attachments.map((a) => a.name).join(',')}`}</Text> };
});
import type { ChatMessage } from '../model/types';
import { MessageBubble } from './message-bubble';

const answer = (over: Partial<ChatMessage>): ChatMessage =>
  ({ id: 'm1', conversation_id: 'c1', role: 'assistant', text: '', usage: null, error_code: null, created_at: '2026-09-30T06:00:00.000Z', ...over }) as ChatMessage;

// TER-588: the usage limit, and the account that took over, read the same as on the web.
describe('MessageBubble notices', () => {
  it('says the account hit its usage limit instead of the generic failure', async () => {
    await render(<MessageBubble message={answer({ error_code: 'USAGE_LIMIT', notice: { kind: 'usage_limit', account: 'Pessoal', resets_at: null, fallback: 'auto_swap_off' } })} streamed={undefined} started={false} />);
    expect(screen.getByText('A conta "Pessoal" do Claude atingiu o limite de uso. A troca automática está desligada nesta máquina.')).toBeTruthy();
    expect(screen.queryByText(/parou no meio/)).toBeNull();
  });

  it('says which account took over above the answer it gave', async () => {
    await render(<MessageBubble message={answer({ text: 'oi!', notice: { kind: 'account_swap', from: null, to: 'Trabalho', resets_at: null } })} streamed={undefined} started />);
    expect(screen.getByText('A conta padrão do Claude desta máquina atingiu o limite de uso; a conta "Trabalho" assumiu esta resposta.')).toBeTruthy();
  });
});

// TER-941: a Markdown path in an answer opens its preview.
const { props: markdownProps } = jest.requireMock('react-native-markdown-display') as { props: { children: string; onLinkPress?: (url: string) => boolean }[] };
const lastMarkdown = () => markdownProps[markdownProps.length - 1]!;

describe('MessageBubble file paths', () => {
  it("links the paths and opens a path's preview with the chat's project", async () => {
    await render(<MessageBubble message={answer({ text: 'Relatório em ~/r.md e `docs/a.md`.' })} streamed={undefined} started fileContext={{ projectId: 'p1' }} />);
    const md = lastMarkdown();
    expect(md.children).toBe('Relatório em [~/r.md](termhub-file:~%2Fr.md) e [`docs/a.md`](termhub-file:docs%2Fa.md).');
    expect(md.onLinkPress?.('termhub-file:~%2Fr.md')).toBe(false);
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/file-preview', params: { path: '~/r.md', project_id: 'p1' } });
    // any other link keeps the system's own handling
    expect(md.onLinkPress?.('https://termhub.dev')).toBe(true);
  });

  it("uses the session's tab", async () => {
    await render(<MessageBubble message={answer({ text: 'Escrevi /tmp/x.md' })} streamed={undefined} started fileContext={{ tabId: 't1' }} />);
    lastMarkdown().onLinkPress?.('termhub-file:%2Ftmp%2Fx.md');
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/file-preview', params: { path: '/tmp/x.md', tab_id: 't1' } });
  });

  it('leaves paths as text without a context', async () => {
    await render(<MessageBubble message={answer({ text: 'Escrevi /tmp/x.md' })} streamed={undefined} started />);
    expect(lastMarkdown().children).toBe('Escrevi /tmp/x.md');
    expect(lastMarkdown().onLinkPress?.('termhub-file:%2Ftmp%2Fx.md')).toBe(false);
  });

  // TER-1089: only http(s) leaves the app.
  it('opens only http(s) links in the browser', async () => {
    await render(<MessageBubble message={answer({ text: 'oi' })} streamed={undefined} started fileContext={{ projectId: 'p1' }} />);
    const onLinkPress = lastMarkdown().onLinkPress!;
    expect(onLinkPress('http://192.168.68.114:8765/a.png')).toBe(true);
    for (const url of ['mailto:a@b.dev', 'intent://x', 'file:///etc/passwd']) expect(onLinkPress(url)).toBe(false);
  });
});

describe("MessageBubble: the person's links (TER-1089)", () => {
  it('links the URLs of their message and of the quote', async () => {
    await render(
      <MessageBubble
        message={answer({ role: 'user', text: 'abre https://termhub.dev/x.', reply_to: { id: 'm0', role: 'assistant', excerpt: 'veja http://192.168.68.114:8765/a.png' } })}
        streamed={undefined}
        started={false}
      />,
    );
    expect(screen.getByText('https://termhub.dev/x')).toBeTruthy();
    expect(screen.getByText('http://192.168.68.114:8765/a.png')).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});

// TER-1086: a file the assistant published from a machine rides under the answer, on its own surface.
describe('MessageBubble attachments', () => {
  it('shows the files of an answer, on the answer\'s surface', async () => {
    const file = { id: 'f1', name: 'post-1.png', mime: 'image/png', kind: 'image', bytes: 10, status: 'ready', error_code: null, meta: null, created_at: '' };
    await render(<MessageBubble message={answer({ text: 'Arquivo de hulk: post-1.png', attachments: [file] } as Partial<ChatMessage>)} streamed={undefined} started={false} />);
    expect(screen.getByText('anexos:surface:post-1.png')).toBeTruthy();
    expect(screen.queryByText(/parou no meio/)).toBeNull();
  });
});
