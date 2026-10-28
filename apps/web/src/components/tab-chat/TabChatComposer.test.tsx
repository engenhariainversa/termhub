// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pasteFileMock = vi.fn();

vi.mock('../../lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { tabs: { pasteFile: (...a: unknown[]) => pasteFileMock(...a) } } };
});

import { TabChatComposer } from './TabChatComposer';

const box = () => screen.getByRole('textbox', { name: 'Mensagem para a sessão' }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;
const paste = (text: string) => fireEvent.paste(box(), { clipboardData: { files: [], getData: (type: string) => (type === 'text/plain' ? text : '') } });

beforeEach(() => {
  pasteFileMock.mockReset();
  pasteFileMock.mockImplementation(async (_tab: string, _file: Blob, name: string) => ({ path: `/tmp/termhub/${name}`, bytes: 1, mime: 'text/plain' }));
});

afterEach(() => {
  cleanup();
});

describe('TabChatComposer: a long text goes as a file on the machine (TER-1139)', () => {
  it('keeps a short paste as text', () => {
    render(<TabChatComposer tabId="t1" projectId="p1" machineId="m1" onSend={vi.fn(async () => true)} blockedReason={null} />);
    expect(paste('ls -la')).toBe(true);
    expect(pasteFileMock).not.toHaveBeenCalled();
  });

  it('saves a long paste on the machine and sends its path after what was typed', async () => {
    const onSend = vi.fn(async () => true);
    render(<TabChatComposer tabId="t1" projectId="p1" machineId="m1" onSend={onSend} blockedReason={null} />);
    fireEvent.change(box(), { target: { value: 'analise o log' } });
    paste('x'.repeat(4000));

    await waitFor(() => expect(pasteFileMock).toHaveBeenCalledTimes(1));
    const name = pasteFileMock.mock.calls[0][2] as string;
    expect(name).toMatch(/^colado-.*\.txt$/);
    expect(box().value).toBe('analise o log');
    expect(screen.getByText('Texto colado (4.000 caracteres) vai como anexo')).toBeTruthy();

    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(`analise o log\n\n/tmp/termhub/${name}`));
  });

  it('puts a paste that fits back as text', async () => {
    render(<TabChatComposer tabId="t1" projectId="p1" machineId="m1" onSend={vi.fn(async () => true)} blockedReason={null} />);
    paste('y'.repeat(3500));
    await waitFor(() => expect(pasteFileMock).toHaveBeenCalledTimes(1));
    // Under the tab's 4000, but past half of it: a file that can still go back as text.
    fireEvent.click(await screen.findByRole('button', { name: 'Manter como texto' }));
    expect(box().value).toBe('y'.repeat(3500));
    expect(screen.queryByText(/colado-/)).toBeNull();
  });

  it('saves a text too long for the session as a file when it is sent', async () => {
    const onSend = vi.fn(async () => true);
    render(<TabChatComposer tabId="t1" projectId="p1" machineId="m1" onSend={onSend} blockedReason={null} />);
    fireEvent.change(box(), { target: { value: 'w'.repeat(4001) } });
    expect(screen.getByText('Mensagem grande demais: 4.001 de 4.000 caracteres; vai como anexo .txt')).toBeTruthy();
    fireEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const name = pasteFileMock.mock.calls[0][2] as string;
    expect(onSend).toHaveBeenCalledWith(`/tmp/termhub/${name}`);
    expect(box().value).toBe('');
  });
});
