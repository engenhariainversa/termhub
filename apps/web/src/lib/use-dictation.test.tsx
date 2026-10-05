// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shared mock state for `./voice-recorder`. One recorder "instance" is enough: every test starts
 * at most one recording, and `vi.hoisted` keeps this reachable from both the `vi.mock` factory
 * (which runs before imports) and the test bodies below.
 */
const mocks = vi.hoisted(() => {
  const recorder = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ audio: new Blob(['0'.repeat(3000)]), seconds: 3 })),
    cancel: vi.fn(),
    lastOpts: null as { onAutoStop?: () => void } | null,
  };
  class MockVoiceRecorder {
    constructor(
      public tabId: string,
      opts: { onAutoStop?: () => void } = {},
    ) {
      recorder.lastOpts = opts;
    }
    start() {
      return recorder.start();
    }
    stop() {
      return recorder.stop();
    }
    cancel(keepStored?: boolean) {
      return recorder.cancel(keepStored);
    }
  }
  return {
    recorder,
    MockVoiceRecorder,
    canRecordVoice: vi.fn(() => true),
    transcribeClip: vi.fn(async () => ({ text: 'hello' })),
    configEnabled: vi.fn(async () => ({ enabled: true })),
    voiceStoreClear: vi.fn(),
  };
});

vi.mock('./voice-recorder', () => ({
  canRecordVoice: mocks.canRecordVoice,
  transcribeClip: mocks.transcribeClip,
  MAX_RECORDING_MS: 5 * 60 * 1000,
  VoiceRecorder: mocks.MockVoiceRecorder,
  // pt-BR, same wording as the real voice-recorder.ts — the hook only needs to know the name matches.
  micErrorMessage: (err: unknown) => ((err as { name?: string })?.name === 'NotAllowedError' ? 'Permissão do microfone negada' : 'Não foi possível acessar o microfone'),
}));

vi.mock('./api', () => ({
  api: { transcriptions: { config: mocks.configEnabled } },
}));

vi.mock('./voice-store', () => ({
  voiceStore: { clear: mocks.voiceStoreClear },
}));

/** Reloads the module fresh so its module-level `isVoiceEnabled()` cache doesn't leak between tests. */
async function load() {
  vi.resetModules();
  // The reset also reloads the i18n module, which starts in the runtime's language: pin pt-BR again,
  // as test-setup does, since these tests read the Portuguese notices.
  const { i18n } = await import('../i18n');
  await i18n.changeLanguage('pt-BR');
  return import('./use-dictation');
}

async function boot() {
  const { useDictation } = await load();
  const onText = vi.fn();
  const rendered = renderHook(() => useDictation(onText));
  await act(async () => {}); // flush the canRecordVoice/config effect
  return { ...rendered, onText };
}

/** Drives `start()` and flushes the recorder's `start()` promise so the hook settles into `recording`. */
async function startRecording(result: ReturnType<typeof boot> extends Promise<{ result: infer R }> ? R : never) {
  act(() => {
    result.current.start();
  });
  await act(async () => {});
}

