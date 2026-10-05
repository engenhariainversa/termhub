// @vitest-environment jsdom
/**
 * The whole TER-904 flow as a person goes through it: the sidebar lists every terminal of the project under
 * its machine, the tab bar holds only the open tabs, and only those have a terminal mounted (and so a
 * terminal WebSocket). The sidebar and the project's terminal view render together, as on the page; the
 * API, the monitor and xterm are faked.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project, Tab } from '../lib/types';

const state = vi.hoisted(() => ({ tabs: [] as Tab[] }));
const apiMock = vi.hoisted(() => ({
  projectTabs: vi.fn(async (_projectId: string) => ({ reachable: true, tabs: state.tabs })),
  remove: vi.fn(async (_id: string) => ({ ok: true, killed: true })),
  rename: vi.fn(async () => ({})),
  createTab: vi.fn(),
  progress: vi.fn(async () => ({ epics: [], generated_at: '' })),
}));
vi.mock('../lib/api', () => ({
  api: { projects: { tabs: apiMock.projectTabs, createTab: apiMock.createTab }, tabs: { remove: apiMock.remove, rename: apiMock.rename }, progress: apiMock.progress },
  ApiError: class ApiError extends Error {},
}));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Pedro', avatar_url: null, email: 'p@example.com' }, logout: vi.fn(), can: () => true, viewAs: 'self' }),
}));
const machines = vi.hoisted(() => [{ id: 'm1', name: 'jarvis', type: 'agent', capabilities: [], is_local: false, os: null, owner_name: null }]);
vi.mock('../lib/data', () => ({
  useData: () => ({
    machines,
    projects: [projectRow],
    machinesOf: () => machines,
    missingTmux: {},
    statuses: {},
    hiddenLocal: [],
    loading: false,
  }),
}));
vi.mock('../lib/monitor', () => ({
  // the sidebar's source: every terminal of the project, with the state its hooks report
  useMonitor: () => ({ items: [], openTabs: state.tabs, needsYou: [], tabState: (id: string) => state.tabs.find((t) => t.id === id) }),
  useMarkSeenOnFocus: () => {},
}));
vi.mock('../lib/project-chat', () => ({
  useProjectChat: () => ({ currentProjectId: null, pref: () => ({ open: false }), setOpen: vi.fn(), toggle: vi.fn(), status: () => ({ busy: false, pending: 0 }) }),
}));
vi.mock('../lib/project-groups', () => ({
  useProjectGroups: () => ({ groups: [], error: null, isFavorite: () => false, toggleFavorite: vi.fn(), createGroup: vi.fn(), renameGroup: vi.fn(), deleteGroup: vi.fn(), reorderGroups: vi.fn(), setMemberships: vi.fn() }),
}));
// xterm cannot run in jsdom: a mounted terminal is a marker, which is all this flow needs to see
vi.mock('./Terminal', () => ({
  TerminalView: ({ tabId, active }: { tabId: string; active: boolean }) => <div data-testid={`terminal-${tabId}`} data-active={String(active)} />,
}));
vi.mock('./RateLimitBanner', () => ({ RateLimitBanner: () => null }));
// no WebGL in jsdom: the office drawn when no tab is open (TER-912) is a stand-in here
vi.mock('../office/scene/OfficeScene', () => ({
  OfficeScene: class {
    async mount() {}
    destroy() {}
    setModel() {}
    focus() {}
    debugHover() {}
  },
}));
// a file preview reads its machine through the API: a marker is enough for the tab bar flow (TER-941)
vi.mock('./FileView', () => ({
  FileView: ({ path, active }: { path: string; active: boolean }) => <div data-testid={`file-${path}`} data-active={String(active)} />,
}));

const projectRow = vi.hoisted(() => ({ id: 'p1', key: 'TER', name: 'termhub', status: 'active', machines: [{ machine_id: 'm1', cwd: '/w', position: 0 }] }) as unknown as Project);

import { Sidebar } from './Sidebar';
import { TerminalsView } from './TerminalsView';
import { editorTabsKey, resetEditorTabsCache } from '../lib/editor-tabs';
import { layoutKey } from '../lib/layout';
import { actRightAfterCommit } from '../test-commit';

const terminal = (id: string, name: string, position: number, over: Partial<Tab> = {}): Tab =>
  ({ id, name, project_id: 'p1', machine_id: 'm1', kind: 'terminal', tmux_session: `th-${id}`, position, alive: true, state: 'working', state_at: '2026-10-04T10:00:00.000Z', state_seen_at: null, rate_limited_at: null, ...over }) as Tab;

beforeAll(() => {
  // the terminal area measures itself; jsdom has no layout
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      this.cb([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}) });
});

beforeEach(() => {
  localStorage.clear();
  resetEditorTabsCache();
  state.tabs = [terminal('t1', 'Ana', 0), terminal('t2', 'Bia', 1), terminal('t3', 'Caio', 2, { state: 'idle' })];
  apiMock.remove.mockClear();
  apiMock.projectTabs.mockClear();
});
afterEach(cleanup);

function renderPage(url = '/projects/p1') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Sidebar />
      <main>
        <TerminalsView project={projectRow} visible />
      </main>
    </MemoryRouter>,
  );
}

/** the sidebar's list of the project's terminals on jarvis (in the "Outros" section) */
const sidebarList = () => within(screen.getByRole('region', { name: 'Outros' })).getByRole('list', { name: 'Terminais em jarvis' });
const sidebarRow = (name: string) => within(sidebarList()).getByRole('link', { name: new RegExp(name) });
/** the tab bar: the strip that holds the open tabs and the "Nova tab" button */
const tabBar = () => screen.getByRole('button', { name: 'Nova tab' }).parentElement!;
const tabNames = () => within(tabBar()).queryAllByRole('button', { name: /^Fechar aba / }).map((b) => b.getAttribute('aria-label')!.replace('Fechar aba ', ''));
const mounted = () => screen.queryAllByTestId(/^terminal-/).map((el) => el.dataset.testid!.replace('terminal-', ''));

