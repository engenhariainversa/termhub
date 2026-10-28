// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAttachment } from '../../lib/types';

const uploadMock = vi.fn();
const removeMock = vi.fn();

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
  return {
    ApiError,
    api: {
      chat: Object.assign(() => Promise.reject(new Error('not in this test')), {
        attachments: {
          upload: (...a: unknown[]) => uploadMock(...a),
          remove: (...a: unknown[]) => removeMock(...a),
          url: (id: string) => `/api/chat/attachments/${id}`,
        },
      }),
    },
  };
});
vi.mock('../../lib/image-downscale', () => ({ downscaleImage: async (file: File) => file }));
// Dictation off: the round button is always the send arrow.
vi.mock('../../lib/use-dictation', () => ({
  useDictation: () => ({ state: 'off', seconds: 0, error: null, notice: null, start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }),
}));

import { ChatComposer } from './ChatComposer';

const att = (over: Partial<ChatAttachment> & { id: string }): ChatAttachment => ({
  name: 'colado.txt',
  mime: 'text/plain; charset=utf-8',
  kind: 'text',
  bytes: 10,
  status: 'ready',
  error_code: null,
  meta: null,
  created_at: '2026-10-28T00:00:00.000Z',
  ...over,
});

/** jsdom's File has no `text()`. */
const readText = (file: Blob) =>
  new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file);
  });
const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: /enviar/i }) as HTMLButtonElement;
const paste = (text: string) => fireEvent.paste(box(), { clipboardData: { files: [], getData: (type: string) => (type === 'text/plain' ? text : '') } });

beforeEach(() => {
  uploadMock.mockReset();
  removeMock.mockReset();
  removeMock.mockResolvedValue({ ok: true });
  uploadMock.mockImplementation(async (file: File) => ({ attachment: att({ id: 'txt1', name: file.name, bytes: file.size }) }));
});

afterEach(() => {
  cleanup();
});

describe('ChatComposer: a long text goes as a .txt (TER-1139)', () => {
  it('keeps a short paste as text', async () => {
    render(<ChatComposer onSend={vi.fn(async () => true)} blockedReason={null} />);
    const event = paste('curto');
    // Not prevented: the browser pastes it into the box itself.
    expect(event).toBe(true);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('turns a long paste into a chip and sends what was typed with it', async () => {
    const onSend = vi.fn(async () => true);
    render(<ChatComposer onSend={onSend} blockedReason={null} projectId="p1" />);
    fireEvent.change(box(), { target: { value: 'resuma isto: ' } });
    paste('x'.repeat(5000));

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    const [file, name, project] = uploadMock.mock.calls[0] as [File, string, string];
    expect(name).toMatch(/^colado-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/);
    expect(file.type).toBe('text/plain');
    expect(await readText(file)).toBe('x'.repeat(5000));
    expect(project).toBe('p1');
    // The box keeps only what was typed; the chip and its notice say where the rest went.
    expect(box().value).toBe('resuma isto: ');
    expect(screen.getByText('Texto colado (5.000 caracteres) vai como anexo')).toBeTruthy();

    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('resuma isto:', ['txt1']));
  });

  it('puts the paste back as text with "Manter como texto"', async () => {
    render(<ChatComposer onSend={vi.fn(async () => true)} blockedReason={null} />);
    fireEvent.change(box(), { target: { value: 'antes ' } });
    paste('y'.repeat(4500));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Manter como texto' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Manter como texto' }));
    expect(box().value).toBe(`antes ${'y'.repeat(4500)}`);
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith('txt1'));
    expect(screen.queryByText(/Texto colado/)).toBeNull();
  });

  it('offers no undo when the text would not fit in a message', async () => {
    render(<ChatComposer onSend={vi.fn(async () => true)} blockedReason={null} />);
    paste('z'.repeat(9000));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Texto colado (9.000 caracteres) vai como anexo')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manter como texto' })).toBeNull();
  });

  it('sends a text too long for the server as a .txt instead of being refused', async () => {
    const onSend = vi.fn(async () => true);
    render(<ChatComposer onSend={onSend} blockedReason={null} />);
    // Typed (or pasted by a browser that never fired the paste event): only the send can catch it.
    fireEvent.change(box(), { target: { value: 'w'.repeat(8001) } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(await readText(uploadMock.mock.calls[0][0] as File)).toBe('w'.repeat(8001));
    expect(onSend).toHaveBeenCalledWith('Mensagem longa (8.001 caracteres) enviada como anexo', ['txt1']);
    expect(box().value).toBe('');
  });

  it('gives the long text back when its upload fails', async () => {
    uploadMock.mockRejectedValueOnce(new Error('offline'));
    const onSend = vi.fn(async () => true);
    render(<ChatComposer onSend={onSend} blockedReason={null} />);
    fireEvent.change(box(), { target: { value: 'w'.repeat(8001) } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(box().value).toBe('w'.repeat(8001)));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('Não foi possível enviar o arquivo')).toBeTruthy();
  });
});
