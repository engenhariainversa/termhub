import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import type { TChatAttachment } from '@/services/api/contract';
import { Composer } from './composer';

// TER-1036: the microphone of an empty box records a voice note while it is held. Dictation (the
// other hook) only decides whether the server transcribes; the recorder is the voice note's.
const mockVoice = { state: 'idle' as import('../viewmodel/use-voice').VoiceState, seconds: 0, level: null, error: null as string | null, notice: null as string | null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() };
const clip = { uri: 'file:///cache/clip.m4a', mime: 'audio/m4a', seconds: 3 };
const mockRecorder = {
  state: 'idle' as 'idle' | 'recording',
  seconds: 0,
  level: null as number | null,
  error: null as string | null,
  start: jest.fn(async (): Promise<void> => undefined),
  stop: jest.fn(async (): Promise<typeof clip | null> => clip),
  cancel: jest.fn(),
};
jest.mock('../viewmodel/use-voice', () => ({
  useVoice: () => mockVoice,
  useRecorder: () => mockRecorder,
  MIN_CLIP_S: 0.5,
  MAX_RECORDING_S: 300,
}));

const audio = (over: Partial<TChatAttachment> = {}): TChatAttachment => ({
  id: 'au1', name: 'audio.m4a', mime: 'audio/mp4', kind: 'audio', bytes: 4000, status: 'pending', error_code: null, meta: null, created_at: '2026-10-07T00:00:00.000Z', ...over,
});

async function renderComposer(over: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const props = {
    sending: false,
    onSend: jest.fn(async () => true),
    uploadAttachment: jest.fn(async () => audio()),
    deleteAttachment: jest.fn(async () => undefined),
    ...over,
  };
  await render(<Composer {...props} />);
  return props;
}

const mic = () => screen.getByRole('button', { name: 'Gravar áudio' });
const at = (pageX: number, pageY: number) => ({ nativeEvent: { pageX, pageY } });
/** The finger goes down on the microphone. */
const press = async () => {
  await fireEvent(mic(), 'responderGrant', at(300, 700));
};
/** Past `HOLD_MS`, and the microphone opened: recording while held. */
const holdOn = async () => {
  await press();
  await act(async () => {
    jest.advanceTimersByTime(250);
  });
};
const flush = () => act(async () => undefined);

