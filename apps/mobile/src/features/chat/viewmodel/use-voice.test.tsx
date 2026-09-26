// The dictation state machine over the mock transport's `/transcriptions` routes and a fake
// `expo-audio` recorder. A `.tsx` under the `ui` project: `expo-audio` reaches native modules at
// import time, which the plain-Node `logic` project cannot load.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import * as SecureStore from 'expo-secure-store';
import { mmkv } from '@/services/storage';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { MAX_RECORDING_S, useRecorder, useVoice, VOICE_MIME, type RecordedClip } from './use-voice';

const mockRecorder = {
  uri: 'file:///cache/clip.m4a' as string | null,
  currentTime: 0,
  isRecording: false,
  prepareToRecordAsync: jest.fn(async () => undefined),
  record: jest.fn(),
  stop: jest.fn(async () => undefined),
};
const mockPermission = { granted: true };
jest.mock('expo-audio', () => ({
  IOSOutputFormat: { MPEG4AAC: 'aac ' },
  AudioQuality: { MEDIUM: 64 },
  useAudioRecorder: () => mockRecorder,
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: mockPermission.granted, status: mockPermission.granted ? 'granted' : 'denied', canAskAgain: true, expires: 'never' })),
  setAudioModeAsync: jest.fn(async () => undefined),
}));

const secureItems = (SecureStore as unknown as { __items: Map<string, string> }).__items;

/** RNTL's `waitFor` spends `timeout` of *fake* time when fake timers are on (50 ms a step): the
 * transcription polls once a second, so the waits that span the polling get a bigger budget. */
const POLLING = { timeout: 5000 };

async function setup() {
  const ctx = setupSession();
  await enrol(ctx);
  return { ...ctx, deps: { api: ctx.api, auth: () => ctx.store.getState().auth() } };
}

beforeEach(() => {
  jest.useFakeTimers();
  mmkv.clearAll();
  secureItems.clear();
  mockPermission.granted = true;
  mockRecorder.uri = 'file:///cache/clip.m4a';
  jest.clearAllMocks();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('useRecorder', () => {
  it('records a clip and hands back its file, mime and length; cancel keeps nothing; a denied mic rejects and says why', async () => {
    const { result } = await renderHook(() => useRecorder());
    expect(result.current).toMatchObject({ state: 'idle', seconds: 0, error: null });

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe('recording');
    expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);
    expect(mockRecorder.record).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.seconds).toBe(2);

    let clip: RecordedClip | null = null;
    await act(async () => {
      clip = await result.current.stop();
    });
    expect(clip).toEqual({ uri: 'file:///cache/clip.m4a', mime: VOICE_MIME, seconds: 2 });
    expect(result.current).toMatchObject({ state: 'idle', seconds: 0 });
    await expect(result.current.stop()).resolves.toBeNull(); // nothing being recorded

    await act(async () => {
      await result.current.start();
    });
    await act(async () => result.current.cancel());
    expect(result.current.state).toBe('idle');
    expect(mockRecorder.stop).toHaveBeenCalledTimes(2);

    mockPermission.granted = false;
    await act(async () => {
      await expect(result.current.start()).rejects.toThrow('Permissão do microfone negada');
    });
    expect(result.current).toMatchObject({ state: 'idle', error: 'Permissão do microfone negada' });
    expect(mockRecorder.record).toHaveBeenCalledTimes(2);
  });
});

describe('useVoice', () => {
  it('asks the server whether it transcribes, records, uploads the clip as audio/m4a with its length, polls, and delivers the text', async () => {
    const ctx = await setup();
    const realTranscribe = ctx.api.transcribe.bind(ctx.api);
    const transcribe = jest.spyOn(ctx.api, 'transcribe');
    // Held back: the async render drains the mock's answer before `renderHook` resolves, so the
    // `checking` state would already be gone by the first assertion.
    let answerConfig!: (c: { enabled: boolean }) => void;
    jest.spyOn(ctx.api, 'transcriptionConfig').mockReturnValue(new Promise((resolve) => (answerConfig = resolve)));
    const onText = jest.fn();
    const { result } = await renderHook(() => useVoice(onText, ctx.deps));
    expect(result.current.state).toBe('checking');
    await act(async () => answerConfig({ enabled: true }));
    await waitFor(() => expect(result.current.state).toBe('idle'));

    // The permission sheet held up the same way: `starting` lasts exactly as long as it is up.
    let grantMic!: () => void;
    (requestRecordingPermissionsAsync as jest.Mock).mockReturnValueOnce(new Promise((resolve) => (grantMic = () => resolve({ granted: true, status: 'granted', canAskAgain: true, expires: 'never' }))));
    await act(async () => result.current.start());
    expect(result.current.state).toBe('starting');
    await act(async () => grantMic());
    await waitFor(() => expect(result.current.state).toBe('recording'));
    expect(mockRecorder.record).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.seconds).toBe(3);

    // And the upload: `uploading` lasts while the clip is on its way.
    let releaseUpload!: () => void;
    transcribe.mockImplementationOnce((...args) => new Promise((resolve) => (releaseUpload = () => resolve(realTranscribe(...args)))));
    await act(async () => result.current.stop());
    expect(result.current.state).toBe('uploading');
    expect(result.current.seconds).toBe(0);
    await act(async () => releaseUpload());
    await waitFor(() => expect(result.current.state).toBe('transcribing'));
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0]!.slice(1, 3)).toEqual(['file:///cache/clip.m4a', VOICE_MIME]);
    expect(transcribe.mock.calls[0]![3]).toBeCloseTo(3, 1);

    await waitFor(() => expect(onText).toHaveBeenCalledWith('roda os testes da aba api'), POLLING);
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(result.current).toMatchObject({ error: null, notice: null });
  });

  it('a clip under half a second is a notice, not an upload; cancel drops the clip; a denied microphone is an error', async () => {
    const ctx = await setup();
    const transcribe = jest.spyOn(ctx.api, 'transcribe');
    const { result } = await renderHook(() => useVoice(jest.fn(), ctx.deps));
    await waitFor(() => expect(result.current.state).toBe('idle'));

    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.state).toBe('recording'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    await act(async () => result.current.stop());
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(result.current.notice).toBe('Gravação muito curta');
    expect(transcribe).not.toHaveBeenCalled();

    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.state).toBe('recording'));
    await act(async () => result.current.cancel());
    expect(result.current.state).toBe('idle');
    expect(mockRecorder.stop).toHaveBeenCalledTimes(2);
    expect(transcribe).not.toHaveBeenCalled();

    mockPermission.granted = false;
    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(result.current.error).toBe('Permissão do microfone negada');
    expect(mockRecorder.record).toHaveBeenCalledTimes(2);
  });

  it('a recording is cut at the 5-minute cap exactly like a tap on Parar', async () => {
    const ctx = await setup();
    const transcribe = jest.spyOn(ctx.api, 'transcribe');
    const { result } = await renderHook(() => useVoice(jest.fn(), ctx.deps));
    await waitFor(() => expect(result.current.state).toBe('idle'));
    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.state).toBe('recording'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MAX_RECORDING_S * 1000);
    });
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1), POLLING);
    expect(transcribe.mock.calls[0]![3]).toBe(MAX_RECORDING_S);
  });

  it('is off when the server does not transcribe', async () => {
    const ctx = await setup();
    jest.spyOn(ctx.api, 'transcriptionConfig').mockResolvedValue({ enabled: false });
    const { result } = await renderHook(() => useVoice(jest.fn(), ctx.deps));
    await waitFor(() => expect(result.current.state).toBe('off'));
  });
});
