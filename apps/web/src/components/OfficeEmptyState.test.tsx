// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentOnCard, CardProgress, EpicProgress, Machine, Project, Tab } from '../lib/types';

const { FakeOfficeScene, progressMock, canMock, monitorState, narrowState, chatMock } = vi.hoisted(() => {
  /** no WebGL in jsdom: a stand-in that records what the component does to the scene */
  class FakeOfficeScene {
    static instances: FakeOfficeScene[] = [];
    handlers: { onPickDesk: (tabId: string, projectId: string) => void };
    models: Array<{ buildings: Array<{ id: string; desks: Array<{ id: string; pose: string; marker: string | null }> }> }> = [];
    targets: unknown[] = [];
    hovered: Array<string | null> = [];
    destroyed = false;
    constructor(handlers: FakeOfficeScene['handlers']) {
      this.handlers = handlers;
      FakeOfficeScene.instances.push(this);
    }
    async mount(): Promise<void> {}
    destroy(): void {
      this.destroyed = true;
    }
    setModel(model: FakeOfficeScene['models'][number]): void {
      this.models.push(model);
    }
    focus(target: unknown): void {
      this.targets.push(target);
    }
    debugHover(id: string | null): void {
      this.hovered.push(id);
    }
    get desks() {
      return this.models.at(-1)?.buildings[0]?.desks ?? [];
    }
  }
  return {
    FakeOfficeScene,
    progressMock: vi.fn(),
    canMock: vi.fn((_resource: string, _action?: string) => true),
    monitorState: { current: { items: [] as unknown[], tabState: (_id: string): Tab | undefined => undefined } },
    narrowState: { current: false },
    chatMock: { setOpen: vi.fn() },
  };
});

vi.mock('../office/scene/OfficeScene', () => ({ OfficeScene: FakeOfficeScene }));
vi.mock('../lib/api', () => ({ api: { progress: (...a: unknown[]) => progressMock(...a) } }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: canMock }) }));
vi.mock('../lib/data', () => ({ useData: () => ({ statuses: { m1: 'online' } }) }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => monitorState.current }));
vi.mock('../lib/narrow-window', () => ({ useNarrowWindow: () => narrowState.current }));
vi.mock('../lib/project-chat', () => ({ useProjectChat: () => chatMock }));

import { DOUBLE_TAP_MS, OfficeEmptyState } from './OfficeEmptyState';

const project = { id: 'p1', name: 'termhub', status: 'active', machines: [] } as unknown as Project;
const machines = [{ id: 'm1', name: 'jarvis', subtitle: null }] as Machine[];
const terminal = (id: string, name: string, position: number, over: Partial<Tab> = {}): Tab =>
  ({ id, name, project_id: 'p1', machine_id: 'm1', kind: 'terminal', position, alive: true, state: 'working', state_at: '2026-10-04T10:00:00.000Z', state_seen_at: null, activity: null, activity_verb: null, rate_limited_at: null, ...over }) as Tab;

const agent = (tab_id: string, over: Partial<AgentOnCard> = {}): AgentOnCard => ({
  tab_id, tab_name: tab_id, machine_name: 'jarvis', subtask_ref: null, state: 'working', state_at: null, background: false, finished: false, needs_you: false, activity: null, activity_verb: null, rate_limited: false, ...over,
});
const card = (id: string, status: CardProgress['status'], agents: AgentOnCard[] = []): CardProgress =>
  ({ id, ref: id, title: id, type: 'task', status, column_name: null, units: { done: 0, total: 1 }, percent: 0, started_at: null, done_at: null, active_seconds: 0, estimate: { kind: 'none', reason: 'not_started' }, agents, pull_requests: [] }) as CardProgress;
const epic = (id: string, ref: string, title: string, cards: CardProgress[]): EpicProgress =>
  ({ id, ref, title, project: { id: 'p1', key: 'TER', name: 'termhub' }, units: { done: 0, total: 0, backlog_total: 0 }, percent: 0, estimate: { kind: 'none', reason: 'not_started' }, cards_without_estimate: 0, agents: null, cards, ci: null, ci_error: null }) as EpicProgress;

const onOpen = vi.fn();
const onNewTerminal = vi.fn();

function renderState(tabs: Tab[], over: { visible?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <OfficeEmptyState project={project} tabs={tabs} machines={machines} reachable visible={over.visible ?? true} onOpen={onOpen} onNewTerminal={onNewTerminal} />
    </MemoryRouter>,
  );
}

const scene = () => FakeOfficeScene.instances.at(-1)!;
const TABS = [terminal('t1', 'Ana', 0), terminal('t2', 'Bia', 1, { state: 'waiting_input' }), terminal('t3', 'Caio', 2, { state: 'idle' })];

