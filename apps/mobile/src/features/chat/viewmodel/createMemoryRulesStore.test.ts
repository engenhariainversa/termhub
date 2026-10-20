// "Regras vigentes" store (TER-1010): driven over the real `HttpMobileApi` + `MockTransport` with an
// enrolled session, same setup as `createChatMemoryStore.test.ts`. The mock seeds two proposals
// (`fixtures.ts`): the user-level rule `r-worktree` and the policy `r-autonomy`.
import { sessionEnded } from '@/features/shared/signals';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { createMemoryRulesStore } from './createMemoryRulesStore';

async function setup() {
  const ctx = setupSession();
  await enrol(ctx);
  const store = createMemoryRulesStore({ api: ctx.api, session: () => ctx.store.getState() });
  return { ...ctx, store };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('load() reads the approved rules and the proposals', async () => {
  const { store } = await setup();
  expect(store.getState().rules).toBeNull();

  await store.getState().load();

  expect(store.getState().rules).toEqual([]);
  expect(store.getState().proposals?.map((r) => r.id)).toEqual(['r-worktree', 'r-autonomy']);
  expect(store.getState().error).toBeNull();
});

it('approve() on a rule approves it and reloads: it moves from the proposals to the rules', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const spy = jest.spyOn(api, 'approveChatRule');

  await store.getState().approve('r-worktree');

  expect(spy).toHaveBeenCalledWith(expect.anything(), 'r-worktree');
  expect(store.getState().rules?.map((r) => r.id)).toEqual(['r-worktree']);
  expect(store.getState().proposals?.map((r) => r.id)).toEqual(['r-autonomy']);
  expect(store.getState().busyId).toBeNull();
  expect(store.getState().notice).toBeNull();
});

it('approve() on a policy leaves it waiting for the chat and says so', async () => {
  const { store } = await setup();
  await store.getState().load();

  await store.getState().approve('r-autonomy');

  expect(store.getState().proposals?.find((r) => r.id === 'r-autonomy')?.status).toBe('awaiting_confirmation');
  expect(store.getState().rules).toEqual([]);
  expect(store.getState().notice).toBe('Confirme cada projeto no chat para a política mudar.');
});

it('reject() drops the proposal and shows the 180-day note', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const spy = jest.spyOn(api, 'rejectChatRule');

  await store.getState().reject('r-worktree');

  expect(spy).toHaveBeenCalledWith(expect.anything(), 'r-worktree');
  expect(store.getState().proposals?.map((r) => r.id)).toEqual(['r-autonomy']);
  expect(store.getState().rules).toEqual([]);
  expect(store.getState().notice).toBe('Recusada, ela não volta por 180 dias.');
});

it('remove() deletes an approved rule and reloads', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  await store.getState().approve('r-worktree');
  const spy = jest.spyOn(api, 'removeChatRule');

  await store.getState().remove('r-worktree');

  expect(spy).toHaveBeenCalledWith(expect.anything(), 'r-worktree');
  expect(store.getState().rules).toEqual([]);
});

it('a proposal already decided shows the server error and the current list', async () => {
  const { store } = await setup();
  await store.getState().load();
  await store.getState().reject('r-worktree');

  await store.getState().approve('r-worktree');

  expect(store.getState().error).toBe('Esta proposta já foi decidida');
  expect(store.getState().notice).toBeNull();
  expect(store.getState().busyId).toBeNull();
  expect(store.getState().proposals?.map((r) => r.id)).toEqual(['r-autonomy']);
});

it('a failed decision falls back to "Não foi possível salvar a decisão"', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  jest.spyOn(api, 'rejectChatRule').mockRejectedValueOnce(new Error('boom'));

  await store.getState().reject('r-worktree');

  expect(store.getState().error).toBe('Não foi possível salvar a decisão');
  expect(store.getState().proposals?.map((r) => r.id)).toEqual(['r-worktree', 'r-autonomy']);
});

it('a failed first read stops "Carregando…" with an empty list and the error line', async () => {
  const { store, api } = await setup();
  jest.spyOn(api, 'chatRules').mockRejectedValueOnce(new Error('boom'));

  await store.getState().load();

  expect(store.getState()).toMatchObject({ rules: [], proposals: [], error: 'Não foi possível carregar as regras' });
});

it('ignores a second decision while one is in flight', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const spy = jest.spyOn(api, 'rejectChatRule');

  const first = store.getState().approve('r-worktree');
  await store.getState().reject('r-autonomy');
  await first;

  expect(spy).not.toHaveBeenCalled();
});

it('resets on sessionEnded', async () => {
  const { store } = await setup();
  await store.getState().load();
  expect(store.getState().proposals).not.toBeNull();

  sessionEnded.emit();

  expect(store.getState()).toMatchObject({ rules: null, proposals: null, busyId: null, error: null, notice: null });
});
