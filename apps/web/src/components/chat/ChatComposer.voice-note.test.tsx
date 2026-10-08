// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAttachment } from '../../lib/types';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  created: 0,
}));

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
          upload: (...a: unknown[]) => mocks.upload(...a),
          remove: (...a: unknown[]) => mocks.remove(...a),
          url: (id: string) => `/api/chat/attachments/${id}`,
        },
      }),
    },
  };
});
vi.mock('../../lib/voice-recorder', () => ({
  VoiceRecorder: class {
    constructor() {
      mocks.created += 1;
    }
    start = () => mocks.start();
    stop = () => mocks.stop();
    cancel = () => mocks.cancel();
  },
  micErrorMessage: () => 'Permissão do microfone negada',
}));
vi.mock('../../lib/voice-store', () => ({ voiceStore: { clear: vi.fn(async () => undefined) } }));
// Dictation is idle: the box offers voice notes, which is what this file is about.
vi.mock('../../lib/use-dictation', () => ({
  useDictation: () => ({ state: 'idle', seconds: 0, error: null, notice: null, start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }),
}));

import { ChatComposer } from './ChatComposer';
import { HOLD_MS } from '../../lib/use-voice-note';

// jsdom may not have PointerEvent: without it `clientX`/`clientY` would be dropped from the events.
if (typeof window.PointerEvent === 'undefined') {
  (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {
    pointerId = 1;
  } as unknown as typeof MouseEvent;
}

const stored = (over: Partial<ChatAttachment> = {}): ChatAttachment => ({
  id: 'v1',
  name: 'audio.webm',
  mime: 'audio/webm',
  kind: 'audio',
  bytes: 4096,
  status: 'pending',
  error_code: null,
  meta: null,
  created_at: '2026-10-07T00:00:00.000Z',
  ...over,
});

const clip = (bytes = 4096) => ({ audio: new Blob([new Uint8Array(bytes)], { type: 'audio/webm;codecs=opus' }), seconds: 3 });

const mic = () => screen.getByRole('button', { name: 'Gravar áudio' });

/** Lets the recorder's and the upload's promises settle. */
async function flush() {
  for (let i = 0; i < 5; i += 1) await act(async () => undefined);
}

/** Down on the microphone, held past the click threshold, recording. */
async function hold() {
  fireEvent.pointerDown(mic(), { clientX: 200, clientY: 200, button: 0 });
  await act(async () => {
    vi.advanceTimersByTime(HOLD_MS);
  });
  await flush();
}

function renderComposer(onSend = vi.fn(async () => true)) {
  render(<ChatComposer onSend={onSend} />);
  return onSend;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.created = 0;
  mocks.upload.mockReset();
  mocks.remove.mockReset();
  mocks.start.mockReset();
  mocks.stop.mockReset();
  mocks.cancel.mockReset();
  mocks.start.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(clip());
  mocks.upload.mockResolvedValue({ attachment: stored() });
  mocks.remove.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ChatComposer voice notes', () => {
  it('empty: the round button is the microphone; with text it is the send arrow again', () => {
    renderComposer();
    expect(mic()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText(/pergunte/i), { target: { value: 'oi' } });
    expect(screen.queryByRole('button', { name: 'Gravar áudio' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
  });

  it('a click only says how it works, and never opens the microphone', async () => {
    renderComposer();
    fireEvent.pointerDown(mic(), { clientX: 200, clientY: 200, button: 0 });
    fireEvent.pointerUp(mic());

    expect(screen.getByText('Segure para gravar')).toBeTruthy();
    // The permission is only asked once a hold actually records.
    expect(mocks.created).toBe(0);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('recording: the clock and the cancel hint; letting go uploads the clip and sends it alone', async () => {
    const onSend = renderComposer();
    await hold();

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0:00')).toBeTruthy();
    expect(screen.getByText('‹ deslize para cancelar')).toBeTruthy();

    fireEvent.pointerUp(mic());
    await flush();

    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    const [file, name] = mocks.upload.mock.calls[0] as [File, string];
    expect(file.type).toBe('audio/webm');
    expect(name).toMatch(/^audio-.*\.webm$/);
    expect(onSend).toHaveBeenCalledWith('', ['v1']);
    // Sent: the chip left with it.
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('cancelled: a drag to the left drops the recording, nothing is uploaded or sent', async () => {
    const onSend = renderComposer();
    await hold();

    fireEvent.pointerMove(mic(), { clientX: 80, clientY: 200 });
    fireEvent.pointerUp(mic());
    await flush();

    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByText('‹ deslize para cancelar')).toBeNull();
  });

  it('locked: a drag up keeps recording after letting go, with Descartar and Enviar áudio', async () => {
    const onSend = renderComposer();
    await hold();

    fireEvent.pointerMove(mic(), { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Enviar áudio' }));
    // The click the browser fires after that pointerup is the hold's, not a press on Enviar áudio.
    fireEvent.click(screen.getByRole('button', { name: 'Enviar áudio' }));
    await flush();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Descartar áudio' })).toBeTruthy();
    expect(screen.queryByText('‹ deslize para cancelar')).toBeNull();

    const send = screen.getByRole('button', { name: 'Enviar áudio' });
    fireEvent.pointerDown(send, { button: 0 });
    fireEvent.pointerUp(send);
    fireEvent.click(send);
    await flush();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('', ['v1']);
  });

  it('locked, then discarded: nothing is sent', async () => {
    const onSend = renderComposer();
    await hold();
    fireEvent.pointerMove(mic(), { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Enviar áudio' }));

    fireEvent.click(screen.getByRole('button', { name: 'Descartar áudio' }));
    await flush();

    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(mic()).toBeTruthy();
  });

  it('let go while the microphone is still opening (the permission sheet): dropped quietly', async () => {
    let open: () => void = () => undefined;
    mocks.start.mockReturnValue(new Promise<void>((resolve) => (open = resolve)));
    const onSend = renderComposer();
    fireEvent.pointerDown(mic(), { clientX: 200, clientY: 200, button: 0 });
    await act(async () => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    fireEvent.pointerUp(mic());
    await act(async () => open());
    await flush();

    expect(mocks.cancel).toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('a clip too short to hold speech is not sent', async () => {
    mocks.stop.mockResolvedValue(clip(100));
    const onSend = renderComposer();
    await hold();
    fireEvent.pointerUp(mic());
    await flush();

    expect(screen.getByText('Gravação muito curta')).toBeTruthy();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('the keyboard holds it too: Space down records, Space up sends', async () => {
    const onSend = renderComposer();
    fireEvent.keyDown(mic(), { key: ' ' });
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(1);

    fireEvent.keyUp(mic(), { key: ' ' });
    await flush();
    expect(onSend).toHaveBeenCalledWith('', ['v1']);
  });

  it('a send the server refused keeps the voice note in the box', async () => {
    const onSend = renderComposer(vi.fn(async () => false));
    await hold();
    fireEvent.pointerUp(mic());
    await flush();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
  });
});