beforeEach(() => {
  FakeOfficeScene.instances = [];
  progressMock.mockReset().mockResolvedValue({ epics: [], generated_at: '' });
  canMock.mockReset().mockReturnValue(true);
  monitorState.current = { items: [], tabState: () => undefined };
  narrowState.current = false;
  onOpen.mockReset();
  onNewTerminal.mockReset();
  chatMock.setOpen.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('OfficeEmptyState: the office when no tab is open (TER-912)', () => {
  it('draws the project as one building framed by the camera, one figure per terminal in its state', () => {
    renderState(TABS);
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(scene().targets).toEqual([{ kind: 'building', projectId: 'p1' }]);
    expect(scene().models.at(-1)!.buildings.map((b) => b.id)).toEqual(['p1']);
    expect(scene().desks.map((d) => [d.id, d.pose, d.marker])).toEqual([
      ['t1', 'type', null],
      ['t2', 'raise', 'input'],
      ['t3', 'sleep', null],
    ]);
  });

  it('follows the monitor live: a state pushed for a terminal changes its figure without a new read', () => {
    const { rerender } = renderState(TABS);
    const live = { ...TABS[0], state: 'waiting_permission' as const, state_at: '2026-10-04T11:00:00.000Z' };
    monitorState.current = { items: [{ tab: live }], tabState: (id) => (id === 't1' ? live : undefined) };
    rerender(
      <MemoryRouter>
        <OfficeEmptyState project={project} tabs={TABS} machines={machines} reachable visible onOpen={onOpen} onNewTerminal={onNewTerminal} />
      </MemoryRouter>,
    );
    expect(scene().desks[0]).toMatchObject({ id: 't1', pose: 'raise', marker: 'permission' });
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(within(screen.getByRole('list', { name: 'Terminais do projeto' })).getByRole('button', { name: /Ana/ })).toHaveTextContent('pedindo permissão');
  });

  it('a tap on a figure previews its terminal once the double-tap window passes; two taps pin it', () => {
    vi.useFakeTimers();
    renderState(TABS);
    act(() => scene().handlers.onPickDesk('t2', 'p1'));
    expect(onOpen).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(DOUBLE_TAP_MS));
    expect(onOpen).toHaveBeenCalledWith('t2', 'preview');

    onOpen.mockReset();
    act(() => scene().handlers.onPickDesk('t1', 'p1'));
    act(() => vi.advanceTimersByTime(DOUBLE_TAP_MS / 2));
    act(() => scene().handlers.onPickDesk('t1', 'p1'));
    act(() => vi.advanceTimersByTime(DOUBLE_TAP_MS * 2));
    expect(onOpen.mock.calls).toEqual([['t1', 'pin']]);
  });

  it('taps on two different figures preview the second one only', () => {
    vi.useFakeTimers();
    renderState(TABS);
    act(() => scene().handlers.onPickDesk('t1', 'p1'));
    act(() => scene().handlers.onPickDesk('t3', 'p1'));
    act(() => vi.advanceTimersByTime(DOUBLE_TAP_MS));
    expect(onOpen.mock.calls).toEqual([['t3', 'preview']]);
  });

  it('keeps a text list of the terminals with their state: a mouse double click pins, the keyboard previews at once', () => {
    vi.useFakeTimers();
    renderState(TABS);
    const list = screen.getByRole('list', { name: 'Terminais do projeto' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['Anatrabalhando', 'Biaesperando você', 'Caioparado']);

    const bia = within(list).getByRole('button', { name: /Bia/ });
    fireEvent.click(bia, { detail: 1 });
    fireEvent.click(bia, { detail: 2 });
    act(() => vi.advanceTimersByTime(DOUBLE_TAP_MS));
    expect(onOpen.mock.calls).toEqual([['t2', 'pin']]);

    onOpen.mockReset();
    fireEvent.click(within(list).getByRole('button', { name: /Caio/ }), { detail: 0 });
    expect(onOpen.mock.calls).toEqual([['t3', 'preview']]);
  });

  it('hovering a terminal in the list lights up its figure', () => {
    renderState(TABS);
    const ana = within(screen.getByRole('list', { name: 'Terminais do projeto' })).getByRole('button', { name: /Ana/ });
    fireEvent.mouseEnter(ana);
    fireEvent.mouseLeave(ana);
    expect(scene().hovered).toEqual(['t1', null]);
  });

  it('a project with no terminal shows the empty office and invites to open one or ask for an agent', () => {
    renderState([]);
    expect(scene().desks).toEqual([]);
    expect(screen.queryByRole('list', { name: 'Terminais do projeto' })).toBeNull();
    // nothing to list beside it: the office takes the whole width
    expect(screen.queryByRole('complementary', { name: 'Resumo do projeto' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Abrir terminal/ }));
    expect(onNewTerminal).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Pedir um agente ao concierge' }));
    expect(chatMock.setOpen).toHaveBeenCalledWith('p1', true);
  });

  it('on a phone-sized window draws no scene: the list is the content', () => {
    narrowState.current = true;
    renderState(TABS);
    expect(FakeOfficeScene.instances).toHaveLength(0);
    expect(screen.getByRole('list', { name: 'Terminais do projeto' })).toBeInTheDocument();
  });

  it('draws no scene while the project shows another section', () => {
    renderState(TABS, { visible: false });
    expect(FakeOfficeScene.instances).toHaveLength(0);
  });

  describe('epics in progress', () => {
    const EPICS = [
      // a card in Fazendo, one done, one waiting on the person
      epic('e1', 'TER-1', 'Escritório', [card('c1', 'done'), card('c2', 'doing', [agent('t1')]), card('c3', 'todo', [agent('t2', { state: 'waiting_input', needs_you: true })])]),
      // nothing going on: left out
      epic('e2', 'TER-2', 'Parado', [card('c4', 'todo'), card('c5', 'done')]),
      // no card in Fazendo, but an agent at work on one
      epic('e3', 'TER-3', 'Agente sozinho', [card('c6', 'todo', [agent('t3')])]),
    ];

    it('shows each epic with something going on: cards done over total, in progress, waiting for you, its agents and a link to it on the board', async () => {
      progressMock.mockResolvedValue({ epics: EPICS, generated_at: '' });
      renderState(TABS);
      const list = await screen.findByRole('list', { name: 'Épicos em andamento' });
      expect(progressMock).toHaveBeenCalledWith({ project_id: 'p1', scope: 'all' });
      const rows = within(list).getAllByRole('listitem');
      expect(rows).toHaveLength(2);

      const first = rows[0];
      expect(within(first).getByRole('link', { name: 'Escritório' })).toHaveAttribute('href', '/project/TER-1');
      expect(within(first).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33');
      expect(first).toHaveTextContent('1/3');
      expect(first).toHaveTextContent('1 em andamento · 1 esperando você');
      expect(within(first).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Abrir t1 (trabalhando)', 'Abrir t2 (esperando você)']);

      expect(rows[1]).toHaveTextContent('Agente sozinho');
      expect(rows[1]).toHaveTextContent('0 em andamento');
    });

    it("an agent's chip lights up its figure on hover and opens its terminal on click", async () => {
      progressMock.mockResolvedValue({ epics: EPICS, generated_at: '' });
      renderState(TABS);
      const chip = await screen.findByRole('button', { name: 'Abrir t1 (trabalhando)' });
      fireEvent.mouseEnter(chip);
      expect(scene().hovered.at(-1)).toBe('t1');
      fireEvent.click(chip);
      expect(onOpen).toHaveBeenCalledWith('t1', 'preview');
    });

    it("takes the agents' state from the monitor: an agent that finished leaves the epic, and with nothing in Fazendo the epic goes", async () => {
      const finished = terminal('t3', 'Caio', 2, { state: 'idle', state_at: '2026-10-04T12:00:00.000Z' });
      monitorState.current = { items: [{ tab: finished }], tabState: (id) => (id === 't3' ? finished : undefined) };
      progressMock.mockResolvedValue({ epics: EPICS, generated_at: '' });
      renderState(TABS);
      const list = await screen.findByRole('list', { name: 'Épicos em andamento' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
      expect(within(list).queryByText('Agente sozinho')).toBeNull();
    });

    it('reads the board again on the progress panel’s pace, so a card that moved shows up', async () => {
      vi.useFakeTimers();
      progressMock.mockResolvedValue({ epics: [], generated_at: '' });
      renderState(TABS);
      await act(async () => {});
      expect(screen.queryByRole('list', { name: 'Épicos em andamento' })).toBeNull();
      progressMock.mockResolvedValue({ epics: EPICS, generated_at: '' });
      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      vi.useRealTimers();
      await waitFor(() => expect(screen.getByRole('list', { name: 'Épicos em andamento' })).toBeInTheDocument());
    });

    it('is not read without access to the board', () => {
      canMock.mockImplementation((resource: string) => resource !== 'tasks');
      renderState(TABS);
      expect(progressMock).not.toHaveBeenCalled();
    });
  });
});
