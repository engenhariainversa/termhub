// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
// jsdom has no canvas: the downscale is a pass-through here, and is unit-tested on its own.
vi.mock('../../lib/image-downscale', () => ({ downscaleImage: async (file: File) => file }));
// Dictation off: the round button is always the send arrow, which is the button under test.
vi.mock('../../lib/use-dictation', () => ({
  useDictation: () => ({ state: 'off', seconds: 0, error: null, notice: null, start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }),
}));

import { ChatComposer } from './ChatComposer';

const att = (over: Partial<ChatAttachment> & { id: string }): ChatAttachment => ({
  name: 'relatorio.pdf',
  mime: 'application/pdf',
  kind: 'pdf',
  bytes: 10,
  status: 'pending',
  error_code: null,
  meta: null,
  created_at: '2026-09-26T00:00:00.000Z',
  ...over,
});

const pdf = (name = 'relatorio.pdf') => new File([new Uint8Array(10)], name, { type: 'application/pdf' });

function addFiles(files: File[]) {
  fireEvent.change(screen.getByLabelText('Arquivos para anexar'), { target: { files } });
}

const sendButton = () => screen.getByRole('button', { name: /enviar/i }) as HTMLButtonElement;

beforeEach(() => {
  uploadMock.mockReset();
  removeMock.mockReset();
  removeMock.mockResolvedValue({ ok: true });
  // Object URLs exist only in browsers; the thumbnail only needs a string.
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:thumb');
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe('ChatComposer attachments', () => {
  it('disables send while an attachment is still uploading, says so, then sends the ids and clears', async () => {
    let resolveUpload!: (v: { attachment: ChatAttachment }) => void;
    uploadMock.mockImplementation(() => new Promise((resolve) => (resolveUpload = resolve)));
    const onSend = vi.fn(async () => true);
    render(<ChatComposer onSend={onSend} sending={false} blockedReason={null} projectId="p1" />);

    addFiles([pdf()]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'leia isso' } });
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    // The file, its name and the project travel with the upload.
    expect(uploadMock.mock.calls[0][1]).toBe('relatorio.pdf');
    expect(uploadMock.mock.calls[0][2]).toBe('p1');

    // Review Focus #2: a message must not leave while its file is still on the wire.
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText('enviando anexo…')).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    fireEvent.click(sendButton());
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      resolveUpload({ attachment: att({ id: 'att1' }) });
    });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(screen.queryByText('enviando anexo…')).toBeNull();
    // Uploaded, and the server is still extracting it: the chip says so.
    expect(screen.getByText('processando…')).toBeTruthy();

    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('leia isso', ['att1']));
    // `true` from onSend: the text and the chips are gone.
    await waitFor(() => expect(screen.queryByText('relatorio.pdf')).toBeNull());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('sends with an uploaded chip and no text at all', async () => {
    uploadMock.mockResolvedValue({ attachment: att({ id: 'att1', status: 'ready' }) });
    const onSend = vi.fn(async () => true);
    render(<ChatComposer onSend={onSend} sending={false} blockedReason={null} />);

    addFiles([pdf()]);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('', ['att1']));
  });

  it('keeps the chips and the text when onSend answers false', async () => {
    uploadMock.mockResolvedValue({ attachment: att({ id: 'att1', status: 'ready' }) });
    const onSend = vi.fn(async () => false);
    render(<ChatComposer onSend={onSend} sending={false} blockedReason={null} />);

    addFiles([pdf()]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'oi' } });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(screen.getByText('relatorio.pdf')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('oi');
  });

  it('refuses an unsupported type and an oversized file in the box, without uploading', async () => {
    const onSend = vi.fn(async () => true);
    render(<ChatComposer onSend={onSend} sending={false} blockedReason={null} />);

    const big = new File([new Uint8Array(1)], 'foto.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    addFiles([new File(['x'], 'setup.exe', { type: 'application/octet-stream' }), big]);

    expect(await screen.findByText('Tipo de arquivo não suportado')).toBeTruthy();
    expect(screen.getByText('Arquivo acima de 10 MB')).toBeTruthy();
    expect(uploadMock).not.toHaveBeenCalled();
    // A refused chip counts for nothing: the button stays disabled and the chip can be removed.
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remover setup.exe' }));
    expect(screen.queryByText('setup.exe')).toBeNull();
  });

  it('caps the message at five files and says so in the status line', async () => {
    uploadMock.mockResolvedValue({ attachment: att({ id: 'x', status: 'ready' }) });
    render(<ChatComposer onSend={async () => true} sending={false} blockedReason={null} />);

    addFiles([1, 2, 3, 4, 5, 6].map((n) => pdf(`a${n}.pdf`)));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(5));
    expect(screen.queryByText('a6.pdf')).toBeNull();
    expect(screen.getByText('No máximo 5 anexos por mensagem')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Anexar arquivo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('✕ aborts an upload in flight, and deletes one that already landed', async () => {
    let signal!: AbortSignal;
    uploadMock.mockImplementationOnce((_f: Blob, _n: string, _p: unknown, _cb: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    });
    uploadMock.mockResolvedValueOnce({ attachment: att({ id: 'att2', name: 'b.pdf', status: 'ready' }) });
    render(<ChatComposer onSend={async () => true} sending={false} blockedReason={null} />);

    addFiles([pdf('a.pdf'), pdf('b.pdf')]);
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
    await screen.findByText('b.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'Remover a.pdf' }));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText('a.pdf')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remover b.pdf' }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith('att2'));
    expect(screen.queryByText('b.pdf')).toBeNull();
  });

  it('shows the server refusal on the chip and offers to try again after a network failure', async () => {
    const { ApiError } = await import('../../lib/api');
    uploadMock.mockRejectedValueOnce(new ApiError(0, 'Sem conexão com o servidor', 'NETWORK'));
    uploadMock.mockResolvedValueOnce({ attachment: att({ id: 'att1', status: 'ready' }) });
    render(<ChatComposer onSend={async () => true} sending={false} blockedReason={null} />);

    addFiles([pdf()]);
    expect(await screen.findByText('Sem conexão com o servidor')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'tentar de novo' }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  });

  it('attaches files pasted into the box and dropped onto it', async () => {
    uploadMock.mockResolvedValue({ attachment: att({ id: 'att1', status: 'ready' }) });
    render(<ChatComposer onSend={async () => true} sending={false} blockedReason={null} />);

    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [pdf('colado.pdf')], getData: () => '' } });
    expect(await screen.findByText('colado.pdf')).toBeTruthy();

    fireEvent.drop(screen.getByLabelText('Anexos').parentElement as HTMLElement, { dataTransfer: { files: [pdf('solto.pdf')], types: ['Files'] } });
    expect(await screen.findByText('solto.pdf')).toBeTruthy();
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
  });

  it('shows an image chip as a thumbnail', async () => {
    uploadMock.mockResolvedValue({ attachment: att({ id: 'att1', kind: 'image', name: 'foto.png', status: 'ready' }) });
    render(<ChatComposer onSend={async () => true} sending={false} blockedReason={null} />);

    addFiles([new File([new Uint8Array(10)], 'foto.png', { type: 'image/png' })]);
    const img = (await screen.findByAltText('foto.png')) as HTMLImageElement;
    expect(img.src).toContain('blob:thumb');
  });
});
