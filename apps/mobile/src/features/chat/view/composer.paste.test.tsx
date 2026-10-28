import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { TChatAttachment } from '@/services/api/contract';
import type { PickedFile } from '../viewmodel/attachments';
import { Composer } from './composer';

const mockVoice = { state: 'idle' as import('../viewmodel/use-voice').VoiceState, seconds: 0, error: null as string | null, notice: null as string | null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() };
const mockRecorder = { state: 'idle' as const, seconds: 0, error: null, start: jest.fn(async () => undefined), stop: jest.fn(async () => null), cancel: jest.fn() };
jest.mock('../viewmodel/use-voice', () => ({
  useVoice: () => mockVoice,
  useRecorder: () => mockRecorder,
}));
// The cache file is native: here it is the text itself, under the name the helper gives it.
const mockWritten: string[] = [];
jest.mock('../viewmodel/pasted-file', () => ({
  pastedTextFile: jest.fn(async (text: string) => {
    mockWritten.push(text);
    return { uri: `file:///cache/colado-${mockWritten.length}.txt`, name: 'colado-2026-10-28-0905.txt', mime: 'text/plain', bytes: text.length };
  }),
}));

const att = (over: Partial<TChatAttachment> & { id: string }): TChatAttachment => ({
  name: 'colado-2026-10-28-0905.txt', mime: 'text/plain; charset=utf-8', kind: 'text', bytes: 10, status: 'ready', error_code: null, meta: null, created_at: '2026-10-28T00:00:00.000Z', ...over,
});

async function renderComposer(over: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const props = {
    sending: false,
    onSend: jest.fn(async () => true),
    uploadAttachment: jest.fn(async (_file: PickedFile) => att({ id: 'txt1' })),
    deleteAttachment: jest.fn(async () => undefined),
    ...over,
  };
  await render(<Composer {...props} />);
  return props;
}
const box = () => screen.getByLabelText('Mensagem');

beforeEach(() => {
  mockWritten.length = 0;
  mockVoice.state = 'idle';
});

describe('Composer: a long text goes as a .txt (TER-1139)', () => {
  it('keeps a short paste as text', async () => {
    const props = await renderComposer();
    await fireEvent.changeText(box(), 'olá, tudo bem?');
    expect(box().props.value).toBe('olá, tudo bem?');
    expect(props.uploadAttachment).not.toHaveBeenCalled();
  });

  it('turns a long paste into a chip and sends what was typed with it', async () => {
    const props = await renderComposer();
    await fireEvent.changeText(box(), 'resuma: ');
    await fireEvent.changeText(box(), `resuma: ${'x'.repeat(5000)}`);

    await waitFor(() => expect(props.uploadAttachment).toHaveBeenCalledTimes(1));
    expect(mockWritten).toEqual(['x'.repeat(5000)]);
    expect(box().props.value).toBe('resuma: ');
    expect(await screen.findByText('Texto colado (5.000 caracteres) vai como anexo')).toBeTruthy();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('resuma: ', [att({ id: 'txt1' })]));
  });

  it('puts the paste back as text with "Manter como texto"', async () => {
    const props = await renderComposer();
    await fireEvent.changeText(box(), 'y'.repeat(4500));
    await waitFor(() => expect(props.uploadAttachment).toHaveBeenCalledTimes(1));

    await fireEvent.press(await screen.findByRole('button', { name: 'Manter como texto' }));
    expect(box().props.value).toBe('y'.repeat(4500));
    await waitFor(() => expect(props.deleteAttachment).toHaveBeenCalledWith('txt1'));
    expect(screen.queryByText(/Texto colado/)).toBeNull();
  });

  it('sends a text too long for the server as a .txt instead of being refused', async () => {
    const props = await renderComposer();
    // Grown a little at a time (typed, dictated): no paste to catch, so the send does it.
    await fireEvent.changeText(box(), 'w'.repeat(3999));
    await fireEvent.changeText(box(), 'w'.repeat(7990));
    await fireEvent.changeText(box(), 'w'.repeat(8001));
    expect(props.uploadAttachment).not.toHaveBeenCalled();

    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Enviar' })));
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    expect(mockWritten).toEqual(['w'.repeat(8001)]);
    expect(props.onSend).toHaveBeenCalledWith('Mensagem longa (8.001 caracteres) enviada como anexo', [att({ id: 'txt1' })]);
  });

  it('sends the file alone where the long text has no summary (a tab), past its own limit', async () => {
    const props = await renderComposer({ maxChars: 4000, summarizeLongText: false });
    await fireEvent.changeText(box(), 'w'.repeat(1999));
    await fireEvent.changeText(box(), 'w'.repeat(3990));
    await fireEvent.changeText(box(), 'w'.repeat(4001));
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Enviar' })));
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('', [att({ id: 'txt1' })]));
  });

  it('gives the long text back when its upload fails', async () => {
    const props = await renderComposer({ uploadAttachment: jest.fn(async () => Promise.reject(new Error('Sem conexão'))) });
    await fireEvent.changeText(box(), 'w'.repeat(3999));
    await fireEvent.changeText(box(), 'w'.repeat(7990));
    await fireEvent.changeText(box(), 'w'.repeat(8001));
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Enviar' })));
    await waitFor(() => expect(box().props.value).toBe('w'.repeat(8001)));
    expect(props.onSend).not.toHaveBeenCalled();
    expect(screen.getByText('Sem conexão')).toBeTruthy();
  });
});
