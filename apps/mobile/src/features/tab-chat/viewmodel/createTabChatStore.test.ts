// The session store (spec 2026-10-01 tab chat §6) over the real client, the mock transport and its
// fake tab socket, with an enrolled, unlocked session store built over the same mock.
import type { TChatEvent, TTabChatPage, TTabQuestion, TTabSuggestion } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { mmkv } from '@/services/storage';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { createTabChatStore } from './createTabChatStore';

type Store = ReturnType<typeof createTabChatStore>;
const opened: Store[] = [];

async function setup(tabId = 't-api') {
  const ctx = setupSession();
  await enrol(ctx);
  const tabEvents = jest.spyOn(ctx.api, 'tabEvents');
  const chat = createTabChatStore({ api: ctx.api, session: () => ctx.store.getState(), tabId });
  opened.push(chat);
  return { ...ctx, chat, tabEvents };
}

/** Opens the store and lets the fake socket say hello (it answers on a 0 ms timer). */
async function openAndConnect(chat: Store) {
  await chat.getState().open();
  await jest.advanceTimersByTimeAsync(0);
}

const at = '2026-10-01T10:00:00.000Z';
const ids = (chat: Store) => chat.getState().items.map((i) => i.id);

const question = (id: string, tabId: string): TTabQuestion => ({
  id,
  tab_id: tabId,
  tab_name: 'api',
  status: 'open',
  error_code: null,
  created_at: at,
  answered_at: null,
  closed_at: null,
  kind: 'permission',
  payload: { tool_name: 'Bash' },
  answer: null,
});
const suggestion = (id: string, tabId: string): TTabSuggestion => ({
  id,
  tab_id: tabId,
  tab_name: 'api',
  kind: 'suggestion',
  payload: { text: 'rode os testes' },
  status: 'open',
  answer: null,
  error_code: null,
  created_at: at,
  answered_at: null,
  closed_at: null,
});

beforeEach(() => {
  jest.useFakeTimers();
  mmkv.clearAll();
});

