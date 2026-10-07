import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { TChatAttachment } from '@/services/api/contract';
import { MessageAttachments, useAttachmentSource } from './message-attachments';

// The store's `attachmentSource`: each call is a fresh DPoP proof, numbered so a test can tell them apart.
let signed = 0;
const mockAttachmentSource = jest.fn(async (id: string) => ({ uri: `https://termhub.dev/api/m/v1/chat/attachments/${id}`, headers: { Authorization: 'Bearer tok', DPoP: `proof-${++signed}` } }));
/** What the socket heard since the message was sent (`attachment_status`), by id. */
let mockStatuses: Record<string, TChatAttachment> = {};
const mockRetryAttachment = jest.fn(async (_id: string): Promise<void> => undefined);
jest.mock('../viewmodel/useChatStore', () => ({
  useChatStore: (
    selector: (s: { attachmentSource: typeof mockAttachmentSource; attachmentStatuses: Record<string, TChatAttachment>; retryAttachment: typeof mockRetryAttachment }) => unknown,
  ) => selector({ attachmentSource: mockAttachmentSource, attachmentStatuses: mockStatuses, retryAttachment: mockRetryAttachment }),
}));
// The clip is downloaded into the cache on the first play; under jest that is a fixed path.
const mockCachedAudio = jest.fn(async (_a: { id: string }, _sign: unknown) => 'file:///cache/chat-audio-au1.m4a');
jest.mock('../viewmodel/audio-cache', () => ({ cachedAudio: (a: { id: string }, sign: unknown) => mockCachedAudio(a, sign) }));
// The fake of test/fakes/expo-audio.js, with its test hooks.
const audioFake = require('expo-audio') as { __player: Record<string, jest.Mock>; __setStatus(s: object): void; __reset(): void };

const image: TChatAttachment = { id: 'img1', name: 'foto.jpg', mime: 'image/jpeg', kind: 'image', bytes: 20, status: 'ready', error_code: null, meta: null, created_at: '2026-09-26T00:00:00.000Z' };

beforeEach(() => {
  signed = 0;
  mockAttachmentSource.mockClear();
  mockStatuses = {};
  mockCachedAudio.mockClear();
  audioFake.__reset();
  mockRetryAttachment.mockReset();
  mockRetryAttachment.mockResolvedValue(undefined);
});

describe('MessageAttachments: a clip whose transcription was unavailable (TER-1035)', () => {
  const clip = (over: Partial<TChatAttachment> = {}): TChatAttachment => ({
    id: 'c1', name: 'audio.m4a', mime: 'audio/mp4', kind: 'audio', bytes: 229376, status: 'failed', error_code: 'TRANSCRIPTION_UNAVAILABLE', meta: { reason: 'refused' }, created_at: '2026-10-07T19:29:27.000Z', ...over,
  });

  it('says why and offers to try again; a clip whisper could not decode does not', async () => {
    await render(<MessageAttachments attachments={[clip(), clip({ id: 'c2', name: 'ruim.m4a', error_code: 'TRANSCRIPTION_FAILED', meta: null })]} />);
    expect(screen.getByText('falhou: o serviço de transcrição recusou o acesso')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Tentar de novo' });
    expect(buttons).toHaveLength(1);
    await fireEvent.press(buttons[0]!);
    await waitFor(() => expect(mockRetryAttachment).toHaveBeenCalledWith('c1'));
  });

  it('shows the server refusal under the clip', async () => {
    const { ApiError } = jest.requireActual('@/services/api/errors');
    mockRetryAttachment.mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'Este anexo não pode ser processado de novo'));
    await render(<MessageAttachments attachments={[clip()]} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Este anexo não pode ser processado de novo')).toBeTruthy();
  });
});

