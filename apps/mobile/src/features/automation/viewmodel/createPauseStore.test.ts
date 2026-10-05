import type { TChatEvent, TPauseState } from '@/services/api/contract';
import type { MobileApi } from '@/services/api/types';
import { createPauseStore } from './createPauseStore';

const state = (over: Partial<TPauseState> = {}): TPauseState => ({ paused_at: null, projects: [], has_automation: true, can_update: true, ...over });

function build(read: () => Promise<TPauseState>) {
  const getPauseState = jest.fn(read);
  let emit: (e: TChatEvent) => void = () => undefined;
  const store = createPauseStore({
    api: { getPauseState } as unknown as MobileApi,
    session: () => ({ auth: () => ({ accessToken: 't' }) as never, handleApiError: () => false }),
    events: { subscribe: (fn) => ((emit = fn), () => undefined) },
  });
  return { store, getPauseState, emit: (e: unknown) => emit(e as TChatEvent) };
}

describe('pause store', () => {
  afterEach(() => jest.useRealTimers());

  it('re-reads on an automation frame once it has read the state, not before', async () => {
    const t = build(async () => state());
    t.emit({ type: 'automation' });
    expect(t.getPauseState).not.toHaveBeenCalled();
    await t.store.getState().load();
    t.emit({ type: 'automation' });
    expect(t.getPauseState).toHaveBeenCalledTimes(2);
  });

  it('polls only slowly, and only while the controls are visible', async () => {
    jest.useFakeTimers();
    const hidden = build(async () => state({ has_automation: false }));
    hidden.store.getState().startPolling();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(hidden.getPauseState).toHaveBeenCalledTimes(1);
    hidden.store.getState().stopPolling();

    const shown = build(async () => state());
    shown.store.getState().startPolling();
    await jest.advanceTimersByTimeAsync(4_000 * 5);
    expect(shown.getPauseState).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(shown.getPauseState).toHaveBeenCalledTimes(2);
    shown.store.getState().stopPolling();
  });
});
