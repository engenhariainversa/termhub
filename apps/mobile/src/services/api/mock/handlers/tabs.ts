// Sessions (spec 2026-10-01 tab chat §5.4, §5.5): terminal tabs read as conversations. Three tabs: `t-api`
// (termhub, working, ready), `t-web` (termhub, on a machine whose agent is too old) and `t-deploy`
// (opapingou, waiting on a permission). A page is the last `PAGE_ITEMS` items before a cursor; a cursor
// is `<session id>.<item index>`, as opaque to the app as the server's byte offsets.
import { randomId } from '../../../crypto/random';
import { startSessionBody, startTabAgentBody, tabActionBody, tabMessageBody, type TTabChatFrame, type TTabChatItem, type TTabAgentChoice, type TTabChatPage, type TTabQuestion, type TTabSuggestion, type TTabSummary } from '../../contract';
import type { MockRouter } from '../router';
import { isUploadBody } from '../router';
import { type MockState, type MockTab, verifyAuth, WireError } from '../state';

/** Items per page: small, so the mock has an earlier page to load. */
export const PAGE_ITEMS = 6;
const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

const TAB_NOT_FOUND = () => new WireError(404, 'NOT_FOUND', 'Aba não encontrada');

/** The accounts every mock machine can start an agent with (TER-1094): Claude Code is the one picked without asking. */
const AGENT_CHOICES: TTabAgentChoice[] = [
  { account_id: 'acc-claude', label: 'Pessoal', provider: 'claude', model: 'opus' },
  { account_id: 'acc-codex', label: 'Trabalho', provider: 'chatgpt', model: null },
];

function seedItems(prefix: string, at: string, turns: number): TTabChatItem[] {
  const items: TTabChatItem[] = [];
  for (let i = 0; i < turns; i++) {
    items.push({ kind: 'user', id: `${prefix}-u${i}`, at, text: `Pedido ${i + 1}`, images: 0 });
    items.push({ kind: 'assistant', id: `${prefix}-a${i}`, at, text: `Feito o pedido ${i + 1}.` });
  }
  return items;
}