afterEach(() => {
  while (opened.length) opened.pop()!.getState().close();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('open', () => {
  it('loads the first page, then opens the socket from its live cursor', async () => {
    const { chat, tabEvents } = await setup();
    await openAndConnect(chat);
    const s = chat.getState();
    expect(s.status).toBe('ready');
    expect(s.tab?.name).toBe('api');
    expect(s.availability).toBe('ready');
    expect(s.items.length).toBeGreaterThan(0);
    expect(s.before).not.toBeNull();
    expect(s.mode).toBe('default');
    expect(tabEvents).toHaveBeenCalledTimes(1);
    expect(tabEvents.mock.calls[0]![1]).toBe('t-api');
    expect(tabEvents.mock.calls[0]![2].after()).toBe(s.live);
  });

  it('a failed first page says so and opens no socket', async () => {
    const { chat, api, tabEvents } = await setup();
    jest.spyOn(api, 'tabChat').mockRejectedValueOnce(new Error('offline'));
    await chat.getState().open();
    expect(chat.getState().status).toBe('error');
    expect(chat.getState().error).toBe('Não foi possível abrir a sessão.');
    expect(tabEvents).not.toHaveBeenCalled();
  });

  it('a tab outside the scope reads as not found', async () => {
    const { chat } = await setup('t-nope');
    await chat.getState().open();
    expect(chat.getState().status).toBe('error');
    expect(chat.getState().error).toBe('Aba não encontrada.');
  });
});

describe('frames', () => {
  it('items append, merged by id, and move live and mode', async () => {
    const { chat, controls } = await setup();
    await openAndConnect(chat);
    const before = ids(chat);
    const last = before[before.length - 1]!;
    controls.tabFrame('t-api', { type: 'items', items: [{ kind: 'tool', id: last, at, name: 'Read', summary: 'src/b.ts' }, { kind: 'assistant', id: 'new-1', at, text: 'pronto' }], live: 's-api.99', mode: 'plan' });
    expect(ids(chat)).toEqual([...before, 'new-1']);
    expect(chat.getState().items.find((i) => i.id === last)).toMatchObject({ summary: 'src/b.ts' });
    expect(chat.getState().live).toBe('s-api.99');
    expect(chat.getState().mode).toBe('plan');
  });

  it('an items frame with no mode keeps the mode', async () => {
    const { chat, controls } = await setup();
    await openAndConnect(chat);
    controls.tabFrame('t-api', { type: 'items', items: [], live: 's-api.50', mode: null });
    expect(chat.getState().mode).toBe('default');
  });

  it('a state frame replaces the tab', async () => {
    const { chat, controls } = await setup();
    await openAndConnect(chat);
    const tab = { ...chat.getState().tab!, state: 'idle' as const, activity: null };
    controls.tabFrame('t-api', { type: 'state', tab });
    expect(chat.getState().tab).toEqual(tab);
  });

  it('a state frame where the tab starts or stops needing the person re-reads the cards', async () => {
    const { chat, controls, api } = await setup();
    await openAndConnect(chat);
    const read = jest.spyOn(api, 'tabChat');
    controls.tabFrame('t-api', { type: 'state', tab: { ...chat.getState().tab!, state: 'idle' } });
    await jest.advanceTimersByTimeAsync(0);
    expect(read).not.toHaveBeenCalled();
    controls.tabFrame('t-api', { type: 'state', tab: { ...chat.getState().tab!, state: 'waiting_permission', needs_you: true } });
    await jest.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reset empties the items and loads the first page again; frames during the load land after it', async () => {
    const { chat, controls, api, store } = await setup();
    await openAndConnect(chat);
    let release: () => void = () => undefined;
    const real = api.tabChat.bind(api);
    const fresh: TTabChatPage = { ...(await real(store.getState().auth(), 't-api')), session_id: 's-new', items: [{ kind: 'user', id: 'n1', at, text: '/clear', images: 0 }], before: null, live: 's-new.1' };
    jest.spyOn(api, 'tabChat').mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(fresh))));
    controls.tabFrame('t-api', { type: 'reset', session_id: 's-new' });
    expect(chat.getState().items).toEqual([]);
    expect(chat.getState().before).toBeNull();
    controls.tabFrame('t-api', { type: 'items', items: [{ kind: 'assistant', id: 'n2', at, text: 'oi' }], live: 's-new.2', mode: null });
    expect(chat.getState().items).toEqual([]);
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(ids(chat)).toEqual(['n1', 'n2']);
    expect(chat.getState().live).toBe('s-new.2');
  });

  it('unavailable sets the availability and keeps the items', async () => {
    const { chat, controls } = await setup();
    await openAndConnect(chat);
    const before = ids(chat);
    controls.tabFrame('t-api', { type: 'unavailable', availability: 'offline' });
    expect(chat.getState().availability).toBe('offline');
    expect(ids(chat)).toEqual(before);
  });

  it('a reconnect asks from the last live cursor the store saw, so nothing is missed or doubled', async () => {
    const { chat, controls } = await setup();
    await openAndConnect(chat);
    controls.appendTabItems('t-api', [{ kind: 'assistant', id: 'x1', at, text: 'um' }]);
    controls.dropTabSockets();
    // Written while the phone was away: the reconnect catches up on it from `live`.
    controls.appendTabItems('t-api', [{ kind: 'assistant', id: 'x2', at, text: 'dois' }]);
    await jest.advanceTimersByTimeAsync(2000); // the first backoff step (1 s), then the connect tick
    const all = ids(chat);
    expect(all.filter((id) => id === 'x1')).toHaveLength(1);
    expect(all.slice(-2)).toEqual(['x1', 'x2']);
  });
});

/** `t-api`'s page as a tab that has not reported a session yet (TER-1091). */
async function noSessionPage(ctx: Awaited<ReturnType<typeof setup>>, emptyReason = 'no_hooks'): Promise<TTabChatPage> {
  const real = await ctx.api.tabChat(ctx.store.getState().auth(), 't-api');
  return { ...real, tab: { ...real.tab, availability: 'no_session' }, session_id: null, items: [], before: null, live: null, mode: null, empty_reason: emptyReason };
}