beforeEach(() => {
  jest.useFakeTimers();
  Object.assign(mockVoice, { state: 'idle', error: null, notice: null });
  Object.assign(mockRecorder, { seconds: 0, level: null, error: null });
  mockRecorder.start.mockClear();
  mockRecorder.stop.mockClear();
  mockRecorder.cancel.mockClear();
  (Haptics.impactAsync as jest.Mock).mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Composer voice note (TER-1036)', () => {
  it('empty: the button on the right is the microphone, not ↑; nothing asks for the microphone yet', async () => {
    await renderComposer();
    expect(mic()).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();
    expect(mockRecorder.start).not.toHaveBeenCalled();
  });

  it('with text: ↑ takes the microphone\'s place, and comes back to the microphone once the box is emptied', async () => {
    await renderComposer();
    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'oi');
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Gravar áudio' })).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('Mensagem'), '');
    expect(mic()).toBeTruthy();
  });

  it('a short tap only says how to record: the microphone is never opened (no permission asked)', async () => {
    await renderComposer();
    await press();
    await fireEvent(mic(), 'responderRelease');
    expect(screen.getByText('Segure para gravar')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(mockRecorder.start).not.toHaveBeenCalled();
    // The hint goes by itself.
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('Segure para gravar')).toBeNull();
  });

  it('recording: held, the row shows the clock, the wave, the lock and "slide to cancel", with a haptic as it starts', async () => {
    await renderComposer();
    await holdOn();
    expect(mockRecorder.start).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
    expect(screen.getByText('‹ deslize para cancelar')).toBeTruthy();
    expect(screen.getByText('0:00')).toBeTruthy();
    expect(screen.getByTestId('recording-wave', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByTestId('voice-note-lock')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Anexar' })).toBeNull();
    // The microphone stays under the finger.
    expect(mic()).toBeTruthy();
  });

  it('letting go sends the clip: it goes up as an audio chip and leaves alone, without text, once uploaded', async () => {
    const props = await renderComposer({ uploadAttachment: jest.fn(async () => audio()) });
    await holdOn();
    await fireEvent(mic(), 'responderRelease');
    await flush();
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(props.uploadAttachment).toHaveBeenCalledWith(expect.objectContaining({ uri: clip.uri, mime: 'audio/m4a', name: expect.stringMatching(/^audio-.*\.m4a$/) }), expect.any(Function));
    await flush();
    expect(props.onSend).toHaveBeenCalledWith('', [audio()]);
    await flush();
    // Gone from the box once the server took it: the microphone is back.
    expect(screen.queryByText(/audio-.*\.m4a/)).toBeNull();
    expect(mic()).toBeTruthy();
  });

  it('cancelled: sliding left drops the clip, with a haptic, and nothing is uploaded or sent', async () => {
    const props = await renderComposer();
    await holdOn();
    await fireEvent(mic(), 'responderMove', at(250, 700));
    expect(mockRecorder.cancel).not.toHaveBeenCalled();
    await fireEvent(mic(), 'responderMove', at(190, 705));
    expect(mockRecorder.cancel).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Heavy);
    expect(screen.queryByText('‹ deslize para cancelar')).toBeNull();
    await fireEvent(mic(), 'responderRelease');
    await flush();
    expect(mockRecorder.stop).not.toHaveBeenCalled();
    expect(props.uploadAttachment).not.toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('locked: sliding up keeps it recording without the finger, with ✕ to discard and ↑ to send', async () => {
    const props = await renderComposer();
    await holdOn();
    await fireEvent(mic(), 'responderMove', at(300, 620));
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
    expect(screen.getByRole('button', { name: 'Descartar áudio' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar áudio' })).toBeTruthy();
    expect(screen.queryByText('‹ deslize para cancelar')).toBeNull();
    expect(mockRecorder.stop).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'Enviar áudio' }));
    await flush();
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    await flush();
    expect(props.onSend).toHaveBeenCalledWith('', [audio()]);
  });

  it('locked, then discarded: the clip is dropped', async () => {
    const props = await renderComposer();
    await holdOn();
    await fireEvent(mic(), 'responderMove', at(300, 600));
    await fireEvent.press(screen.getByRole('button', { name: 'Descartar áudio' }));
    expect(mockRecorder.cancel).toHaveBeenCalledTimes(1);
    expect(mic()).toBeTruthy();
    expect(props.uploadAttachment).not.toHaveBeenCalled();
  });

  it('a touch the system takes away while held becomes a locked recording: nothing is lost', async () => {
    await renderComposer();
    await holdOn();
    await fireEvent(mic(), 'responderTerminate');
    expect(screen.getByRole('button', { name: 'Enviar áudio' })).toBeTruthy();
    expect(mockRecorder.cancel).not.toHaveBeenCalled();
  });

  it('let go while the microphone is still opening (the permission sheet): nothing records', async () => {
    let opened: () => void = () => undefined;
    mockRecorder.start.mockImplementationOnce(() => new Promise<void>((resolve) => (opened = resolve)));
    const props = await renderComposer();
    await holdOn();
    await fireEvent(mic(), 'responderRelease');
    expect(mockRecorder.cancel).toHaveBeenCalledTimes(1);
    await act(async () => opened());
    expect(screen.queryByText('‹ deslize para cancelar')).toBeNull();
    expect(props.uploadAttachment).not.toHaveBeenCalled();
  });

  it('a screen reader starts a locked recording from the microphone\'s activation', async () => {
    await renderComposer();
    await fireEvent(mic(), 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
    await flush();
    expect(screen.getByRole('button', { name: 'Enviar áudio' })).toBeTruthy();
  });

  it('a clip too short to hold speech is not sent, and says so', async () => {
    mockRecorder.stop.mockResolvedValueOnce({ ...clip, seconds: 0.2 });
    const props = await renderComposer();
    await holdOn();
    await fireEvent(mic(), 'responderRelease');
    await flush();
    expect(screen.getByText('Gravação muito curta')).toBeTruthy();
    expect(props.uploadAttachment).not.toHaveBeenCalled();
  });

  it('a failed upload keeps the chip in the box to retry, and nothing leaves on its own', async () => {
    const props = await renderComposer({ uploadAttachment: jest.fn(async () => Promise.reject(new Error('rede'))) });
    await holdOn();
    await fireEvent(mic(), 'responderRelease');
    await flush();
    await flush();
    expect(screen.getByText(/^audio-.*\.m4a$/)).toBeTruthy();
    expect(screen.getByText('tentar de novo')).toBeTruthy();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('no microphone while the server does not transcribe: the empty box keeps a disabled ↑', async () => {
    mockVoice.state = 'off';
    await renderComposer();
    expect(screen.queryByRole('button', { name: 'Gravar áudio' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });
});
