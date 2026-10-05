import { sessionEnded } from '@/features/shared/signals';
import type { MobileApi } from '@/services/api/types';
import { mmkv } from '@/services/storage';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { createProgressStore, PROGRESS_POLL_MS } from './createProgressStore';

/** `ctx.store` is the session store; the store under test is `progress`. */
async function setup(handleApiError?: (err: unknown) => boolean) {
  const ctx = setupSession();
  await enrol(ctx);
  const session = () => {
    const s = ctx.store.getState();
    return handleApiError ? { auth: () => s.auth(), handleApiError } : s;
  };
  const progress = createProgressStore({ api: ctx.api, session });
  return { ...ctx, progress };
}

beforeEach(() => {
  jest.useFakeTimers();
  mmkv.clearAll();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('load() fills the epics', async () => {
  const { progress } = await setup();
  await progress.getState().load();
  expect(progress.getState().epics[0]!.ref).toBe('TER-182');
  expect(progress.getState().error).toBeNull();
});

it('polls every 20 s while started, and stops', async () => {
  const { progress, api } = await setup();
  const spy = jest.spyOn(api, 'progress');
  progress.getState().startPolling();
  await jest.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
  expect(spy).toHaveBeenCalledTimes(3); // immediate + two ticks
  progress.getState().stopPolling();
  await jest.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
  expect(spy).toHaveBeenCalledTimes(3);
});

it('keeps the last epics and shows an error when a refresh fails', async () => {
  const { progress, api } = await setup();
  await progress.getState().load();
  jest.spyOn(api, 'progress').mockRejectedValueOnce(new Error('offline'));
  await progress.getState().load();
  expect(progress.getState().epics).toHaveLength(1);
  expect(progress.getState().error).toBe('Não foi possível carregar o progresso.');
});

it('leaves session-ending errors to the session store and stops polling', async () => {
  const handled = jest.fn(() => true);
  const { progress, api } = await setup(handled);
  const spy = jest.spyOn(api, 'progress').mockRejectedValue(new Error('revoked'));
  progress.getState().startPolling();
  await jest.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
  expect(handled).toHaveBeenCalled();
  expect(progress.getState().error).toBeNull();
  expect(spy).toHaveBeenCalledTimes(1); // polling stopped after the first refusal
});

type TProgressResponse = Awaited<ReturnType<MobileApi['progress']>>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

it('resets and stops polling on sessionEnded', async () => {
  const { progress, api } = await setup();
  const spy = jest.spyOn(api, 'progress');
  progress.getState().startPolling();
  await jest.advanceTimersByTimeAsync(0);
  expect(progress.getState().epics).toHaveLength(1);

  sessionEnded.emit();

  expect(progress.getState()).toMatchObject({ epics: [], error: null, loading: false, refreshing: false });
  const calls = spy.mock.calls.length;
  await jest.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
  expect(spy).toHaveBeenCalledTimes(calls);
});

it('drops a response that lands after sessionEnded', async () => {
  const { progress, api } = await setup();
  const pending = deferred<TProgressResponse>();
  jest.spyOn(api, 'progress').mockReturnValueOnce(pending.promise);
  const load = progress.getState().load();
  sessionEnded.emit();
  pending.resolve({ epics: [{ id: 'old' } as never], generated_at: '' });
  await load;
  expect(progress.getState().epics).toEqual([]);
});

it('the background poll never shows the pull-to-refresh spinner', async () => {
  const { progress } = await setup();
  const seen: boolean[] = [];
  const unsub = progress.subscribe((s) => seen.push(s.refreshing));
  progress.getState().startPolling();
  await jest.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
  unsub();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((r) => r === false)).toBe(true);
});

it('refresh() shows the spinner while the pull is in flight', async () => {
  const { progress, api } = await setup();
  const pending = deferred<TProgressResponse>();
  jest.spyOn(api, 'progress').mockReturnValueOnce(pending.promise);
  const refresh = progress.getState().refresh();
  expect(progress.getState().refreshing).toBe(true);
  pending.resolve({ epics: [], generated_at: '' });
  await refresh;
  expect(progress.getState().refreshing).toBe(false);
});

it('an older response never overwrites a newer one', async () => {
  const { progress, api } = await setup();
  const older = deferred<TProgressResponse>();
  const newer = deferred<TProgressResponse>();
  jest.spyOn(api, 'progress').mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const first = progress.getState().load();
  const second = progress.getState().load();
  newer.resolve({ epics: [{ id: 'new' } as never], generated_at: '' });
  await second;
  older.resolve({ epics: [{ id: 'old' } as never], generated_at: '' });
  await first;
  expect(progress.getState().epics.map((e) => e.id)).toEqual(['new']);
  expect(progress.getState().loading).toBe(false);
});

it('setAuto() tags a card through the API and shows the badge state', async () => {
  const { progress, api } = await setup();
  await progress.getState().load();
  const card = progress.getState().epics[0]!.cards[0]!;
  expect(card.auto).toBe(false);
  const spy = jest.spyOn(api, 'setCardAuto');
  expect(await progress.getState().setAuto(card.id, true)).toBe(true);
  expect(spy).toHaveBeenCalledWith(expect.anything(), card.id, true);
  expect(progress.getState().epics[0]!.cards[0]!.auto).toBe(true);
  expect(await progress.getState().setAuto(card.id, false)).toBe(true);
  expect(progress.getState().epics[0]!.cards[0]!.auto).toBe(false);
});

it('setAuto() keeps the card as it was and says so when the request fails', async () => {
  const { progress, api } = await setup();
  await progress.getState().load();
  const card = progress.getState().epics[0]!.cards[0]!;
  jest.spyOn(api, 'setCardAuto').mockRejectedValueOnce(new Error('boom'));
  expect(await progress.getState().setAuto(card.id, true)).toBe(false);
  expect(progress.getState().epics[0]!.cards[0]!.auto).toBe(false);
  expect(progress.getState().error).toBe('Não foi possível marcar o card.');
});