describe('an empty conversation (TER-1091)', () => {
  it('keeps why it is empty from the page', async () => {
    const ctx = await setup();
    const empty = await noSessionPage(ctx);
    jest.spyOn(ctx.api, 'tabChat').mockResolvedValueOnce(empty);
    await ctx.chat.getState().open();
    expect(ctx.chat.getState().emptyReason).toBe('no_hooks');
  });

  it('a hello that says ready to a page that had no session loads the page again, history included', async () => {
    const ctx = await setup();
    const empty = await noSessionPage(ctx, 'not_reported');
    const read = jest.spyOn(ctx.api, 'tabChat').mockResolvedValueOnce(empty);
    await ctx.chat.getState().open();
    expect(ctx.chat.getState().items).toEqual([]);
    await jest.advanceTimersByTimeAsync(0); // the socket's hello: the session was reported meanwhile
    expect(read).toHaveBeenCalledTimes(2);
    expect(ctx.chat.getState().items.length).toBeGreaterThan(0);
    expect(ctx.chat.getState().live).not.toBeNull();
    expect(ctx.chat.getState().emptyReason).toBeNull();
  });

  it('a state frame turning the tab readable while nothing was followed loads the page again', async () => {
    const ctx = await setup();
    const empty = await noSessionPage(ctx, 'not_reported');
    const read = jest.spyOn(ctx.api, 'tabChat').mockResolvedValueOnce(empty).mockResolvedValueOnce(empty);
    await openAndConnect(ctx.chat);
    expect(ctx.chat.getState().items).toEqual([]);
    ctx.controls.tabFrame('t-api', { type: 'state', tab: { ...ctx.chat.getState().tab!, availability: 'ready' } });
    await jest.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(3);
    expect(ctx.chat.getState().items.length).toBeGreaterThan(0);
  });

  it('a state frame of a tab already followed never re-reads the page', async () => {
    const ctx = await setup();
    await openAndConnect(ctx.chat);
    ctx.controls.tabFrame('t-api', { type: 'unavailable', availability: 'offline' });
    const read = jest.spyOn(ctx.api, 'tabChat');
    ctx.controls.tabFrame('t-api', { type: 'state', tab: { ...ctx.chat.getState().tab!, availability: 'ready' } });
    await jest.advanceTimersByTimeAsync(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('"Instalar hooks" installs on the tab\'s machine, then reads the page again', async () => {
    const ctx = await setup();
    // the first page, the hello's re-read (the mock's socket says ready), then the one after the install
    const [noHooks, notReported] = [await noSessionPage(ctx), await noSessionPage(ctx, 'not_reported')];
    jest.spyOn(ctx.api, 'tabChat').mockResolvedValueOnce(noHooks).mockResolvedValueOnce(noHooks).mockResolvedValueOnce(notReported);
    const install = jest.spyOn(ctx.api, 'installMachineHooks');
    await openAndConnect(ctx.chat);
    expect(ctx.chat.getState().emptyReason).toBe('no_hooks');
    await ctx.chat.getState().installHooks();
    expect(install).toHaveBeenCalledWith(expect.anything(), 'm-jarvis');
    expect(ctx.chat.getState()).toMatchObject({ hooksInstalled: true, installingHooks: false, emptyReason: 'not_reported', error: null });
  });

  it('a refused install says why, and nothing is marked installed', async () => {
    const ctx = await setup();
    jest.spyOn(ctx.api, 'installMachineHooks').mockRejectedValueOnce(new ApiError(503, 'AGENT_OFFLINE', 'Máquina offline'));
    await openAndConnect(ctx.chat);
    await ctx.chat.getState().installHooks();
    expect(ctx.chat.getState()).toMatchObject({ hooksInstalled: false, installingHooks: false, error: 'Máquina offline' });
    jest.spyOn(ctx.api, 'installMachineHooks').mockRejectedValueOnce(new Error('network'));
    await ctx.chat.getState().installHooks();
    expect(ctx.chat.getState().error).toBe('Não foi possível instalar os hooks. Tente de novo.');
  });
});

describe('a plain shell (TER-1094)', () => {
  const options = { choices: [{ account_id: 'acc-claude', label: 'Pessoal', provider: 'claude', model: null }, { account_id: 'acc-codex', label: 'Trabalho', provider: 'chatgpt', model: null }], suggested: 'acc-claude' };

  it('loads the accounts an agent can start with only when the page says no_agent', async () => {
    const ctx = await setup();
    const read = jest.spyOn(ctx.api, 'tabAgentOptions');
    await ctx.chat.getState().open();
    expect(read).not.toHaveBeenCalled();
    expect(ctx.chat.getState().agentOptions).toBeNull();

    const other = await setup();
    const empty = await noSessionPage(other, 'no_agent');
    jest.spyOn(other.api, 'tabChat').mockResolvedValueOnce(empty);
    const readOther = jest.spyOn(other.api, 'tabAgentOptions').mockResolvedValueOnce(options);
    await other.chat.getState().open();
    await jest.advanceTimersByTimeAsync(0);
    expect(readOther).toHaveBeenCalledWith(expect.anything(), 't-api');
    expect(other.chat.getState()).toMatchObject({ agentOptions: options, agentOptionsError: null });
  });

  it('accounts that cannot be read say so', async () => {
    const ctx = await setup();
    jest.spyOn(ctx.api, 'tabChat').mockResolvedValueOnce(await noSessionPage(ctx, 'no_agent'));
    jest.spyOn(ctx.api, 'tabAgentOptions').mockRejectedValueOnce(new Error('network'));
    await ctx.chat.getState().open();
    await jest.advanceTimersByTimeAsync(0);
    expect(ctx.chat.getState()).toMatchObject({ agentOptions: null, agentOptionsError: 'Não foi possível carregar as contas de IA.' });
  });

  it('"Iniciar sessão" with the suggested account sends none, then reads the page again and says what comes next', async () => {
    const ctx = await setup();
    jest.spyOn(ctx.api, 'tabChat').mockResolvedValueOnce(await noSessionPage(ctx, 'no_agent'));
    const start = jest.spyOn(ctx.api, 'startTabAgent').mockResolvedValueOnce({ tab_id: 't-api', new_tab: false, account: { id: 'acc-claude', label: 'Pessoal' }, provider: 'claude' });
    await openAndConnect(ctx.chat);
    const read = jest.spyOn(ctx.api, 'tabChat');
    read.mockClear(); // the same spy as above: only the reads from here on
    await expect(ctx.chat.getState().startAgent()).resolves.toBeNull();
    expect(start).toHaveBeenCalledWith(expect.anything(), 't-api', {});
    expect(read).toHaveBeenCalledTimes(1);
    expect(ctx.chat.getState()).toMatchObject({ agentStarted: true, startingAgent: false, startAgentError: null });
  });

  it('a chosen account and session model go with the call', async () => {
    const ctx = await setup();
    const start = jest.spyOn(ctx.api, 'startTabAgent').mockResolvedValueOnce({ tab_id: 't-api', new_tab: false, account: { id: 'acc-codex', label: 'Trabalho' }, provider: 'chatgpt' });
    await ctx.chat.getState().open();
    await ctx.chat.getState().startAgent('acc-codex', 'gpt-test-codex');
    expect(start).toHaveBeenCalledWith(expect.anything(), 't-api', { account_id: 'acc-codex', model: 'gpt-test-codex' });
  });

  it('an agent started in a new tab answers its id, and this screen reads nothing again', async () => {
    const ctx = await setup();
    jest.spyOn(ctx.api, 'startTabAgent').mockResolvedValueOnce({ tab_id: 't-new', new_tab: true, account: { id: 'acc-claude', label: 'Pessoal' }, provider: 'claude' });
    await ctx.chat.getState().open();
    const read = jest.spyOn(ctx.api, 'tabChat');
    await expect(ctx.chat.getState().startAgent()).resolves.toBe('t-new');
    expect(read).not.toHaveBeenCalled();
    expect(ctx.chat.getState().agentStarted).toBe(false);
  });

  it('a refused start keeps the server\'s message; a network failure the generic one', async () => {
    const ctx = await setup();
    await ctx.chat.getState().open();
    jest.spyOn(ctx.api, 'startTabAgent').mockRejectedValueOnce(new ApiError(409, 'ACCOUNT_CHOICE_REQUIRED', 'Escolha a conta'));
    const reread = jest.spyOn(ctx.api, 'tabAgentOptions').mockResolvedValueOnce(options);
    await expect(ctx.chat.getState().startAgent()).resolves.toBeNull();
    expect(ctx.chat.getState()).toMatchObject({ startAgentError: 'Escolha a conta', startingAgent: false, agentStarted: false });
    expect(reread).toHaveBeenCalledTimes(1);
    jest.spyOn(ctx.api, 'startTabAgent').mockRejectedValueOnce(new Error('network'));
    await ctx.chat.getState().startAgent();
    expect(ctx.chat.getState().startAgentError).toBe('Não foi possível iniciar o agente. Tente de novo.');
  });
});

describe('loadEarlier', () => {
  it('prepends the page before, once per page', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat);
    const first = ids(chat);
    const read = jest.spyOn(api, 'tabChat');
    const a = chat.getState().loadEarlier();
    const b = chat.getState().loadEarlier();
    await Promise.all([a, b]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(ids(chat).slice(-first.length)).toEqual(first);
    expect(ids(chat).length).toBeGreaterThan(first.length);
  });

  it('does nothing once at the start of the session', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat);
    chat.setState({ before: null });
    const read = jest.spyOn(api, 'tabChat');
    await chat.getState().loadEarlier();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('send', () => {
  it('types the text into the tab', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat);
    const sent = jest.spyOn(api, 'sendTabMessage');
    expect(await chat.getState().send('  faz o deploy ')).toBe(true);
    expect(sent).toHaveBeenCalledWith(expect.anything(), 't-api', 'faz o deploy');
    expect(chat.getState().sending).toBe(false);
  });

  it('a tab waiting on a permission refuses it with the line, and the text stays for the composer', async () => {
    const { chat } = await setup('t-deploy');
    await openAndConnect(chat);
    expect(await chat.getState().send('oi')).toBe(false);
    expect(chat.getState().error).toBe('Responda a pergunta acima antes de enviar uma mensagem');
  });

  it('any other failure says to try again', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat);
    jest.spyOn(api, 'sendTabMessage').mockRejectedValueOnce(new ApiError(500, 'HTTP_500', 'x'));
    expect(await chat.getState().send('oi')).toBe(false);
    expect(chat.getState().error).toBe('Não foi possível enviar. Tente de novo.');
  });

  it('refuses a text over 4000 characters before the call', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat);
    const sent = jest.spyOn(api, 'sendTabMessage');
    expect(await chat.getState().send('x'.repeat(4001))).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    expect(chat.getState().error).toBe('Mensagem longa demais (máximo de 4000 caracteres)');
  });
});