export function seedTabs(state: MockState, now: number): void {
  const at = new Date(now - 10 * 60_000).toISOString();
  const tab = (
    summary: Omit<TTabSummary, 'background' | 'finished' | 'blocked' | 'auth_required' | 'trust_prompt' | 'state_at' | 'activity_verb' | 'auto_ref' | 'agent'> & Partial<Pick<TTabSummary, 'auto_ref' | 'agent'>>,
    session: string | null,
    items: TTabChatItem[],
    screen: string,
  ): MockTab => ({
    summary: { background: false, finished: false, blocked: false, auth_required: false, trust_prompt: false, state_at: at, activity_verb: null, auto_ref: null, agent: 'claude', ...summary },
    session,
    items,
    // Codex has no permission mode the server reads off its footer (TER-1102)
    mode: summary.agent === 'codex' ? null : 'default',
    screen,
  });
  state.tabs.set(
    't-api',
    tab(
      { id: 't-api', name: 'api', project: { id: 'p-termhub', key: 'TER', name: 'termhub' }, machine: { id: 'm-jarvis', name: 'jarvis' }, state: 'working', needs_you: false, activity: 'Bash', availability: 'ready', auto_ref: 'TER-42' },
      's-api',
      [
        ...seedItems('api', at, 3),
        { kind: 'user', id: 'api-u9', at, text: 'roda os testes', images: 0 },
        { kind: 'assistant', id: 'api-a9:0', at, text: 'Vou rodar os testes.' },
        { kind: 'tool', id: 'toolu-1', at, name: 'Bash', summary: 'npm test' },
        { kind: 'tool_result', id: 'api-r1', at, tool_id: 'toolu-1', error: false, preview: '842 passed' },
        { kind: 'tool', id: 'toolu-2', at, name: 'Read', summary: 'src/app.ts' },
      ],
      '$ npm test\n842 passed\n> ',
    ),
  );
  state.tabs.set(
    't-web',
    tab({ id: 't-web', name: 'web', project: { id: 'p-termhub', key: 'TER', name: 'termhub' }, machine: { id: 'm-hulk', name: 'hulk' }, state: 'idle', needs_you: false, activity: null, availability: 'agent_outdated', agent: null }, null, [], ''),
  );
  state.tabs.set(
    't-deploy',
    tab(
      { id: 't-deploy', name: 'deploy', project: { id: 'p-opapingou', key: 'OPM', name: 'opapingou' }, machine: { id: 'm-jarvis', name: 'jarvis' }, state: 'waiting_permission', needs_you: true, activity: null, availability: 'ready' },
      's-deploy',
      seedItems('deploy', at, 1),
      'Allow Bash(fly deploy)? 1. Yes 2. No',
    ),
  );
  // A Codex session (TER-1102), its items as the server reads them from a Codex rollout file (codex-transcript.ts):
  // commands are `Bash` with the script as the summary, edits `apply_patch` with the first path; each has its result.
  state.tabs.set(
    't-codex',
    tab(
      { id: 't-codex', name: 'June', project: { id: 'p-opapingou', key: 'OPM', name: 'opapingou' }, machine: { id: 'm-jarvis', name: 'jarvis' }, state: 'working', needs_you: false, activity: 'terminal', availability: 'ready', agent: 'codex' },
      's-codex',
      [
        { kind: 'user', id: 'cx-u1', at, text: 'resuma o repositório', images: 0 },
        { kind: 'assistant', id: 'cx-a1', at, text: 'Vou ler a estrutura do projeto.' },
        { kind: 'tool', id: 'exec-1', at, name: 'Bash', summary: "rg --files -g '!node_modules' | head -50" },
        { kind: 'tool_result', id: 'exec-1:result', at, tool_id: 'exec-1', error: false, preview: 'apps/api/src/main.ts' },
        { kind: 'tool', id: 'exec-2', at, name: 'Bash', summary: 'rg -n "TODO" apps/api' },
        { kind: 'tool_result', id: 'exec-2:result', at, tool_id: 'exec-2', error: true, preview: null },
        { kind: 'tool', id: 'patch-1', at, name: 'apply_patch', summary: 'apps/api/README.md' },
        { kind: 'tool_result', id: 'patch-1:result', at, tool_id: 'patch-1', error: false, preview: 'Success. Updated the following files:\nM apps/api/README.md\n' },
      ],
      '› resuma o repositório\n\n• Working (12s • esc to interrupt)',
    ),
  );
}

/** `<session>.<index>` for a tab's session, or null when the cursor is another session's (or garbage). */
function indexOf(tab: MockTab, cursor: string | undefined | null): number | null {
  if (!cursor || !tab.session) return null;
  const dot = cursor.lastIndexOf('.');
  if (cursor.slice(0, dot) !== tab.session) return null;
  const n = Number(cursor.slice(dot + 1));
  return Number.isInteger(n) && n >= 0 && n <= tab.items.length ? n : null;
}

function page(state: MockState, tab: MockTab, before: string | undefined): TTabChatPage {
  const ready = tab.summary.availability === 'ready' && tab.session !== null;
  const end = (before ? indexOf(tab, before) : null) ?? tab.items.length;
  const start = Math.max(0, end - PAGE_ITEMS);
  const strip = <T extends { conversation_id: string }>({ conversation_id: _c, ...rest }: T) => rest;
  return {
    tab: tab.summary,
    session_id: tab.session,
    items: ready ? tab.items.slice(start, end) : [],
    before: ready && start > 0 ? `${tab.session}.${start}` : null,
    live: ready ? `${tab.session}.${tab.items.length}` : null,
    mode: ready ? tab.mode : null,
    degraded: false,
    questions: state.tabQuestions.filter((q) => q.tab_id === tab.summary.id && q.status === 'open').map((q) => strip(q) as TTabQuestion),
    suggestions: state.tabSuggestions.filter((s) => s.tab_id === tab.summary.id && s.status === 'open').map((x) => strip(x) as TTabSuggestion),
    empty_reason: emptyReason(tab, ready, before),
  };
}

