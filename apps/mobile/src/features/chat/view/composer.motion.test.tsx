import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { getAnimatedStyle } from 'react-native-reanimated';
import { Composer } from './composer';

const mockVoice = { state: 'idle' as import('../viewmodel/use-voice').VoiceState, seconds: 0, error: null as string | null, notice: null as string | null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() };
jest.mock('../viewmodel/use-voice', () => ({
  useVoice: () => mockVoice,
  useRecorder: () => ({ state: 'idle', seconds: 0, error: null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() }),
}));

// The system's "reduce motion", read by `useReducedMotion`; the rest of Reanimated is the real one.
let mockReducedMotion = false;
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  return { __esModule: true, ...actual, default: actual.default, useReducedMotion: () => mockReducedMotion };
});

const frame = () => getAnimatedStyle(screen.getByTestId('composer-text')) as { marginBottom: number; marginLeft: number; marginRight: number; height: number };

async function renderComposer() {
  await render(<Composer sending={false} onSend={jest.fn(async () => true)} uploadAttachment={jest.fn()} deleteAttachment={jest.fn()} />);
  return screen.getByLabelText('Mensagem');
}

/** The input laid out at `height`: what the platform reports once the text it sized itself to changed. */
const laidOut = (input: ReturnType<typeof screen.getByLabelText>, height: number) =>
  fireEvent(input, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height } } });

async function wrapTo(input: ReturnType<typeof screen.getByLabelText>, height: number) {
  await fireEvent.changeText(input, 'uma linha que já não cabe ao lado dos botões');
  await laidOut(input, height);
}

/** Moves the fake clock, running the animation frames it covers. */
const elapse = (ms: number) => act(() => jest.advanceTimersByTime(ms));

describe('Composer motion', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReducedMotion = false;
    mockVoice.state = 'idle';
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('glides the text from the buttons\' row to its own line above it, and back when the box empties', async () => {
    const input = await renderComposer();
    expect(frame()).toMatchObject({ marginLeft: 40, marginBottom: 0, height: 36 });

    await wrapTo(input, 44);
    // Mid-way the pill is between one layout and the other, not in either.
    await elapse(80);
    const mid = frame();
    expect(mid.marginBottom).toBeGreaterThan(0);
    expect(mid.marginBottom).toBeLessThan(40);
    expect(mid.marginLeft).toBeGreaterThan(8);
    expect(mid.marginLeft).toBeLessThan(40);
    await elapse(300);
    expect(frame()).toMatchObject({ marginLeft: 8, marginBottom: 40, height: 50 });

    // Each new line glides too.
    await laidOut(input, 66);
    await elapse(80);
    expect(frame().height).toBeGreaterThan(50);
    expect(frame().height).toBeLessThan(72);
    await elapse(300);
    expect(frame().height).toBe(72);

    await fireEvent.changeText(input, '');
    await elapse(80);
    expect(frame().marginBottom).toBeGreaterThan(0);
    await elapse(300);
    expect(frame()).toMatchObject({ marginLeft: 40, marginBottom: 0, height: 36 });
    // The same input all along: never remounted, so the keyboard would have stayed up.
    expect(screen.getByLabelText('Mensagem')).toBe(input);
  });

  it('a single line a fraction taller than the line box stays beside the buttons', async () => {
    const input = await renderComposer();
    await fireEvent.changeText(input, 'oi');
    await laidOut(input, 22.4);
    await elapse(300);
    expect(frame()).toMatchObject({ marginLeft: 40, marginBottom: 0, height: 36 });
  });

  it('with a line typed, ↑ takes the microphone\'s place on the right and the text keeps its room (TER-1036)', async () => {
    const input = await renderComposer();
    expect(screen.getByRole('button', { name: 'Gravar áudio' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();
    expect(frame().marginRight).toBe(40);

    await fireEvent.changeText(input, 'oi');
    expect(screen.queryByRole('button', { name: 'Gravar áudio' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
    await elapse(300);
    // Still one line, beside the buttons: + on the left, ↑ alone on the right.
    expect(frame()).toMatchObject({ marginLeft: 40, marginRight: 40, marginBottom: 0, height: 36 });
  });

  it('with dictation off there is no microphone, and the empty box keeps a disabled ↑', async () => {
    mockVoice.state = 'off';
    await renderComposer();
    expect(screen.queryByRole('button', { name: 'Gravar áudio' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    expect(frame().marginRight).toBe(40);
  });

  it('jumps straight to the new layout when the system asks for reduced motion', async () => {
    mockReducedMotion = true;
    const input = await renderComposer();
    await wrapTo(input, 44);
    await elapse(0);
    expect(frame()).toMatchObject({ marginLeft: 8, marginBottom: 40, height: 50 });
    await fireEvent.changeText(input, '');
    await elapse(0);
    expect(frame()).toMatchObject({ marginLeft: 40, marginBottom: 0, height: 36 });
  });
});
