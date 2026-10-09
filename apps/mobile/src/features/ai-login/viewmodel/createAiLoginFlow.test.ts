// One "Refazer login" flow (TER-1047) and the status store, over the real `HttpMobileApi` + `MockTransport`
// with an enrolled session: Claude pastes a code, Codex confirms; closing early cancels on the server.
import { ApiError } from '@/services/api/errors';
import { appForegrounded, sessionEnded } from '@/features/shared/signals';
import { mmkv } from '@/services/storage';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { createAiLoginFlow } from './createAiLoginFlow';
import { createAiLoginStore } from './createAiLoginStore';

async function setup(accountId: string) {
  const ctx = setupSession();
  await enrol(ctx);
  const onLoggedIn = jest.fn();
  const flow = createAiLoginFlow({ api: ctx.api, session: () => ctx.store.getState(), accountId, onLoggedIn });
  return { ...ctx, flow, onLoggedIn };
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

describe('Claude (a code to paste)', () => {
  it('starts, sends the code, ends logged in and resumes the stuck tabs', async () => {
    const { flow, api, controls, onLoggedIn } = await setup('acc-2');
    controls.setAiLoginState('acc-2', 'login_required');
    const submit = jest.spyOn(api, 'submitAiLogin');

    await flow.getState().start();
    expect(flow.getState().phase).toBe('open');
    expect(flow.getState().login).toMatchObject({ needs_code: true, user_code: null, url: expect.stringContaining('claude.com') });

    // An empty paste is never sent.
    await flow.getState().submit('   ');
    expect(submit).not.toHaveBeenCalled();
    expect(flow.getState().phase).toBe('open');

    await flow.getState().submit('  the-code  ');
    expect(submit).toHaveBeenCalledWith(expect.anything(), 'acc-2', 'login-1', 'the-code');
    expect(flow.getState()).toMatchObject({ phase: 'done', login: null, resume: 'ask', stuckTabs: [{ id: 't-api', name: 'api', project_id: 'p-termhub' }] });
    expect(onLoggedIn).toHaveBeenCalledWith('acc-2');

    const resume = jest.spyOn(api, 'resumeAiLoginTabs');
    await flow.getState().resumeTabs();
    expect(resume).toHaveBeenCalledWith(expect.anything(), 'acc-2', ['t-api']);
    expect(flow.getState()).toMatchObject({ resume: 'resumed', resumed: 1 });
  });

  it('the CLI finished on the machine before any link: done at once, with the stuck tabs (TER-1054)', async () => {
    const { flow, api, controls, onLoggedIn } = await setup('acc-2');
    controls.setAiLoginState('acc-2', 'login_required');
    controls.finishAiLoginOnMachine('acc-2');
    const submit = jest.spyOn(api, 'submitAiLogin');
    const cancel = jest.spyOn(api, 'cancelAiLogin');
    await flow.getState().start();
    expect(flow.getState()).toMatchObject({ phase: 'done', login: null, resume: 'ask', stuckTabs: [{ id: 't-api' }] });
    expect(onLoggedIn).toHaveBeenCalledWith('acc-2');
    flow.getState().close();
    expect(submit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('"Já entrei pelo navegador da máquina": a Claude submit without a code', async () => {
    const { flow, api } = await setup('acc-2');
    const submit = jest.spyOn(api, 'submitAiLogin');
    await flow.getState().start();
    await flow.getState().submit(null);
    expect(submit).toHaveBeenCalledWith(expect.anything(), 'acc-2', 'login-1', null);
    expect(flow.getState().phase).toBe('done');
  });

  it('a refused code ends the flow: failed with the reason, and "Tentar de novo" starts a new one', async () => {
    const { flow, api } = await setup('acc-1');
    await flow.getState().start();
    await flow.getState().submit('errado');
    expect(flow.getState()).toMatchObject({ phase: 'failed', login: null, error: 'O login não foi confirmado.', detail: 'OAuth error: invalid_grant' });

    const start = jest.spyOn(api, 'startAiLogin');
    await flow.getState().start();
    expect(start).toHaveBeenCalledTimes(1);
    expect(flow.getState()).toMatchObject({ phase: 'open', error: null, login: { login_id: 'login-2' } });
  });

  it('nothing stuck: done without asking; "Agora não" skips the resume', async () => {
    const { flow } = await setup('acc-1');
    await flow.getState().start();
    await flow.getState().submit('ok');
    expect(flow.getState()).toMatchObject({ phase: 'done', resume: 'none', stuckTabs: [] });

    flow.setState({ resume: 'ask', stuckTabs: [{ id: 't-api', name: 'api', project_id: 'p-termhub' }] });
    flow.getState().skipResume();
    expect(flow.getState().resume).toBe('skipped');
  });
});

describe('Codex (device code, no paste)', () => {
  it('shows the device code; "Já autorizei" sends no code', async () => {
    const { flow, api } = await setup('acc-3');
    const submit = jest.spyOn(api, 'submitAiLogin');
    await flow.getState().start();
    expect(flow.getState().login).toMatchObject({ needs_code: false, user_code: 'ABCD-EFGH1' });
    await flow.getState().submit(null);
    expect(submit).toHaveBeenCalledWith(expect.anything(), 'acc-3', 'login-1', null);
    expect(flow.getState().phase).toBe('done');
  });

  it('not authorized yet: back to the page with the reason, and may confirm again', async () => {
    const { flow, api } = await setup('acc-3');
    await flow.getState().start();
    const submit = jest.spyOn(api, 'submitAiLogin').mockResolvedValueOnce({ ok: false, message: 'Ainda não autorizado.', stuck_tabs: [] });
    await flow.getState().submit(null);
    expect(flow.getState()).toMatchObject({ phase: 'open', error: 'Ainda não autorizado.', login: { login_id: 'login-1' } });
    submit.mockRestore();
    await flow.getState().submit(null);
    expect(flow.getState()).toMatchObject({ phase: 'done', error: null });
  });
});

describe('errors and leaving', () => {
  it('a start the server refuses shows its own sentence', async () => {
    const { flow, api } = await setup('acc-1');
    jest.spyOn(api, 'startAiLogin').mockRejectedValueOnce(new ApiError(409, 'AGENT_OUTDATED', 'Atualize o agente desta máquina.'));
    await flow.getState().start();
    expect(flow.getState()).toMatchObject({ phase: 'failed', error: 'Atualize o agente desta máquina.' });
  });

  it('closing an open flow cancels it on the server, once; a done flow is not cancelled', async () => {
    const { flow, api } = await setup('acc-1');
    const cancel = jest.spyOn(api, 'cancelAiLogin');
    await flow.getState().start();
    flow.getState().close();
    flow.getState().close();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(expect.anything(), 'acc-1', 'login-1');

    const second = await setup('acc-1');
    const cancel2 = jest.spyOn(second.api, 'cancelAiLogin');
    await second.flow.getState().start();
    await second.flow.getState().submit('ok');
    second.flow.getState().close();
    expect(cancel2).not.toHaveBeenCalled();
  });

  it('closing while the machine opens the login cancels it once it answers', async () => {
    const { flow, api } = await setup('acc-1');
    const cancel = jest.spyOn(api, 'cancelAiLogin');
    const starting = flow.getState().start();
    flow.getState().close();
    await starting;
    expect(cancel).toHaveBeenCalledWith(expect.anything(), 'acc-1', 'login-1');
    expect(flow.getState().phase).toBe('starting');
  });
});

describe('status store', () => {
  it('lists the accounts, drops a banner on markOk, reloads on foreground and resets when the session ends', async () => {
    const ctx = setupSession();
    await enrol(ctx);
    ctx.controls.setAiLoginState('acc-3', 'login_required');
    const store = createAiLoginStore({ api: ctx.api, session: () => ctx.store.getState(), refreshOnForeground: true });
    await store.getState().load();
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().accounts.find((a) => a.account_id === 'acc-3')?.state).toBe('login_required');

    store.getState().markOk('acc-3');
    expect(store.getState().accounts.find((a) => a.account_id === 'acc-3')?.state).toBe('ok');

    const status = jest.spyOn(ctx.api, 'aiLoginStatus');
    appForegrounded.emit();
    expect(status).toHaveBeenCalledTimes(1);

    sessionEnded.emit();
    expect(store.getState()).toMatchObject({ accounts: [], loaded: false });
  });
});