/** The server's `emptyReasonOf` (TER-1091), over the mock's tab. */
function emptyReason(tab: MockTab, ready: boolean, before: string | undefined): string | null {
  if (tab.noSessionReason === 'no_agent') return 'no_agent';
  if (tab.summary.availability === 'no_session') return tab.noSessionReason ?? 'not_reported';
  if (ready && !before && tab.items.length === 0) return 'new_session';
  return null;
}

/** Sends `frame` to every socket open on `tabId`. */
export function sendTabFrame(state: MockState, tabId: string, frame: TTabChatFrame): void {
  for (const socket of state.tabSockets) if (socket.tabId === tabId) socket.send(frame);
}

/** Appends items to a tab and relays them, as the server's follower would. */
export function appendTabItems(state: MockState, tabId: string, items: TTabChatItem[]): void {
  const tab = state.tabs.get(tabId);
  if (!tab || !tab.session) return;
  tab.items.push(...items);
  sendTabFrame(state, tabId, { type: 'items', items, live: `${tab.session}.${tab.items.length}`, mode: null });
}

/** What a socket that joins with `after` must catch up on: nothing, the items after it, or a reset. */
export function catchUp(state: MockState, tabId: string, after: string | null): TTabChatFrame | null {
  const tab = state.tabs.get(tabId);
  if (!tab || !tab.session || after === null) return null;
  const from = indexOf(tab, after);
  if (from === null) return { type: 'reset', session_id: tab.session };
  if (from === tab.items.length) return null;
  return { type: 'items', items: tab.items.slice(from), live: `${tab.session}.${tab.items.length}`, mode: null };
}