describe('terminals like a code editor (TER-904)', () => {
  it('lists every terminal in the sidebar but mounts only the open tabs; click previews, double click pins, ✕ closes only the tab', async () => {
    // a returning user: one pinned tab open
    localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: ['t1'], preview: null }));
    renderPage();
    await waitFor(() => expect(mounted()).toEqual(['t1']));
    expect(within(sidebarList()).getAllByRole('link').map((l) => l.textContent)).toEqual(['Ana', 'Bia', 'Caio']);
    expect(tabNames()).toEqual(['Ana']);

    // single click: Bia opens in the preview tab
    fireEvent.click(sidebarRow('Bia'));
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'Bia']));
    expect(within(tabBar()).getByText('Bia')).toHaveClass('italic');
    expect(mounted().sort()).toEqual(['t1', 't2']);
    expect(screen.getByTestId('terminal-t2')).toHaveAttribute('data-active', 'true');

    // another single click reuses the preview: Bia's tab closes (and its terminal unmounts), Caio takes it
    fireEvent.click(sidebarRow('Caio'));
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'Caio']));
    expect(mounted().sort()).toEqual(['t1', 't3']);

    // double click on the preview tab pins it; the next single click opens a new preview next to it
    fireEvent.doubleClick(within(tabBar()).getByText('Caio'));
    expect(within(tabBar()).getByText('Caio')).not.toHaveClass('italic');
    fireEvent.click(sidebarRow('Bia'));
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'Caio', 'Bia']));

    // the tab's ✕ closes the tab only: the terminal stays in the sidebar and nothing is killed
    fireEvent.click(within(tabBar()).getByRole('button', { name: 'Fechar aba Caio' }));
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'Bia']));
    expect(mounted()).not.toContain('t3');
    expect(apiMock.remove).not.toHaveBeenCalled();
    expect(sidebarRow('Caio')).toBeInTheDocument();

    // and it reopens from the sidebar (the tmux session was never touched, so its content is still there);
    // a double click is a click (Caio takes Bia's preview tab) and then the pin
    fireEvent.doubleClick(sidebarRow('Caio'));
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'Caio']));
    expect(within(tabBar()).getByText('Caio')).not.toHaveClass('italic');
    expect(mounted()).toContain('t3');
  });

  it('⌘W closes the focused tab without ending its terminal', async () => {
    localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: ['t1', 't2'], preview: null }));
    renderPage();
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'Bia']));
    fireEvent.click(within(tabBar()).getByText('Bia'));
    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    await waitFor(() => expect(tabNames()).toEqual(['Ana']));
    expect(apiMock.remove).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('⌘1..9 go through the open tabs only', async () => {
    localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: ['t3', 't1'], preview: null }));
    renderPage();
    await waitFor(() => expect(tabNames()).toEqual(['Caio', 'Ana']));
    fireEvent.keyDown(window, { key: '2', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('terminal-t1')).toHaveAttribute('data-active', 'true'));
    expect(screen.getByTestId('terminal-t3')).toHaveAttribute('data-active', 'false');
  });

  it('the sidebar ✕ ends the terminal: asks first when it is working, then its tab goes away', async () => {
    localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: ['t1', 't2'], preview: null }));
    renderPage();
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'Bia']));
    fireEvent.click(within(sidebarList()).getByRole('button', { name: 'Encerrar terminal Ana' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('th-t1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Encerrar terminal' }));
    await waitFor(() => expect(apiMock.remove).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(tabNames()).toEqual(['Bia']));
    expect(mounted()).toEqual(['t2']);
  });

  it('a finished terminal ends from the sidebar without asking', async () => {
    renderPage();
    await waitFor(() => expect(mounted().length).toBe(1));
    fireEvent.click(within(sidebarList()).getByRole('button', { name: 'Encerrar terminal Caio' }));
    await waitFor(() => expect(apiMock.remove).toHaveBeenCalledWith('t3'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('remembers the pinned and preview tabs per project across a reload', async () => {
    localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: ['t1'], preview: null }));
    renderPage();
    await waitFor(() => expect(tabNames()).toEqual(['Ana']));
    fireEvent.click(sidebarRow('Caio'));
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'Caio']));

    cleanup();
    resetEditorTabsCache(); // a reload reads storage again
    renderPage();
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'Caio']));
    expect(within(tabBar()).getByText('Caio')).toHaveClass('italic');
    expect(mounted().sort()).toEqual(['t1', 't3']);
  });

  it('first visit: opens what the saved layout had on screen, not every terminal', async () => {
    localStorage.setItem(layoutKey('p1'), JSON.stringify({ preset: 'columns', cells: ['t2', 't3'], focusedCell: 0, floating: null }));
    renderPage();
    await waitFor(() => expect(tabNames()).toEqual(['Bia', 'Caio']));
    expect(mounted().sort()).toEqual(['t2', 't3']);
    expect(within(tabBar()).getByText('Bia')).not.toHaveClass('italic');
  });

  it('first visit without a saved layout: the first terminal opens in preview', async () => {
    renderPage();
    await waitFor(() => expect(tabNames()).toEqual(['Ana']));
    expect(within(tabBar()).getByText('Ana')).toHaveClass('italic');
    expect(mounted()).toEqual(['t1']);
  });

  it('the pane layouts keep working with the open tabs: two columns show two of them', async () => {
    localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: ['t1', 't2'], preview: null }));
    renderPage();
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'Bia']));
    fireEvent.click(screen.getByRole('radio', { name: 'Duas colunas' }));
    // the empty pane offers every terminal of the project, and picking one opens its tab
    const pickers = await screen.findAllByRole('combobox', { name: 'Aba deste painel' });
    const picker = pickers[pickers.length - 1]; // the empty second pane's
    fireEvent.change(picker, { target: { value: 't3' } });
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'Bia', 'Caio']));
    expect(screen.getByTestId('terminal-t3')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('terminal-t1')).toHaveAttribute('data-active', 'true');
  });

  it('keeps a layout picked the moment the tabs appear (the saved layout loads in that same commit)', async () => {
    localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: ['t1', 't2'], preview: null }));
    renderPage();
    await actRightAfterCommit(
      () => tabNames().join() === 'Ana,Bia',
      () => fireEvent.click(screen.getByRole('radio', { name: 'Duas colunas' })),
    );
    await act(async () => {});
    expect(screen.getByRole('radio', { name: 'Duas colunas' })).toBeChecked();
    expect(screen.getAllByRole('combobox', { name: 'Aba deste painel' }).length).toBeGreaterThan(0);
  });

  it('with every tab closed, the area lists the terminals to open (the sidebar may be collapsed)', async () => {
    localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: [], preview: null }));
    renderPage();
    const list = await screen.findByRole('list', { name: 'Terminais do projeto' });
    expect(mounted()).toEqual([]);
    fireEvent.click(within(list).getByRole('button', { name: /Bia/ }));
    await waitFor(() => expect(tabNames()).toEqual(['Bia']));
    expect(mounted()).toEqual(['t2']);
  });

  it('drops a tab whose terminal disappeared on the server', async () => {
    localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: ['t1', 'gone'], preview: 'gone' }));
    renderPage();
    await waitFor(() => expect(tabNames()).toEqual(['Ana']));
    await act(async () => {});
    expect(JSON.parse(localStorage.getItem(editorTabsKey('p1'))!)).toEqual({ open: ['t1'], preview: null });
  });
});

