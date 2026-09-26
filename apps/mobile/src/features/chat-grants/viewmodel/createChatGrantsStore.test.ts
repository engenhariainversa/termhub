// The "Abas confiáveis" store over a hand-made `api` fake: only `listGrants` and `revokeGrant`
// matter here, and the fake lets a test hold a revoke in flight.
import { ApiError } from '@/services/api/errors';
import { createChatGrantsStore } from './createChatGrantsStore';

const item = (id: string, state: 'active' | 'expired' = 'active') => ({
  id,
  tab_id: 't1',
  tool: 'send_input',
  source_action_id: null,
  created_at: '2026-09-25T10:00:00.000Z',
  expires_at: '2099-01-01T00:00:00.000Z',
  tab_name: 'api',
  project_id: null,
  project_name: null,
  conversation_id: 'c1',
  conversation_project_name: null,
  conversation_archived: false,
  state,
  ended_at: state === 'active' ? null : '2026-09-25T11:00:00.000Z',
});

function setup(listGrants: jest.Mock, revokeGrant: jest.Mock = jest.fn(async () => undefined)) {
  const api = { listGrants, revokeGrant } as never;
  const session = () => ({ auth: () => ({ accessToken: 'tok' }), handleApiError: () => false });
  return { store: createChatGrantsStore({ api, session }), listGrants, revokeGrant };
}

it('load reads active and the first history page', async () => {
  const { store } = setup(
    jest.fn(async (_a: unknown, q: { state: string }) =>
      q.state === 'active' ? { grants: [item('g1')], next_cursor: null } : { grants: [item('g2', 'expired')], next_cursor: 'g2' }
    )
  );
  await store.getState().load();
  expect(store.getState()).toMatchObject({ active: [{ id: 'g1' }], history: [{ id: 'g2' }], next: 'g2', loading: false, error: null });
});

it('loadMore appends with the cursor and stops at the end', async () => {
  const listGrants = jest.fn(async (_a: unknown, q: { state: string; cursor?: string }) =>
    q.state === 'active'
      ? { grants: [], next_cursor: null }
      : q.cursor
        ? { grants: [item('g3', 'expired')], next_cursor: null }
        : { grants: [item('g2', 'expired')], next_cursor: 'g2' }
  );
  const { store } = setup(listGrants);
  await store.getState().load();
  await store.getState().loadMore();
  expect(listGrants).toHaveBeenLastCalledWith(expect.anything(), { state: 'ended', cursor: 'g2' });
  expect(store.getState().history!.map((g) => g.id)).toEqual(['g2', 'g3']);
  expect(store.getState().next).toBeNull();
});

it('revoke needs no PIN, treats 409 as done, reloads, and ignores a second tap while busy', async () => {
  let release!: () => void;
  const revokeGrant = jest.fn(
    () =>
      new Promise<void>((_res, rej) => {
        release = () => rej(new ApiError(409, 'CONFLICT', 'Esta permissão já foi revogada'));
      })
  );
  const listGrants = jest.fn(async () => ({ grants: [], next_cursor: null }));
  const { store } = setup(listGrants, revokeGrant);
  const first = store.getState().revoke('g1');
  void store.getState().revoke('g1');
  expect(revokeGrant).toHaveBeenCalledTimes(1);
  release();
  await first;
  expect(store.getState()).toMatchObject({ revokingId: null, error: null });
  expect(listGrants).toHaveBeenCalledTimes(2);
});

it('a failed revoke shows the error and frees the button', async () => {
  const revokeGrant = jest.fn(async () => {
    throw new ApiError(500, 'INTERNAL', 'Erro do servidor (500)');
  });
  const listGrants = jest.fn(async () => ({ grants: [], next_cursor: null }));
  const { store } = setup(listGrants, revokeGrant);
  await store.getState().revoke('g1');
  expect(store.getState()).toMatchObject({ revokingId: null, error: 'Erro do servidor (500)' });
  expect(listGrants).not.toHaveBeenCalled();
});