export function registerTabRoutes(router: MockRouter, state: MockState): void {
  const load = (id: string): MockTab => {
    const tab = state.tabs.get(id);
    if (!tab) throw TAB_NOT_FOUND();
    return tab;
  };

  router.route('GET', '/api/m/v1/tabs', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: { tabs: [...state.tabs.values()].map((t) => t.summary) } };
  });

  router.route('POST', '/api/m/v1/tabs', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const body = startSessionBody.parse(ctx.body);
    const project = state.projects.get(body.project_id);
    if (!project) throw new WireError(404, 'NOT_FOUND', 'Projeto não encontrado');
    const id = `t-${randomId(6)}`;
    const at = new Date(ctx.now()).toISOString();
    state.tabs.set(id, {
      summary: { id, name: 'claude', project: { id: project.id, key: project.key, name: project.name }, machine: { id: 'm-jarvis', name: 'jarvis' }, state: 'working', background: false, finished: false, blocked: false, auth_required: false, trust_prompt: false, state_at: at, needs_you: false, activity: null, activity_verb: null, availability: 'ready', auto_ref: null, agent: 'claude' },
      session: `s-${randomId(6)}`,
      items: [{ kind: 'user', id: `${id}-u0`, at, text: body.prompt, images: 0 }],
      mode: 'default',
      screen: '',
    });
    return { status: 200, body: { tab_id: id } };
  });

  router.route('GET', '/api/m/v1/tabs/:id/chat', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: page(state, load(ctx.params.id!), ctx.query.before) };
  });

  router.route('POST', '/api/m/v1/tabs/:id/chat/messages', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const tab = load(ctx.params.id!);
    const { text } = tabMessageBody.parse(ctx.body);
    if (tab.summary.state === 'waiting_permission') throw new WireError(409, 'WAITING_PERMISSION', 'Responda a pergunta acima antes de enviar uma mensagem');
    appendTabItems(state, tab.summary.id, [{ kind: 'user', id: `${tab.summary.id}-${randomId(6)}`, at: new Date(ctx.now()).toISOString(), text, images: 0 }]);
    return { status: 200, body: {} };
  });

  router.route('POST', '/api/m/v1/tabs/:id/chat/actions', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const tab = load(ctx.params.id!);
    const { action } = tabActionBody.parse(ctx.body);
    const at = new Date(ctx.now()).toISOString();
    if (action === 'cycle_mode') {
      tab.mode = MODES[(MODES.indexOf(tab.mode ?? '') + 1) % MODES.length]!;
      return { status: 200, body: { done: true, mode: tab.mode } };
    }
    if (action === 'clear') {
      tab.session = `s-${randomId(6)}`;
      tab.items = [];
      sendTabFrame(state, tab.summary.id, { type: 'reset', session_id: tab.session });
    } else if (action === 'interrupt') {
      appendTabItems(state, tab.summary.id, [{ kind: 'notice', id: `${tab.summary.id}-${randomId(6)}`, at, notice: 'interrupted' }]);
    } else {
      appendTabItems(state, tab.summary.id, [{ kind: 'command', id: `${tab.summary.id}-${randomId(6)}`, at, name: '/compact', args: null }]);
    }
    return { status: 200, body: { done: true, mode: null } };
  });

  router.route('POST', '/api/m/v1/tabs/:id/chat/files', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    load(ctx.params.id!);
    if (!isUploadBody(ctx.body)) throw new WireError(400, 'VALIDATION', 'Dados inválidos.');
    const name = ctx.query.name;
    if (!name) throw new WireError(400, 'VALIDATION', 'Dados inválidos.');
    return { status: 200, body: { path: `/tmp/termhub-uploads/${name}`, name } };
  });

  router.route('GET', '/api/m/v1/tabs/:id/screen', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: { text: load(ctx.params.id!).screen } };
  });

  // "Iniciar sessão" (TER-1094): a plain shell starts the agent in place; any other tab gets a new one.
  router.route('GET', '/api/m/v1/tabs/:id/agent', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    load(ctx.params.id!);
    return { status: 200, body: { choices: AGENT_CHOICES, suggested: AGENT_CHOICES[0]!.account_id, provider: 'claude' } };
  });

  router.route('POST', '/api/m/v1/tabs/:id/agent', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const tab = load(ctx.params.id!);
    const { account_id } = startTabAgentBody.parse(ctx.body ?? {});
    const choice = AGENT_CHOICES.find((c) => c.account_id === (account_id ?? AGENT_CHOICES[0]!.account_id));
    if (!choice) throw new WireError(404, 'NOT_FOUND', 'Conta não encontrada');
    const at = new Date(ctx.now()).toISOString();
    let id = tab.summary.id;
    if (tab.noSessionReason === 'no_agent') {
      tab.noSessionReason = undefined;
      tab.session = `s-${randomId(6)}`;
      tab.items = [];
      tab.summary = { ...tab.summary, availability: 'ready', state: 'idle', state_at: at };
    } else {
      id = `t-${randomId(6)}`;
      state.tabs.set(id, { summary: { ...tab.summary, id, name: choice.provider === 'chatgpt' ? 'codex' : 'claude', agent: choice.provider === 'chatgpt' ? 'codex' : 'claude', availability: 'ready', state: 'idle', state_at: at }, session: `s-${randomId(6)}`, items: [], mode: 'default', screen: '' });
    }
    return { status: 200, body: { tab_id: id, new_tab: id !== tab.summary.id, account: { id: choice.account_id, label: choice.label }, provider: choice.provider, model: choice.model } };
  });

  // "Instalar hooks" (TER-1091): the machine's tabs stop being `no_hooks`; their sessions still wait for Claude.
  router.route('POST', '/api/m/v1/machines/:id/hooks', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const tabs = [...state.tabs.values()].filter((t) => t.summary.machine.id === ctx.params.id);
    if (tabs.length === 0) throw new WireError(404, 'NOT_FOUND', 'Máquina não encontrada');
    for (const t of tabs) if (t.noSessionReason === 'no_hooks') t.noSessionReason = 'not_reported';
    return { status: 200, body: { installed_at: new Date(ctx.now()).toISOString() } };
  });
}