describe('file previews in the tab bar (TER-941)', () => {
  it('?file= opens the path as the preview tab next to the terminals; a double click pins it; ✕ closes it', async () => {
    localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: ['t1'], preview: null }));
    renderPage('/projects/p1?file=docs%2Fa.md');
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'a.md']));
    expect(within(tabBar()).getByText('a.md')).toHaveClass('italic');
    expect(screen.getByTestId('file-docs/a.md')).toHaveAttribute('data-active', 'true');
    expect(mounted()).toEqual(['t1']);

    // the next single click on a terminal reuses the preview tab, as for terminals
    fireEvent.click(sidebarRow('Bia'));
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'Bia']));
    expect(screen.queryByTestId('file-docs/a.md')).toBeNull();
  });

  it('pin=1 opens it pinned, and a pinned file tab survives a reload and the terminal list', async () => {
    localStorage.setItem(editorTabsKey('p1'), JSON.stringify({ open: ['t1'], preview: null }));
    const first = renderPage('/projects/p1?file=%7E%2Fr.md&pin=1');
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'r.md']));
    expect(within(tabBar()).getByText('r.md')).not.toHaveClass('italic');
    first.unmount();
    resetEditorTabsCache();
    renderPage();
    await waitFor(() => expect(tabNames()).toEqual(['Ana', 'r.md']));

    fireEvent.click(within(tabBar()).getByRole('button', { name: 'Fechar aba r.md' }));
    await waitFor(() => expect(tabNames()).toEqual(['Ana']));
    expect(apiMock.remove).not.toHaveBeenCalled();
  });
});
