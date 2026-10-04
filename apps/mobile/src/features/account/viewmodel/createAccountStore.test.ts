// The account store (TER-720), driven over the real `HttpMobileApi` + `MockTransport` with an
// enrolled session, same as the other feature stores' tests: the mock checks the PIN proof for
// `ACCOUNT_DELETION_ACTION_ID` signed `delete_account`, and refuses every other route while pending.
import { ACCOUNT_DELETION_ACTION_ID, ACCOUNT_DELETION_GRACE_DAYS } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { sessionEnded, signal } from '@/features/shared/signals';
import { enrol, PIN, setupSession, START } from '../../../../test/helpers/enrolled-session';
import { createAccountStore } from './createAccountStore';

async function setup() {
  const ctx = setupSession();
  await enrol(ctx);
  const onPending = jest.fn();
  const pendingSignal = signal();
  const account = createAccountStore({ api: ctx.api, session: () => ctx.store.getState(), onPending, pendingSignal });
  return { ...ctx, account, onPending, pendingSignal };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** "Confirmar exclusão", then the PIN typed into the session's PIN sheet. */
async function requestWithPin(ctx: Ctx, pin = PIN): Promise<boolean> {
  const done = ctx.account.getState().requestDeletion();
  await ctx.store.getState().resolvePinPrompt(pin);
  return done;
}

const SCHEDULED = new Date(START + ACCOUNT_DELETION_GRACE_DAYS * 24 * 60 * 60_000).toISOString();

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('asks for the PIN first, then posts a delete_account proof over a decision challenge for the deletion', async () => {
  const ctx = await setup();
  const challenge = jest.spyOn(ctx.api, 'challenge');
  const post = jest.spyOn(ctx.api, 'requestAccountDeletion');

  const done = ctx.account.getState().requestDeletion();
  expect(ctx.account.getState().requesting).toBe(true);
  expect(ctx.store.getState().pinPrompt).toEqual({ actionId: ACCOUNT_DELETION_ACTION_ID, decision: 'delete_account', title: 'Excluir minha conta' });
  expect(challenge).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();

  await ctx.store.getState().resolvePinPrompt(PIN);
  await expect(done).resolves.toBe(true);

  expect(challenge).toHaveBeenCalledWith({ device_id: ctx.store.getState().deviceId, purpose: 'decision', action_id: ACCOUNT_DELETION_ACTION_ID });
  const { challenge: issued } = await challenge.mock.results[0]!.value;
  expect(post).toHaveBeenCalledWith(expect.anything(), { challenge: issued, pin_proof: expect.any(String) });
  // The mock accepted the proof (it checks the `delete_account` word), so the deletion is pending.
  expect(ctx.account.getState()).toMatchObject({ pending: true, scheduledAt: SCHEDULED, requesting: false, error: null });
  expect(ctx.store.getState().pinPrompt).toBeNull();
  expect(ctx.onPending).toHaveBeenCalledTimes(1);
});

it('while pending, other routes answer ACCOUNT_PENDING_DELETION, which the session leaves to this store', async () => {
  const ctx = await setup();
  await requestWithPin(ctx);

  const err = await ctx.api.me(ctx.store.getState().auth()).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 403, code: 'ACCOUNT_PENDING_DELETION' });
  expect(ctx.store.getState().handleApiError(err)).toBe(true);
  // Not an end of session: still unlocked, no error text.
  expect(ctx.store.getState()).toMatchObject({ phase: 'unlocked', error: null });
});

it('"Cancelar exclusão" calls DELETE and brings the account back', async () => {
  const ctx = await setup();
  await requestWithPin(ctx);
  const del = jest.spyOn(ctx.api, 'cancelAccountDeletion');

  await ctx.account.getState().cancelDeletion();

  expect(del).toHaveBeenCalledTimes(1);
  expect(ctx.account.getState()).toMatchObject({ pending: false, scheduledAt: null, cancelling: false, error: null });
  await expect(ctx.api.me(ctx.store.getState().auth())).resolves.toMatchObject({ user: expect.anything() });
});

it('a burst of pending answers shows the blocking state at once and reads the status only once', async () => {
  const ctx = await setup();
  await requestWithPin(ctx);
  ctx.account.setState({ pending: false, scheduledAt: null }); // as on a cold start: the app does not know yet
  ctx.onPending.mockClear();
  const status = jest.spyOn(ctx.api, 'accountDeletion');

  ctx.pendingSignal.emit();
  expect(ctx.account.getState().pending).toBe(true);
  ctx.pendingSignal.emit();
  ctx.pendingSignal.emit();
  await ctx.account.getState().refresh();

  expect(status).toHaveBeenCalledTimes(1);
  expect(ctx.onPending).toHaveBeenCalledTimes(1);
  expect(ctx.account.getState()).toMatchObject({ pending: true, scheduledAt: SCHEDULED });
});

it('closing the PIN sheet requests nothing and shows no error', async () => {
  const ctx = await setup();
  const post = jest.spyOn(ctx.api, 'requestAccountDeletion');

  const done = ctx.account.getState().requestDeletion();
  ctx.store.getState().cancelPinPrompt();

  await expect(done).resolves.toBe(false);
  expect(post).not.toHaveBeenCalled();
  expect(ctx.account.getState()).toMatchObject({ pending: false, requesting: false, error: null });
});

it('a wrong PIN keeps the sheet open with the error; nothing is pending', async () => {
  const ctx = await setup();

  const done = ctx.account.getState().requestDeletion();
  await ctx.store.getState().resolvePinPrompt('000000');

  expect(ctx.store.getState().pinPrompt).not.toBeNull();
  expect(ctx.store.getState().error).toBe('PIN incorreto.');
  expect(ctx.account.getState().pending).toBe(false);

  ctx.store.getState().cancelPinPrompt();
  await expect(done).resolves.toBe(false);
});

it('a refusal (the last admin) closes the sheet and shows the server text', async () => {
  const ctx = await setup();
  jest.spyOn(ctx.api, 'requestAccountDeletion').mockRejectedValue(new ApiError(409, 'LAST_ADMIN', 'Você é o último administrador.'));

  await expect(requestWithPin(ctx)).resolves.toBe(false);

  expect(ctx.store.getState().pinPrompt).toBeNull();
  expect(ctx.account.getState()).toMatchObject({ pending: false, requesting: false, error: 'Você é o último administrador.' });
});

it('the end of the session forgets the pending state', async () => {
  const ctx = await setup();
  await requestWithPin(ctx);

  sessionEnded.emit();

  expect(ctx.account.getState()).toMatchObject({ pending: false, scheduledAt: null });
});
