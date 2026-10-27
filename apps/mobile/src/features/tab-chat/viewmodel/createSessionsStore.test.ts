import { ApiError } from '@/services/api/errors';
import { mmkv } from '@/services/storage';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { createSessionsStore } from './createSessionsStore';

async function setup() {
  const ctx = setupSession();
  await enrol(ctx);
  const sessions = createSessionsStore({ api: ctx.api, session: () => ctx.store.getState() });
  return { ...ctx, sessions };
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

it('load() fills the tabs grouped by project, in the order the server sent', async () => {
  const { sessions } = await setup();
  await sessions.getState().load();
  const { groups, loading, loaded, error } = sessions.getState();
  expect(groups.map((g) => [g.project.name, g.tabs.map((t) => t.id)])).toEqual([
    ['termhub', ['t-api', 't-web']],
    ['opapingou', ['t-deploy', 't-codex']],
  ]);
  expect(loading).toBe(false);
  expect(loaded).toBe(true);
  expect(error).toBeNull();
});

it('a project whose tabs come apart in the list still has one group', async () => {
  const { sessions, api, store } = await setup();
  const { tabs } = await api.tabs(store.getState().auth());
  jest.spyOn(api, 'tabs').mockResolvedValueOnce({ tabs: [tabs[0]!, tabs[2]!, tabs[1]!] });
  await sessions.getState().load();
  expect(sessions.getState().groups.map((g) => g.tabs.map((t) => t.id))).toEqual([['t-api', 't-web'], ['t-deploy']]);
});

it('refresh() sets refreshing while it reads', async () => {
  const { sessions } = await setup();
  const pending = sessions.getState().refresh();
  expect(sessions.getState().refreshing).toBe(true);
  await pending;
  expect(sessions.getState().refreshing).toBe(false);
  expect(sessions.getState().groups).toHaveLength(2);
});

it('a failure keeps the previous list and sets error', async () => {
  const { sessions, api } = await setup();
  await sessions.getState().load();
  jest.spyOn(api, 'tabs').mockRejectedValueOnce(new Error('offline'));
  await sessions.getState().load();
  expect(sessions.getState().groups).toHaveLength(2);
  expect(sessions.getState().error).toBe('Não foi possível carregar as sessões.');
});

it('a 403 means the person has no terminal access', async () => {
  const { sessions, api } = await setup();
  jest.spyOn(api, 'tabs').mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Sem permissão'));
  await sessions.getState().load();
  expect(sessions.getState().forbidden).toBe(true);
  expect(sessions.getState().error).toBeNull();
});

describe('starting a session', () => {
  it('start() answers the new tab id', async () => {
    const { sessions, api } = await setup();
    const call = jest.spyOn(api, 'startSession');
    const id = await sessions.getState().start({ project_id: 'p-termhub', prompt: ' revisa o PR ' });
    expect(id).toMatch(/^t-/);
    expect(call).toHaveBeenCalledWith(expect.anything(), { project_id: 'p-termhub', prompt: 'revisa o PR' });
    expect(sessions.getState().starting).toBe(false);
  });

  it("a refusal keeps the server's own words", async () => {
    const { sessions, api } = await setup();
    jest.spyOn(api, 'startSession').mockRejectedValueOnce(new ApiError(409, 'NO_ACCOUNT', 'O projeto não tem conta de IA'));
    expect(await sessions.getState().start({ project_id: 'p-termhub', prompt: 'oi' })).toBeNull();
    expect(sessions.getState().startError).toBe('O projeto não tem conta de IA');
  });

  it('refuses a first message over 4000 characters before the call', async () => {
    const { sessions, api } = await setup();
    const call = jest.spyOn(api, 'startSession');
    expect(await sessions.getState().start({ project_id: 'p-termhub', prompt: 'x'.repeat(4001) })).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(sessions.getState().startError).toBe('Mensagem longa demais (máximo de 4000 caracteres)');
  });

  it("startOptions lists the project's machines with their accounts (TER-1119)", async () => {
    const { sessions } = await setup();
    const machines = await sessions.getState().startOptions('p-termhub');
    expect(machines.map((m) => [m.id, m.online, m.choices.length, m.suggested])).toEqual([
      ['m-jarvis', true, 2, 'acc-claude'],
      ['m-hulk', false, 0, null],
    ]);
    expect(await sessions.getState().startOptions('p-nope')).toEqual([]);
  });

  it('an older server without start-options falls back to the machines of the project\'s accounts', async () => {
    const { sessions, api } = await setup();
    jest.spyOn(api, 'sessionStartOptions').mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Not Found'));
    expect(await sessions.getState().startOptions('p-termhub')).toEqual([
      {
        id: 'm-jarvis',
        name: 'jarvis',
        online: true,
        suggested: null,
        provider: null,
        choices: [
          { account_id: 'acc-1', label: 'Claude Pedro', provider: 'claude', model: null },
          { account_id: 'acc-2', label: 'Claude Trabalho', provider: 'claude', model: null },
          { account_id: 'acc-3', label: 'Codex Pedro', provider: 'chatgpt', model: null },
        ],
      },
    ]);
  });
});
