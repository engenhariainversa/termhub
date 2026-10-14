import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import type { TChatAttachment } from '@/services/api/contract';
import type { SubmitKeyEvent } from '../../../../modules/key-commands';
import { Composer } from './composer';

// TER-368: a hardware keyboard's Return in the composer. The native view (modules/key-commands) is the
// jest fake from test/ui-setup.js: a plain view whose `onSubmitKey` the test calls as UIKit would.
// Shift+Return and the on-screen keyboard never reach it, so they are the TextInput's own new line.

const mockVoice = {
  state: 'idle' as import('../viewmodel/use-voice').VoiceState,
  seconds: 0,
  level: null as number | null,
  error: null as string | null,
  notice: null as string | null,
  start: jest.fn(),
  stop: jest.fn(),
  cancel: jest.fn(),
};
jest.mock('../viewmodel/use-voice', () => ({
  useVoice: () => mockVoice,
  useRecorder: () => ({ state: 'idle', seconds: 0, level: null, error: null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() }),
}));

const att = (over: Partial<TChatAttachment> & { id: string }): TChatAttachment => ({
  name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 10, status: 'pending', error_code: null, meta: null, created_at: '2026-09-26T00:00:00.000Z', ...over,
});
const documentPicker = DocumentPicker as jest.Mocked<typeof DocumentPicker>;

async function renderComposer(over: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const props = {
    sending: false,
    onSend: jest.fn(async () => true),
    uploadAttachment: jest.fn(async () => att({ id: 'att1', status: 'ready' })),
    deleteAttachment: jest.fn(async () => undefined),
    ...over,
  };
  const view = await render(<Composer {...props} />);
  return { props, rerender: (next: Partial<typeof props>) => view.rerender(<Composer {...props} {...next} />) };
}

const keys = () => screen.getByTestId('key-commands');
const box = () => screen.getByLabelText('Mensagem');
/** The native view's event for Return (`none`) or ⌘Return (`command`). */
const returnKey = (modifiers: SubmitKeyEvent['modifiers'] = 'none') => fireEvent(keys(), 'submitKey', { nativeEvent: { modifiers } });
const type = (text: string) => fireEvent.changeText(box(), text);

beforeEach(() => {
  Object.assign(mockVoice, { state: 'idle', seconds: 0, level: null, error: null, notice: null });
  documentPicker.getDocumentAsync.mockReset().mockResolvedValue({ canceled: true, assets: null } as never);
});

describe('Composer hardware Return', () => {
  it('Return sends the text by the same path as ↑ and empties the box', async () => {
    const { props } = await renderComposer();
    await type('oi\nmundo');
    await returnKey();
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSend).toHaveBeenCalledWith('oi\nmundo', []);
    expect(box().props.value).toBe('');
  });

  it('⌘Return sends too', async () => {
    const { props } = await renderComposer();
    await type('oi');
    await returnKey('command');
    expect(props.onSend).toHaveBeenCalledWith('oi', []);
  });

  it('sends the last letter typed right before Return, before the box rendered it', async () => {
    const { props } = await renderComposer();
    await act(async () => {
      box().props.onChangeText('oi!');
      keys().props.onSubmitKey({ nativeEvent: { modifiers: 'none' } });
    });
    expect(props.onSend).toHaveBeenCalledWith('oi!', []);
  });

  it('with an empty or blank box, Return sends nothing and leaves the box alone', async () => {
    const { props } = await renderComposer();
    await returnKey();
    await type('   ');
    await returnKey();
    expect(props.onSend).not.toHaveBeenCalled();
    expect(box().props.value).toBe('   ');
  });

  it('nothing leaves while a chip uploads; once it uploaded, Return sends it with the text', async () => {
    let resolveUpload!: (a: TChatAttachment) => void;
    const { props } = await renderComposer({ uploadAttachment: jest.fn(() => new Promise<TChatAttachment>((resolve) => (resolveUpload = resolve))) });
    documentPicker.getDocumentAsync.mockResolvedValueOnce({ canceled: false, assets: [{ uri: 'file:///tmp/relatorio.pdf', name: 'relatorio.pdf', mimeType: 'application/pdf', size: 10 }] } as never);
    await fireEvent.press(screen.getByRole('button', { name: 'Anexar' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Arquivo' }));
    expect(await screen.findByText('enviando anexo…')).toBeTruthy();
    await type('leia isso');

    await returnKey();
    expect(props.onSend).not.toHaveBeenCalled();
    expect(box().props.value).toBe('leia isso');

    await act(async () => resolveUpload(att({ id: 'att1' })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled());
    await returnKey();
    expect(props.onSend).toHaveBeenCalledWith('leia isso', [att({ id: 'att1' })]);
  });

  it('sends nothing while a message is still on its way', async () => {
    const { props } = await renderComposer({ sending: true });
    await type('de novo');
    await returnKey();
    expect(props.onSend).not.toHaveBeenCalled();
    expect(box().props.value).toBe('de novo');
  });

  it('sends nothing while a dictated clip is transcribed, as ↑ is disabled then', async () => {
    mockVoice.state = 'transcribing';
    const { props } = await renderComposer();
    await type('antes do ditado');
    await returnKey();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('gives the text back when the send fails', async () => {
    const { props } = await renderComposer({ onSend: jest.fn(async () => false) });
    await type('vai falhar');
    await returnKey();
    expect(props.onSend).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(box().props.value).toBe('vai falhar'));
  });

  it('while the session works (↑ is Interromper), Return still sends: the agent queues it', async () => {
    const onInterrupt = jest.fn();
    const { props } = await renderComposer({ onInterrupt });
    await type('próximo passo');
    await returnKey();
    expect(props.onSend).toHaveBeenCalledWith('próximo passo', []);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('leaves Return to the text view when nothing can be typed: an offline session, or while dictating', async () => {
    const { rerender } = await renderComposer();
    expect(keys().props.enabled).toBe(true);
    await act(async () => rerender({ disabled: true }));
    expect(keys().props.enabled).toBe(false);
    await act(async () => rerender({ disabled: false }));
    expect(keys().props.enabled).toBe(true);
    mockVoice.state = 'recording';
    await act(async () => rerender({}));
    expect(keys().props.enabled).toBe(false);
  });
});
