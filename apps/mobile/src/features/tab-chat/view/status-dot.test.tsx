import { act, render, screen } from '@testing-library/react-native';
import { getAnimatedStyle } from 'react-native-reanimated';
import { setLocale } from '@/i18n';
import type { TTabSummary } from '@/services/api/contract';
import { SessionRow } from './session-row';
import { StatusDot, dotClass } from './status-dot';

jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));

// The system's "reduce motion", read by `useReducedMotion`; the rest of Reanimated is the real one.
let mockReducedMotion = false;
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  return { __esModule: true, ...actual, default: actual.default, useReducedMotion: () => mockReducedMotion };
});

const tab = (o: Partial<TTabSummary> = {}): TTabSummary => ({
  id: 't1',
  name: 'api',
  project: { id: 'p1', key: 'TER', name: 'termhub' },
  machine: { id: 'm1', name: 'jarvis' },
  state: 'working',
  background: false,
  finished: false,
  blocked: false,
  auth_required: false,
  trust_prompt: false,
  state_at: '2026-10-08T10:00:00.000Z',
  needs_you: false,
  activity: null,
  activity_verb: null,
  availability: 'ready',
  auto_ref: null,
  ...o,
});

/** The dot is hidden from accessibility (the row's label says the state): queries must look anyway. */
const HIDDEN = { includeHiddenElements: true };
type Frame = { opacity?: number; transform?: Array<{ scale?: number; rotate?: string }> };
const style = (id: string) => getAnimatedStyle(screen.getByTestId(id, HIDDEN)) as Frame;
const scale = () => style('status-dot').transform?.[0]?.scale ?? 1;
const rotate = () => style('status-dot-ring').transform?.[0]?.rotate ?? '0deg';
/** Moves the fake clock, running the animation frames it covers. */
const elapse = (ms: number) => act(() => jest.advanceTimersByTime(ms));

describe('StatusDot (TER-1044)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReducedMotion = false;
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('pulses (scale and opacity) while the tab works, its background work included', async () => {
    for (const background of [false, true]) {
      const { unmount } = await render(<StatusDot tab={tab({ background })} />);
      await elapse(375);
      expect(scale()).toBeGreaterThan(1);
      expect(style('status-dot').opacity).toBeLessThan(1);
      await unmount();
    }
  });

  it('stands still when the tab waits for the person, finished or stopped', async () => {
    for (const t of [tab({ needs_you: true, state: 'waiting_permission' }), tab({ state: 'idle', finished: true }), tab({ state: 'idle' })]) {
      const { unmount } = await render(<StatusDot tab={t} />);
      await elapse(375);
      expect(scale()).toBe(1);
      await unmount();
    }
  });

  it('colours each state: accent working, danger needing the person, ok finished', () => {
    expect(dotClass(tab())).toBe('bg-app-accent');
    expect(dotClass(tab({ state: 'waiting_input', needs_you: true }))).toBe('bg-app-danger');
    expect(dotClass(tab({ state: 'idle', finished: true }))).toBe('bg-app-ok');
    expect(dotClass(tab({ availability: 'offline' }))).toBe('bg-app-muted');
  });

  it('rings a tab an automatic run works in, turning while it works; a manual tab has no ring', async () => {
    const { unmount } = await render(<StatusDot tab={tab({ auto_ref: 'TER-123' })} />);
    await elapse(300);
    expect(rotate()).not.toBe('0deg');
    await unmount();
    await render(<StatusDot tab={tab()} />);
    expect(screen.queryByTestId('status-dot-ring', HIDDEN)).toBeNull();
  });

  it('keeps only the colour with Reduce Motion on', async () => {
    mockReducedMotion = true;
    await render(<StatusDot tab={tab({ auto_ref: 'TER-123' })} />);
    await elapse(375);
    expect(scale()).toBe(1);
    expect(rotate()).toBe('0deg');
  });

  it('stops while the list is off screen', async () => {
    await render(<StatusDot tab={tab({ auto_ref: 'TER-123' })} onScreen={false} />);
    await elapse(375);
    expect(scale()).toBe(1);
    expect(rotate()).toBe('0deg');
  });
});

describe('SessionRow (TER-1044)', () => {
  afterEach(() => setLocale('pt-BR'));

  it('tells whoever hears the row that an automatic run works in it, and on which card', async () => {
    await render(<SessionRow tab={tab({ activity: 'Bash', auto_ref: 'TER-123' })} onPress={jest.fn()} />);
    expect(screen.getByLabelText('api, jarvis, Trabalhando · Bash (automático, TER-123)')).toBeTruthy();
  });

  it('says it in English too', async () => {
    setLocale('en');
    await render(<SessionRow tab={tab({ auto_ref: 'TER-123' })} onPress={jest.fn()} />);
    expect(screen.getByLabelText('api, jarvis, Working (automatic, TER-123)')).toBeTruthy();
  });

  it('a manual tab is heard as before', async () => {
    await render(<SessionRow tab={tab()} onPress={jest.fn()} />);
    expect(screen.getByLabelText('api, jarvis, Trabalhando')).toBeTruthy();
  });
});
