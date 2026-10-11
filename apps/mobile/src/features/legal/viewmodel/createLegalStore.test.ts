// The legal store (TER-742), driven over the real `HttpMobileApi` + `MockTransport` with an enrolled
// session, same as the other feature stores' tests.
import { appForegrounded, sessionEnded, sessionStarted } from '@/features/shared/signals';
import type { TLegalVersion } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { createLegalStore } from './createLegalStore';

const TERMS: TLegalVersion = {
  id: 'v-terms-2',
  document: 'terms',
  version: '2.0',
  effective_at: '2026-10-07T12:00:00.000Z',
  url: 'https://termhub.dev/termos',
  requires_acceptance: true,
  summary: 'Novas regras de uso.',
};
const PRIVACY: TLegalVersion = { ...TERMS, id: 'v-privacy-2', document: 'privacy', url: 'https://termhub.dev/privacidade', summary: null };

async function setup(refreshOnSignals = false) {
  const ctx = setupSession();
  await enrol(ctx);
  const legal = createLegalStore({ api: ctx.api, session: () => ctx.store.getState(), refreshOnSignals });
  return { ...ctx, legal };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('loads the versions still to accept', async () => {
  const ctx = await setup();
  ctx.controls.seedLegalPending([TERMS, PRIVACY]);
  await ctx.legal.getState().load();
  expect(ctx.legal.getState().pending.map((v) => v.id)).toEqual(['v-terms-2', 'v-privacy-2']);
});

it('nothing pending by default', async () => {
  const ctx = await setup();
  await ctx.legal.getState().load();
  expect(ctx.legal.getState().pending).toEqual([]);
});

it('an older server (404) means nothing pending', async () => {
  const ctx = await setup();
  ctx.legal.setState({ pending: [TERMS] });
  jest.spyOn(ctx.api, 'legalStatus').mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Não encontrado'));
  await ctx.legal.getState().load();
  expect(ctx.legal.getState().pending).toEqual([]);
});

it('a network failure never locks anyone out: nothing pending stays nothing pending', async () => {
  const ctx = await setup();
  jest.spyOn(ctx.api, 'legalStatus').mockRejectedValue(new Error('offline'));
  await ctx.legal.getState().load();
  expect(ctx.legal.getState().pending).toEqual([]);
});

it('accept() posts every pending id and clears the list', async () => {
  const ctx = await setup();
  ctx.controls.seedLegalPending([TERMS, PRIVACY]);
  await ctx.legal.getState().load();
  const post = jest.spyOn(ctx.api, 'acceptLegal');

  await expect(ctx.legal.getState().accept()).resolves.toBe(true);
  expect(post).toHaveBeenCalledWith(expect.anything(), ['v-terms-2', 'v-privacy-2']);
  expect(ctx.legal.getState()).toMatchObject({ pending: [], accepting: false, error: null });
});

it('a failed accept keeps the screen with an error', async () => {
  const ctx = await setup();
  ctx.controls.seedLegalPending([TERMS]);
  await ctx.legal.getState().load();
  jest.spyOn(ctx.api, 'acceptLegal').mockRejectedValue(new Error('offline'));

  await expect(ctx.legal.getState().accept()).resolves.toBe(false);
  expect(ctx.legal.getState()).toMatchObject({ pending: [TERMS], accepting: false, error: 'Não foi possível falar com o servidor. Tente de novo.' });
});

it('loads on session start and on foreground', async () => {
  const ctx = await setup(true);
  const get = jest.spyOn(ctx.api, 'legalStatus');
  ctx.controls.seedLegalPending([TERMS]);

  sessionStarted.emit();
  await jest.runOnlyPendingTimersAsync();
  expect(get).toHaveBeenCalledTimes(1);
  expect(ctx.legal.getState().pending).toEqual([TERMS]);

  appForegrounded.emit();
  await jest.runOnlyPendingTimersAsync();
  expect(get).toHaveBeenCalledTimes(2);
});

it('resets when the session ends', async () => {
  const ctx = await setup();
  ctx.controls.seedLegalPending([TERMS]);
  await ctx.legal.getState().load();
  sessionEnded.emit();
  expect(ctx.legal.getState().pending).toEqual([]);
});
