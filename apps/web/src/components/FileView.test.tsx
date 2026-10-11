// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import type { FilePreview } from '../lib/types';

const filePreview = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, filePreview } };
});
const sendFileToChat = vi.hoisted(() => vi.fn());
vi.mock('../lib/chat-inbox', () => ({ sendFileToChat }));

const { FileView, dirOf } = await import('./FileView');

const ok = (content: string, over: Partial<FilePreview> = {}): FilePreview => ({
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

function show(props: Partial<Parameters<typeof FileView>[0]> = {}) {
  return render(
    <MemoryRouter>
      <FileView projectId="p1" path="docs/a.md" active {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FileView', () => {
  it('does not read the file until the tab is shown', async () => {
    filePreview.mockResolvedValue(ok('# Oi'));
    const { rerender } = show({ active: false });
    expect(filePreview).not.toHaveBeenCalled();
    rerender(
      <MemoryRouter>
        <FileView projectId="p1" path="docs/a.md" active />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Oi' });
    expect(filePreview).toHaveBeenCalledWith({ path: 'docs/a.md', project_id: 'p1', machine_id: null });
  });

  it('renders the Markdown sanitised, with the actions', async () => {
    filePreview.mockResolvedValue(ok('# Relatório\n\n<script>window.x=1</script>\n\n![g](https://attacker/x.png)'));
    const { container } = show();
    await screen.findByRole('heading', { name: 'Relatório' });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'imagem: g' }).getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: 'Abrir no GitHub' }).getAttribute('href')).toBe('https://github.com/o/r/blob/main/docs/a.md');
    expect(screen.getByText(/jarvis/)).toBeTruthy();
  });

  it('shows a .txt file as plain text', async () => {
    filePreview.mockResolvedValue(ok('# não é título', { name: 'notas.txt', github_url: null }));
    const { container } = show({ path: 'notas.txt' });
    await waitFor(() => expect(container.querySelector('pre')?.textContent).toBe('# não é título'));
    expect(container.querySelector('h1')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Abrir no GitHub' })).toBeNull();
  });

  it.each([
    ['outside', /fora das pastas/],
    ['hidden', /pastas ocultas/],
    ['too_large', /512 KB/],
    ['type', /\.md, \.markdown e \.txt/],
    ['missing', /não encontrado/],
    ['something_new', /Não foi possível abrir/],
  ])('says why a %s file has no preview', async (status, text) => {
    filePreview.mockResolvedValue({ status, machine: { id: 'm1', name: 'jarvis' } });
    show();
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('says to update the agent when the machine runs an old one', async () => {
    filePreview.mockRejectedValue(new ApiError(409, 'Atualize o agente desta máquina (npm i -g @termhub/agent, versão 0.16.0 ou mais nova) para ver arquivos', 'AGENT_OUTDATED'));
    show();
    expect(await screen.findByText(/Atualize o agente desta máquina/)).toBeTruthy();
  });

  it('opens a relative Markdown link inside the file as another preview, pinned on a double click', async () => {
    filePreview.mockResolvedValue(ok('[plano](../plans/x.md)'));
    const onOpenFile = vi.fn();
    show({ path: 'docs/superpowers/specs/a.md', onOpenFile });
    const link = await screen.findByRole('link', { name: 'plano' });
    fireEvent.click(link, { detail: 1 });
    fireEvent.click(link, { detail: 2 });
    expect(onOpenFile.mock.calls).toEqual([
      ['docs/superpowers/plans/x.md', 'preview'],
      ['docs/superpowers/plans/x.md', 'pin'],
    ]);
  });

  it('sends the file to the project chat as an attachment, without sending a message', async () => {
    filePreview.mockResolvedValue(ok('# a'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Mandar para o chat' }));
    expect(sendFileToChat).toHaveBeenCalledTimes(1);
    const [projectId, file] = sendFileToChat.mock.calls[0] as [string, File];
    expect(projectId).toBe('p1');
    expect(file.name).toBe('a.md');
    const text = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(file);
    });
    expect(text).toBe('# a');
  });
});

describe('dirOf', () => {
  it('is the folder of the path as asked', () => {
    expect(dirOf('docs/a.md')).toBe('docs');
    expect(dirOf('a.md')).toBe('');
    expect(dirOf('/tmp/a.md')).toBe('/tmp');
  });
});