describe('act', () => {
  it('cycle_mode takes the mode the server read', async () => {
    const { chat } = await setup();
    await openAndConnect(chat);
    await chat.getState().act('cycle_mode');
    expect(chat.getState().mode).toBe('acceptEdits');
  });

  it('an unknown mode is never applied', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat);
    jest.spyOn(api, 'tabAction').mockResolvedValueOnce({ done: true, mode: 'unknown' });
    await chat.getState().act('cycle_mode');
    expect(chat.getState().mode).toBe('default');
  });

  it('interrupt sends the action', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat);
    const call = jest.spyOn(api, 'tabAction');
    await chat.getState().act('interrupt');
    expect(call).toHaveBeenCalledWith(expect.anything(), 't-api', 'interrupt');
  });
});

describe('questions and suggestions', () => {
  const event = (e: Partial<TChatEvent> & { type: TChatEvent['type'] }) => ({ user_id: 'u1', conversation_id: 'c1', ...e }) as TChatEvent;

  it("a card event of this tab updates the cards; another tab's changes nothing", async () => {
    const { chat } = await setup();
    await openAndConnect(chat);
    chat.getState().noteQuestionEvent(event({ type: 'tab_question', question: question('q1', 't-api') } as never));
    chat.getState().noteQuestionEvent(event({ type: 'tab_suggestion', suggestion: suggestion('s1', 't-api') } as never));
    chat.getState().noteQuestionEvent(event({ type: 'tab_question', question: question('q2', 't-other') } as never));
    expect(chat.getState().questions.map((q) => q.id)).toEqual(['q1']);
    expect(chat.getState().suggestions.map((s) => s.id)).toEqual(['s1']);
    chat.getState().noteQuestionEvent(event({ type: 'tab_question_answered', question: { ...question('q1', 't-api'), status: 'answered' } } as never));
    expect(chat.getState().questions[0]!.status).toBe('answered');
    chat.getState().noteQuestionEvent(event({ type: 'tab_suggestion_closed', suggestion: { ...suggestion('s1', 't-api'), status: 'dismissed' } } as never));
    expect(chat.getState().suggestions[0]!.status).toBe('dismissed');
  });

  it('answers a question through the same route as the chat', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat);
    const answer = jest.spyOn(api, 'answerTabQuestion').mockResolvedValueOnce(undefined);
    await chat.getState().answerTabQuestion('q1', { allow: true });
    expect(answer).toHaveBeenCalledWith(expect.anything(), 'q1', { allow: true });
    expect(chat.getState().answeringQuestionIds).toEqual([]);
  });

  it("a failed answer is that card's error", async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat);
    jest.spyOn(api, 'answerTabQuestion').mockRejectedValueOnce(new ApiError(409, 'TAB_PROMPT_CHANGED', 'x'));
    await chat.getState().answerTabQuestion('q1', { allow: true });
    expect(chat.getState().questionErrors.q1).toBeTruthy();
  });
});