describe('MessageAttachments images', () => {
  it('re-signs once on a failed load, then offers a tap that re-signs again', async () => {
    await render(<MessageAttachments attachments={[image]} />);
    const loaded = await screen.findByLabelText('foto.jpg');
    expect(loaded.props.source.headers.DPoP).toBe('proof-1');

    // A proof is single-use and short-lived: the first failure gets a fresh one on its own.
    await act(async () => fireEvent(loaded, 'error'));
    await waitFor(() => expect(mockAttachmentSource).toHaveBeenCalledTimes(2));
    const retried = await screen.findByLabelText('foto.jpg');
    expect(retried.props.source.headers.DPoP).toBe('proof-2');
    expect(screen.queryByRole('button', { name: 'Toque para recarregar' })).toBeNull();

    // The retry failed too: no loop, a placeholder the person can tap.
    await act(async () => fireEvent(retried, 'error'));
    expect(await screen.findByRole('button', { name: 'Toque para recarregar' })).toBeTruthy();
    expect(mockAttachmentSource).toHaveBeenCalledTimes(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Toque para recarregar' }));
    await waitFor(() => expect(mockAttachmentSource).toHaveBeenCalledTimes(3));
    expect((await screen.findByLabelText('foto.jpg')).props.source.headers.DPoP).toBe('proof-3');
  });

  it('sizes the thumbnail, its loading box and its reload button from the dimensions', async () => {
    mockAttachmentSource.mockImplementationOnce(() => new Promise(() => {})); // never signs: the loading box stays
    const sized = { ...image, meta: { width: 1600, height: 1200 } };
    await render(<MessageAttachments attachments={[sized]} />);
    expect(StyleSheet.flatten(screen.getByTestId('attachment-placeholder').props.style)).toMatchObject({ width: 160, height: 120 });
  });

  it('sizes the loaded image from the dimensions too', async () => {
    await render(<MessageAttachments attachments={[{ ...image, meta: { width: 1200, height: 1600 } }]} />);
    const loaded = await screen.findByLabelText('foto.jpg');
    expect(StyleSheet.flatten(loaded.props.style)).toMatchObject({ width: 120, height: 160 });
  });

  it('keeps the square box when the image has no dimensions', async () => {
    await render(<MessageAttachments attachments={[image]} />);
    const loaded = await screen.findByLabelText('foto.jpg');
    // No explicit size: only what the `h-40 w-40` class gives (NativeWind may or may not turn it into style here).
    expect([undefined, 160]).toContain(StyleSheet.flatten(loaded.props.style)?.width);
  });

  it('a new attempt never returns the previous proof, not even for one render', async () => {
    const seen: (string | null)[] = [];
    const { rerender } = await renderHook(
      ({ attempt }: { attempt: number }) => {
        const s = useAttachmentSource('img1', attempt);
        seen.push(s?.headers.DPoP ?? null);
        return s;
      },
      { initialProps: { attempt: 0 } },
    );
    await waitFor(() => expect(seen).toContain('proof-1'));

    mockAttachmentSource.mockImplementationOnce(() => new Promise(() => {})); // the new proof is still being signed
    seen.length = 0;
    await act(async () => rerender({ attempt: 1 }));
    expect(seen).not.toContain('proof-1');
    expect(seen.at(-1)).toBeNull();
  });
});

describe('MessageAttachments audio (TER-1036)', () => {
  const clip: TChatAttachment = { id: 'au1', name: 'audio-2026-10-07.m4a', mime: 'audio/mp4', kind: 'audio', bytes: 4000, status: 'pending', error_code: null, meta: null, created_at: '2026-10-07T00:00:00.000Z' };

  it('is a player: nothing downloaded until played, then play/pause with where it is and how long it lasts', async () => {
    await render(<MessageAttachments attachments={[{ ...clip, status: 'ready', meta: { duration_s: 12 } }]} />);
    expect(screen.getByText('0:12')).toBeTruthy();
    expect(mockCachedAudio).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'Reproduzir áudio' }));
    await waitFor(() => expect(audioFake.__player.play).toHaveBeenCalledTimes(1));
    expect(mockCachedAudio).toHaveBeenCalledWith(expect.objectContaining({ id: 'au1' }), mockAttachmentSource);
    expect(audioFake.__player.replace).toHaveBeenCalledWith({ uri: 'file:///cache/chat-audio-au1.m4a' });

    await act(async () => audioFake.__setStatus({ playing: true, currentTime: 3, duration: 12 }));
    expect(screen.getByText('0:03 / 0:12')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Pausar áudio' }));
    expect(audioFake.__player.pause).toHaveBeenCalledTimes(1);
  });

  it('says it is being transcribed, then folds the transcription the socket brought until asked for', async () => {
    const view = await render(<MessageAttachments attachments={[clip]} />);
    expect(screen.getByText('transcrevendo…')).toBeTruthy();
    expect(screen.queryByText('Ver transcrição')).toBeNull();

    mockStatuses = { au1: { ...clip, status: 'ready', transcript: 'roda os testes no servidor' } };
    await view.rerender(<MessageAttachments attachments={[clip]} />);
    expect(screen.queryByText('transcrevendo…')).toBeNull();
    expect(screen.queryByText('roda os testes no servidor')).toBeNull();
    await fireEvent.press(screen.getByText('Ver transcrição'));
    expect(screen.getByText('roda os testes no servidor')).toBeTruthy();
    await fireEvent.press(screen.getByText('Ocultar transcrição'));
    expect(screen.queryByText('roda os testes no servidor')).toBeNull();
  });

  it('a transcription that failed says so', async () => {
    await render(<MessageAttachments attachments={[{ ...clip, status: 'failed', error_code: 'TRANSCRIPTION_UNAVAILABLE' }]} />);
    expect(screen.getByText('falhou: transcrição indisponível')).toBeTruthy();
  });
});
