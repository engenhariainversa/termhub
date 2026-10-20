// @vitest-environment jsdom
/**
 * The whole TER-1003 flow as a person goes through it: a Claude Code tab in the tab bar switches to its
 * conversation, which shows the session's history and follows it live; a message, an interrupt and a
 * permission answer go to the tab; the conversation opens next to its terminal. The project's terminal
 * view renders as on the page; the API, the monitor, the tab's socket and xterm are faked.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Tab, TabChatFrame, TabChatPage, TabQuestion } from '../lib/types';

const SID = '11111111-2222-4333-8444-555555555555';
const at = '2026-10-07T10:00:00.000Z';

const state = vi.hoisted(() => ({ tabs: [] as Tab[], page: null as unknown as TabChatPage }));
const apiMock = vi.hoisted(() => ({
  projectTabs: vi.fn(async (_projectId: string) => ({ reachable: true, tabs: state.tabs })),
  page: vi.fn(async (_id: string, _before?: string | null) => state.page),
  send: vi.fn(async (_id: string, _text: string) => ({ sent: true as const })),
  action: vi.fn(async (_id: string, action: string) => ({ done: true as const, mode: action === 'cycle_mode' ? 'acceptEdits' : null })),
  screen: vi.fn(async () => ({ text: '> claude' })),
  answerTabQuestion: vi.fn(),
  tabQuestionScreen: vi.fn(async () => ({ text: 'Do you want to run ls?', options: [{ number: 2, label: "Yes, and don't ask again", summary: 'Sim, sempre', allow: true, highlight: true }] })),
  pasteFile: vi.fn(async (_id: string, _f: Blob, name?: string) => ({ path: `/home/u/.cache/termhub/paste/${name}`, bytes: 3, mime: 'text/markdown' })),
}));
vi.mock('../lib/api', () => ({
  api: {
    projects: { tabs: apiMock.projectTabs, createTab: vi.fn() },
    tabs: { remove: vi.fn(), rename: vi.fn(), pasteFile: apiMock.pasteFile },
    tabChat: { page: apiMock.page, send: apiMock.send, action: apiMock.action, screen: apiMock.screen },
    answerTabQuestion: apiMock.answerTabQuestion,
    tabQuestionScreen: apiMock.tabQuestionScreen,
    cancelAutoAnswer: vi.fn(),
    sendTabSuggestion: vi.fn(),
    dismissTabSuggestion: vi.fn(),
    progress: vi.fn(async () => ({ epics: [], generated_at: '' })),
  },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Pedro', avatar_url: null, email: 'p@example.com' }, logout: vi.fn(), can: () => true, viewAs: 'self' }),
}));
const machines = vi.hoisted(() => [{ id: 'm1', name: 'jarvis', type: 'agent', capabilities: [], is_local: false, os: null, owner_name: null }]);
vi.mock('../lib/data', () => ({
  useData: () => ({ machines, projects: [], machinesOf: () => machines, missingTmux: {}, statuses: {}, hiddenLocal: [], loading: false }),
}));
vi.mock('../lib/monitor', () => ({
  useMonitor: () => ({ items: [], openTabs: state.tabs, needsYou: [], tabState: (id: string) => state.tabs.find((t) => t.id === id) }),
  useMarkSeenOnFocus: () => {},
}));
vi.mock('./Terminal', () => ({
  TerminalView: ({ tabId, active }: { tabId: string; active: boolean }) => <div data-testid={`terminal-${tabId}`} data-active={String(active)} />,
}));
vi.mock('./RateLimitBanner', () => ({ RateLimitBanner: () => null }));
vi.mock('../office/scene/OfficeScene', () => ({
  OfficeScene: class {
    async mount() {}
    destroy() {}
    setModel() {}
    focus() {}
    debugHover() {}
  },
}));

/** The tab's socket: one per open conversation; the test pushes the server's frames into it. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  push(frame: TabChatFrame) {
    act(() => this.onmessage?.({ data: JSON.stringify(frame) }));
  }
  close() {
    this.closed = true;
  }
}

const projectRow = { id: 'p1', key: 'TER', name: 'termhub', status: 'active', machines: [{ machine_id: 'm1', cwd: '/w', position: 0 }] } as unknown as Project;

import { TerminalsView } from './TerminalsView';
import { editorTabsKey, resetEditorTabsCache } from '../lib/editor-tabs';
import { resetTabViewCache, TAB_VIEW_KEY } from '../lib/tab-view';

const terminal = (id: string, name: string, position: number): Tab =>
  ({ id, name, project_id: 'p1', machine_id: 'm1', kind: 'terminal', tmux_session: `th-${id}`, position, alive: true, state: 'working', state_tool: 'claude', state_at: at, state_seen_at: null, rate_limited_at: null }) as Tab;

const summary = (over: Partial<TabChatPage['tab']> = {}): TabChatPage['tab'] => ({
  id: 't1',
  name: 'Ana',
  project: { id: 'p1', key: 'TER', name: 'termhub' },
  machine: { id: 'm1', name: 'jarvis' },
  state: 'working',
  background: false,
  finished: false,
  state_at: at,
  needs_you: false,
  activity: 'Bash',
  activity_verb: null,
  availability: 'ready',
  ...over,
});

const permission: TabQuestion = {
  id: 'q1',
  tab_id: 't1',
  tab_name: 'Ana',
  kind: 'permission',
  payload: { tool_name: 'Bash' },
  status: 'open',
  answer: null,
  error_code: null,
  created_at: at,
  answered_at: null,
  closed_at: null,
} as TabQuestion;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      this.cb([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}) });
  vi.stubGlobal('WebSocket', FakeSocket);
});

beforeEach(() => {
  localStorage.clear();
  resetEditorTabsCache();
  resetTabViewCache();
  FakeSocket.all = [];
  vi.clearAllMocks();
  state.tabs = [terminal('t1', 'Ana', 0)];
  localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: ['t1'], preview: null }));
  state.page = {
    tab: summary(),
    session_id: SID,
    items: [
      { kind: 'user', id: 'u1', at, text: 'liste os arquivos', images: 0 },
      { kind: 'tool', id: 'tl1', at, name: 'Bash', summary: 'ls -la' },
      { kind: 'tool_result', id: 'r1', at, tool_id: 'tl1', error: false, preview: 'README.md' },
      { kind: 'tool', id: 'ag1', at, name: 'Agent', summary: 'Revisar o código' },
      { kind: 'assistant', id: 'a1', at, text: 'Achei **um** arquivo:\n\n```\nREADME.md\n```' },
    ],
    before: null,
    live: `${SID}.900`,
    mode: 'default',
    degraded: false,
    questions: [],
    suggestions: [],
  };
});
afterEach(cleanup);

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <TerminalsView project={projectRow} visible />
    </MemoryRouter>,
  );
}

async function openConversation() {
  renderView();
  fireEvent.click(await screen.findByRole('button', { name: 'Mostrar Ana como conversa' }));
  return screen.findByTestId('tab-chat');
}

describe('a Claude tab as a conversation (TER-1003)', () => {
  it('the tab switches between the terminal and its conversation, and the choice is remembered', async () => {
    renderView();
    expect(await screen.findByTestId('terminal-t1')).toHaveAttribute('data-active', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar Ana como conversa' }));
    expect(await screen.findByTestId('tab-chat')).toBeInTheDocument();
    // the terminal stays mounted (its session and screen are kept), off screen
    expect(screen.getByTestId('terminal-t1')).toHaveAttribute('data-active', 'false');
    expect(JSON.parse(localStorage.getItem(TAB_VIEW_KEY)!)).toEqual({ t1: 'chat' });
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar o terminal de Ana' }));
    await waitFor(() => expect(screen.queryByTestId('tab-chat')).not.toBeInTheDocument());
    expect(screen.getByTestId('terminal-t1')).toHaveAttribute('data-active', 'true');
  });

  it('shows the history in Markdown with tools folded and the subagent, then follows the session live', async () => {
    const view = await openConversation();
    const list = await within(view).findByRole('list', { name: 'Conversa da aba' });
    expect(within(list).getByText('liste os arquivos')).toBeInTheDocument();
    expect(within(list).getByText('um').tagName).toBe('STRONG');
    // the code block has the chat's copy button (TER-992)
    expect(list.querySelector('[data-copy]')).not.toBeNull();
    // one tool, folded; it opens to its result
    fireEvent.click(within(list).getByRole('button', { name: /1 ferramenta/ }));
    fireEvent.click(within(list).getByRole('button', { name: /ls -la.*resultado/ }));
    expect(within(list).getByText('README.md', { selector: 'pre' })).toBeInTheDocument();
    expect(within(list).getByText('Subagente')).toBeInTheDocument();
    expect(within(list).getByText('Revisar o código')).toBeInTheDocument();
    expect(within(view).getByText('Trabalhando · Bash')).toBeInTheDocument();
    expect(within(view).getByRole('button', { name: /Modo: Padrão/ })).toBeInTheDocument();

    // the socket follows from the page's cursor
    await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    expect(FakeSocket.all[0]!.url).toContain(`/ws/tabs/t1/chat?after=${encodeURIComponent(`${SID}.900`)}`);
    FakeSocket.all[0]!.push({ type: 'items', items: [{ kind: 'assistant', id: 'a2', at, text: 'Mais uma coisa' }], live: `${SID}.990`, mode: null });
    expect(await within(list).findByText('Mais uma coisa')).toBeInTheDocument();
  });

  it('sends a message to the tab, and interrupts it while it works', async () => {
    const view = await openConversation();
    const box = within(view).getByRole('textbox', { name: 'Mensagem para a sessão' });
    fireEvent.change(box, { target: { value: 'agora rode os testes' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(apiMock.send).toHaveBeenCalledWith('t1', 'agora rode os testes'));
    expect(box).toHaveValue('');
    fireEvent.click(within(view).getByRole('button', { name: 'Interromper' }));
    await waitFor(() => expect(apiMock.action).toHaveBeenCalledWith('t1', 'interrupt'));
  });

  it("a picked file is saved on the tab's machine and its path goes with the message", async () => {
    const view = await openConversation();
    const input = view.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['# a'], 'plano.md', { type: 'text/markdown' })] } });
    // a Markdown file opens its preview from the chip (TER-941)
    expect(await within(view).findByRole('button', { name: 'plano.md' })).toBeInTheDocument();
    fireEvent.change(within(view).getByRole('textbox', { name: 'Mensagem para a sessão' }), { target: { value: 'leia' } });
    fireEvent.click(within(view).getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(apiMock.send).toHaveBeenCalledWith('t1', 'leia\n\n/home/u/.cache/termhub/paste/plano.md'));
  });

  it("answers a permission with one of the dialog's own options (TER-995)", async () => {
    state.page = { ...state.page, tab: summary({ state: 'waiting_permission', needs_you: true }), questions: [permission] };
    apiMock.answerTabQuestion.mockResolvedValue({ tab_question: { ...permission, status: 'answered' } });
    const view = await openConversation();
    const option = await within(view).findByRole('button', { name: '2. Sim, sempre' });
    fireEvent.click(option);
    await waitFor(() => expect(apiMock.answerTabQuestion).toHaveBeenCalledWith('q1', { allow: true, option: { number: 2, label: "Yes, and don't ask again" } }));
  });

  it('a message while a dialog waits says to answer it first', async () => {
    const { ApiError } = await import('../lib/api');
    apiMock.send.mockRejectedValueOnce(new (ApiError as unknown as new (s: number, m: string, c: string) => Error)(409, 'x', 'WAITING_PERMISSION'));
    const view = await openConversation();
    const box = within(view).getByRole('textbox', { name: 'Mensagem para a sessão' });
    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await within(view).findByRole('alert')).toHaveTextContent('Responda a pergunta acima antes de enviar uma mensagem');
    // the text comes back to the box
    expect(box).toHaveValue('oi');
  });

  it('a machine with an old agent says to update it', async () => {
    state.page = { ...state.page, tab: summary({ availability: 'agent_outdated' }), items: [], live: null };
    const view = await openConversation();
    expect(await within(view).findByText('Atualize o agente desta máquina')).toBeInTheDocument();
  });

  it('a reset (a /clear) empties the conversation and loads the new session', async () => {
    const view = await openConversation();
    await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    state.page = { ...state.page, session_id: 'other', items: [{ kind: 'assistant', id: 'n1', at, text: 'Sessão nova' }] };
    FakeSocket.all[0]!.push({ type: 'reset', session_id: 'other' });
    expect(await within(view).findByText('Sessão nova')).toBeInTheDocument();
    expect(within(view).queryByText('liste os arquivos')).not.toBeInTheDocument();
  });

  it('cycles the mode, and opens the conversation next to its terminal', async () => {
    const view = await openConversation();
    fireEvent.click(within(view).getByRole('button', { name: /Modo:/ }));
    await waitFor(() => expect(within(view).getByRole('button', { name: /Modo: Aceitar edições/ })).toBeInTheDocument());
    expect(apiMock.action).toHaveBeenCalledWith('t1', 'cycle_mode');

    fireEvent.click(within(view).getByTitle('Ações da sessão'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Abrir ao lado do terminal' }));
    // two panes: the terminal back in its tab, the conversation in a tab of its own beside it
    await waitFor(() => expect(screen.getByTestId('terminal-t1')).toHaveAttribute('data-active', 'true'));
    expect(screen.getAllByTestId('tab-chat')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Duas colunas' })).toHaveAttribute('aria-checked', 'true');
    expect(JSON.parse(localStorage.getItem(editorTabsKey('p1'))!).open).toEqual(['t1', 'chat:t1']);
  });

  it("closing the conversation's own tab leaves the terminal alone", async () => {
    localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: ['t1', 'chat:t1'], preview: null }));
    renderView();
    const close = await screen.findAllByRole('button', { name: 'Fechar aba Ana' });
    expect(close).toHaveLength(2);
    fireEvent.click(close[1]!);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(editorTabsKey('p1'))!).open).toEqual(['t1']));
  });
});