describe('files and screen', () => {
  it('uploads a file to the tab and answers its path', async () => {
    const { chat } = await setup();
    await openAndConnect(chat);
    const res = await chat.getState().uploadFile({ uri: 'file:///x/foto.png', name: 'foto.png', mime: 'image/png', bytes: 10 });
    expect(res).toEqual({ path: '/tmp/termhub-uploads/foto.png', name: 'foto.png' });
  });

  it('reads the screen; a failure is null', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat);
    expect(await chat.getState().loadScreen()).toContain('npm test');
    jest.spyOn(api, 'tabScreen').mockRejectedValueOnce(new Error('offline'));
    expect(await chat.getState().loadScreen()).toBeNull();
  });
});

it('close() closes the socket, and nothing of the conversation is written to storage', async () => {
  const ctx = setupSession();
  await enrol(ctx);
  const closeSpy = jest.fn();
  const real = ctx.api.tabEvents.bind(ctx.api);
  ctx.api.tabEvents = (auth, id, handlers) => {
    const close = real(auth, id, handlers);
    return () => {
      closeSpy();
      close();
    };
  };
  const chat = createTabChatStore({ api: ctx.api, session: () => ctx.store.getState(), tabId: 't-api' });
  const set = jest.spyOn(mmkv, 'set');
  await openAndConnect(chat);
  ctx.controls.appendTabItems('t-api', [{ kind: 'assistant', id: 'z1', at, text: 'segredo' }]);
  expect(ids(chat)).toContain('z1');
  await chat.getState().send('oi');
  chat.getState().close();
  expect(closeSpy).toHaveBeenCalledTimes(1);
  // A frame after close is not applied.
  ctx.controls.appendTabItems('t-api', [{ kind: 'assistant', id: 'z2', at, text: 'depois' }]);
  expect(ids(chat)).not.toContain('z2');
  expect(set).not.toHaveBeenCalled();
});