beforeEach(() => {
  mocks.recorder.start.mockReset().mockImplementation(async () => {});
  mocks.recorder.stop.mockReset().mockImplementation(async () => ({ audio: new Blob(['0'.repeat(3000)]), seconds: 3 }));
  mocks.recorder.cancel.mockReset();
  mocks.recorder.lastOpts = null;
  mocks.canRecordVoice.mockReset().mockReturnValue(true);
  mocks.transcribeClip.mockReset().mockResolvedValue({ text: 'hello' });
  mocks.configEnabled.mockReset().mockResolvedValue({ enabled: true });
  mocks.voiceStoreClear.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useDictation', () => {
  it('reports off when canRecordVoice() is false', async () => {
    mocks.canRecordVoice.mockReturnValue(false);
    const { useDictation } = await load();
    const { result } = renderHook(() => useDictation(vi.fn()));
    // The first render cannot know yet — see the `checking` test below — but nothing is ever asked of
    // the server for a browser that cannot record.
    expect(result.current.state).toBe('checking');
    await act(async () => {});
    expect(result.current.state).toBe('off');
    expect(mocks.configEnabled).not.toHaveBeenCalled();
  });

  it('starts in checking, because telling off from idle costs one round trip', async () => {
    // Whoever renders this has to be able to say "not yet known" instead of guessing: the chat
    // composer used to guess `off` and flashed a disabled send button before its microphone.
    let settle: (c: { enabled: boolean }) => void = () => {};
    mocks.configEnabled.mockReturnValue(new Promise<{ enabled: boolean }>((resolve) => (settle = resolve)));
    const { useDictation } = await load();
    const { result } = renderHook(() => useDictation(vi.fn()));

    expect(result.current.state).toBe('checking');
    await act(async () => {
      settle({ enabled: true });
    });
    expect(result.current.state).toBe('idle');
  });

  it('reports off when the server has transcription disabled, idle when enabled', async () => {
    mocks.configEnabled.mockResolvedValue({ enabled: false });
    const { useDictation } = await load();
    const offRender = renderHook(() => useDictation(vi.fn()));
    await act(async () => {});
    expect(offRender.result.current.state).toBe('off');

    mocks.configEnabled.mockResolvedValue({ enabled: true });
    const { useDictation: useDictation2 } = await load();
    const idleRender = renderHook(() => useDictation2(vi.fn()));
    await act(async () => {});
    expect(idleRender.result.current.state).toBe('idle');
  });

  it('start() moves it to recording, and seconds follows the clock', async () => {
    vi.useFakeTimers();
    const { result } = await boot();
    await startRecording(result);
    expect(result.current.state).toBe('recording');
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current.seconds).toBe(2);
  });

  it('reports starting while the mic prompt is open, and recording only once it is granted', async () => {
    const { result } = await boot();
    let grant = () => {};
    mocks.recorder.start.mockImplementationOnce(() => new Promise<void>((resolve) => (grant = () => resolve())));

    act(() => {
      result.current.start();
    });

    // The hidden ref this replaced left `state` at 'idle' here, so the composer offered an enabled
    // "Ditar" button that did nothing for as long as the browser's own permission sheet was up.
    expect(result.current.state).toBe('starting');

    await act(async () => {
      grant();
    });

    expect(result.current.state).toBe('recording');
  });

  it('a getUserMedia rejection leaves it idle with a pt-BR permission error, and does not wedge the next start()', async () => {
    const { result } = await boot();
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    mocks.recorder.start.mockRejectedValueOnce(err);
    await startRecording(result);
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toMatch(/permiss/i);

    // The old code parked `'recording'` in a ref that only the success path ever moved: a prompt that
    // was denied, or never answered, made every later start() a no-op until the page was reloaded.
    await startRecording(result);

    expect(result.current.state).toBe('recording');
  });

  it('stop() with a clip under 2048 bytes says "Gravação muito curta" as a notice, not as an error, and clears the stored clip', async () => {
    const { result } = await boot();
    await startRecording(result);
    mocks.recorder.stop.mockResolvedValueOnce({ audio: new Blob(['x']), seconds: 1 });
    act(() => {
      result.current.stop();
    });
    await act(async () => {});
    expect(result.current.state).toBe('idle');
    // Silence here is indistinguishable from a broken microphone: "transcrevendo…" appears and
    // vanishes into an unchanged box. It is still not a failure, so it must not arrive as `error`.
    expect(result.current.notice).toBe('Gravação muito curta');
    expect(result.current.error).toBeNull();
    expect(mocks.transcribeClip).not.toHaveBeenCalled();
    // nothing worth keeping: the too-short clip shouldn't linger in IndexedDB
    expect(mocks.voiceStoreClear).toHaveBeenCalledWith('chat');
  });

  it('a transcription that comes back with no words says "Nenhuma fala reconhecida" as a notice, not as an error', async () => {
    const { result, onText } = await boot();
    await startRecording(result);
    mocks.transcribeClip.mockResolvedValueOnce({ text: '   ' });
    act(() => {
      result.current.stop();
    });
    await act(async () => {});
    expect(result.current.state).toBe('idle');
    expect(result.current.notice).toBe('Nenhuma fala reconhecida');
    expect(result.current.error).toBeNull();
    // Nothing to append: the box is left exactly as it was, and the notice is the only thing that
    // tells the person why.
    expect(onText).not.toHaveBeenCalled();
  });

  it('start() clears a notice left over from the last attempt', async () => {
    const { result } = await boot();
    await startRecording(result);
    mocks.recorder.stop.mockResolvedValueOnce({ audio: new Blob(['x']), seconds: 1 });
    act(() => {
      result.current.stop();
    });
    await act(async () => {});
    expect(result.current.notice).toBe('Gravação muito curta');

    await startRecording(result);

    expect(result.current.notice).toBeNull();
  });

  it('stop() with a real clip goes uploading -> transcribing -> idle and calls onText once', async () => {
    const { result, onText } = await boot();
    await startRecording(result);

    let onPhaseCapture: ((p: unknown) => void) | null = null;
    let resolveTranscribe: ((v: { text: string }) => void) | null = null;
    mocks.transcribeClip.mockImplementationOnce((_key: string, _clip: unknown, onPhase: (p: unknown) => void) => {
      onPhaseCapture = onPhase;
      onPhase({ phase: 'uploading', fraction: 1 });
      return new Promise((resolve) => {
        resolveTranscribe = resolve;
      });
    });

    act(() => {
      result.current.stop();
    });
    await act(async () => {});
    expect(result.current.state).toBe('uploading');

    act(() => {
      onPhaseCapture?.({ phase: 'transcribing', eta: null, progress: 0 });
    });
    expect(result.current.state).toBe('transcribing');

    await act(async () => {
      resolveTranscribe?.({ text: 'hello world' });
    });
    expect(result.current.state).toBe('idle');
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('hello world');
    // the text has been delivered: the stored audio has done its job and should not linger
    expect(mocks.voiceStoreClear).toHaveBeenCalledWith('chat');
  });

  it('a transcribeClip rejection leaves it idle with the thrown message as error, and clears the stored clip too, because the chat has no reader for the \'chat\' key', async () => {
    const { result } = await boot();
    await startRecording(result);
    mocks.transcribeClip.mockRejectedValueOnce(new Error('Falha ao transcrever o áudio'));
    act(() => {
      result.current.stop();
    });
    await act(async () => {});
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBe('Falha ao transcrever o áudio');
    // Keeping it was meant to let a refresh recover the audio, but nothing in this app loads the
    // `'chat'` key — `voiceStore.load`/`resumeTranscription` are Terminal.tsx's, keyed by real tab ids.
    // So the retained clip was only the person's voice left in IndexedDB after they were told the text
    // was lost, with nothing on screen offering it back.
    expect(mocks.voiceStoreClear).toHaveBeenCalledWith('chat');
  });

  it('cancel() during a recording returns to idle, calls the recorder cancel, never transcribes', async () => {
    const { result } = await boot();
    await startRecording(result);
    act(() => {
      result.current.cancel();
    });
    expect(result.current.state).toBe('idle');
    expect(mocks.recorder.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.transcribeClip).not.toHaveBeenCalled();
  });

  it("the recorder's onAutoStop behaves exactly like stop()", async () => {
    const { result, onText } = await boot();
    await startRecording(result);
    act(() => {
      mocks.recorder.lastOpts?.onAutoStop?.();
    });
    await act(async () => {});
    expect(result.current.state).toBe('idle');
    expect(mocks.recorder.stop).toHaveBeenCalledTimes(1);
    expect(mocks.transcribeClip).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledTimes(1);
  });
});
