// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, MonitorItem, Project, ProjectGroup, Tab } from '../lib/types';

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  machines: [] as Machine[],
  /** every open terminal tab (the sidebar's source) */
  openTabs: [] as Tab[],
  /** tabs that reported a state (what the sidebar used to read): must not drive it */
  items: [] as MonitorItem[],
}));

const auth = vi.hoisted(() => ({ canChat: true, canCreateProjects: true, canDeleteTerminals: true }));
const apiMock = vi.hoisted(() => ({ remove: vi.fn(async (_id: string) => ({ ok: true, killed: true })) }));
vi.mock('../lib/api', () => ({
  api: { tabs: { remove: apiMock.remove } },
  ApiError: class ApiError extends Error {},
}));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Pedro', avatar_url: null, email: 'pedro@example.com' },
    logout: vi.fn(),
    can: (resource: string, action?: string) =>
      resource === 'chat'
        ? auth.canChat
        : resource === 'projects' && action === 'create'
          ? auth.canCreateProjects
          : resource === 'terminals' && action === 'delete'
            ? auth.canDeleteTerminals
            : true,
    viewAs: 'self',
  }),
}));
const chat = vi.hoisted(() => ({
  currentProjectId: null as string | null,
  openIds: [] as string[],
  pref: (id: string) => ({ open: chat.openIds.includes(id), width: 420, maximized: false }),
  setOpen: vi.fn(),
  toggle: vi.fn(),
  status: vi.fn((_id: string) => ({ busy: false, pending: 0 })),
}));
vi.mock('../lib/project-chat', () => ({ useProjectChat: () => chat }));
const groupsState = vi.hoisted(() => ({
  groups: [] as import('../lib/types').ProjectGroup[],
  error: null as string | null,
  createGroup: vi.fn(async (_name: string) => null as import('../lib/types').ProjectGroup | null),
  renameGroup: vi.fn(async (_id: string, _name: string) => {}),
  deleteGroup: vi.fn(async (_id: string) => {}),
  reorderGroups: vi.fn(async () => {}),
  setMemberships: vi.fn(async () => {}),
  reload: vi.fn(async () => {}),
  toggleFavorite: vi.fn(async (_id: string) => {}),
  isFavorite: (id: string): boolean => groupsState.groups.some((g) => g.kind === 'favorites' && g.project_ids.includes(id)),
}));
vi.mock('../lib/project-groups', () => ({ useProjectGroups: () => groupsState }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ items: state.items, openTabs: state.openTabs, needsYou: [] }) }));
vi.mock('../lib/data', () => ({
  useData: () => ({
    machines: state.machines,
    projects: state.projects,
    hiddenLocal: [],
    claimLocal: vi.fn(),
    statuses: {},
    missingTmux: {},
    loading: false,
    deleteProject: vi.fn(),
    checkStatus: vi.fn(),
    machinesOf: (p: Project) => p.machines.map((l) => state.machines.find((m) => m.id === l.machine_id)).filter(Boolean),
  }),
}));

import { Sidebar } from './Sidebar';
import { getEditorTabs, onTerminalEnded, resetEditorTabsCache, updateEditorTabs } from '../lib/editor-tabs';

const machine = (id: string, name: string) => ({ id, name, type: 'agent', capabilities: [], is_local: false, os: null, owner_name: null }) as unknown as Machine;
const project = (id: string, name: string, over: Partial<Project> = {}): Project =>
  ({ id, key: name.toUpperCase(), name, status: 'active', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }], ...over }) as Project;
const openTab = (id: string, name: string, p: Project, machineId: string, over: Partial<Tab> = {}): Tab =>
  ({ id, name, project_id: p.id, machine_id: machineId, kind: 'terminal', position: 0, state: 'working', state_at: '2026-09-23T10:00:00.000Z', state_seen_at: null, ...over }) as Tab;

const TWO_MACHINES = [
  { machine_id: 'm1', cwd: '/a', position: 0 },
  { machine_id: 'm2', cwd: '/a', position: 1 },
];

/** alpha: running (two machines) · beta: running (one machine) · gamma: idle · omega: archived. */
function seed() {
  state.machines = [machine('m1', 'mac'), machine('m2', 'jarvis')];
  const alpha = project('p1', 'alpha', { machines: TWO_MACHINES });
  const beta = project('p2', 'beta');
  const gamma = project('p3', 'gamma');
  const omega = project('p5', 'omega', { status: 'archived' });
  state.projects = [alpha, beta, gamma, omega];
  state.openTabs = [
    // out of position order on purpose: rows follow tab.position
    openTab('t2', 'Bia', alpha, 'm1', { position: 1 }),
    openTab('t1', 'Ana', alpha, 'm2', { position: 0, state: 'waiting_input' }),
    // never reported a state (no monitor hooks, or nothing ran yet): still an open agent
    openTab('t3', 'Caio', beta, 'm1', { state: null, state_at: null }),
  ];
  state.items = [];
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}
function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
      <Where />
    </MemoryRouter>,
  );
}

const section = (name: string) => screen.getByRole('region', { name });
/** A project's agent list inside a section; the list is named after both, since a running project shows in two. */
const agentsOf = (container: HTMLElement, projectName: string) =>
  within(container).queryByRole('list', { name: `Agentes de ${projectName} · ${container.getAttribute('aria-label')}` });

beforeEach(() => {
  seed();
  localStorage.clear();
  resetEditorTabsCache();
  apiMock.remove.mockClear();
});
afterEach(() => {
  cleanup();
  groupsState.groups = [];
  groupsState.error = null;
  auth.canChat = true;
  auth.canCreateProjects = true;
  auth.canDeleteTerminals = true;
  chat.currentProjectId = null;
  chat.openIds = [];
  vi.clearAllMocks();
  chat.status.mockImplementation(() => ({ busy: false, pending: 0 }));
});

describe('Sidebar sections', () => {
  it('puts running projects in "Em execução" and every ungrouped project in "Outros" — a running project in both', () => {
    renderSidebar();
    const running = section('Em execução');
    expect(within(running).getByRole('link', { name: /alpha/ })).toBeInTheDocument();
    expect(within(running).getByRole('link', { name: /beta/ })).toBeInTheDocument();
    expect(within(running).queryByRole('link', { name: /gamma/ })).not.toBeInTheDocument();

    const all = section('Outros');
    expect(within(all).getAllByRole('link', { name: /^[A-Z]+ [a-z]+/ }).map((l) => l.textContent)).toEqual(['ALPHAalpha', 'BETAbeta', 'GAMMAgamma']);
    expect(within(all).queryByRole('link', { name: /omega/ })).not.toBeInTheDocument(); // archived, hidden by default
  });

  it('collapses "Em execução" like any other section, and remembers it', () => {
    renderSidebar();
    fireEvent.click(within(section('Em execução')).getByRole('button', { name: 'Recolher Em execução' }));
    expect(within(section('Em execução')).queryByRole('link', { name: /alpha/ })).not.toBeInTheDocument();
    expect(within(section('Em execução')).getByRole('button', { name: 'Expandir Em execução' })).toHaveAttribute('aria-expanded', 'false');
    // the project itself is not collapsed: Outros still lists it
    expect(within(section('Outros')).getByRole('link', { name: /alpha/ })).toBeInTheDocument();

    cleanup();
    renderSidebar();
    expect(within(section('Em execução')).queryByRole('link', { name: /alpha/ })).not.toBeInTheDocument();
  });

  it('hides "Em execução" when nothing is running', () => {
    state.openTabs = [];
    renderSidebar();
    expect(screen.queryByRole('region', { name: 'Em execução' })).not.toBeInTheDocument();
    expect(within(section('Outros')).getByRole('link', { name: /alpha/ })).toBeInTheDocument();
    expect(screen.getByText('Projetos')).toBeInTheDocument();
  });

  it('offers no "+ novo projeto" to a user who cannot create projects', () => {
    state.projects = [];
    state.openTabs = [];
    auth.canCreateProjects = false;
    renderSidebar();
    expect(screen.queryByRole('button', { name: '+ novo projeto' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ novo' })).toBeNull();
  });

  it('shows the empty state when there are no projects', () => {
    state.projects = [];
    state.openTabs = [];
    renderSidebar();
    expect(screen.getByRole('button', { name: '+ novo projeto' })).toBeInTheDocument();
    // Outros always renders: it is where a project is dropped to leave its groups
    const others = section('Outros');
    expect(within(others).getByText('· 0')).toBeInTheDocument();
    expect(within(others).queryByText('arraste projetos para cá')).toBeNull();
  });

  it('keeps an empty Outros when every project is in a group', () => {
    state.projects = state.projects.filter((p) => p.status !== 'archived');
    groupsState.groups = [custom('g1', 'Tudo', 0, ['p1', 'p2', 'p3'])];
    renderSidebar();
    expect(within(section('Outros')).getByText('· 0')).toBeInTheDocument();
    expect(within(section('Outros')).getByRole('button', { name: 'Recolher Outros' })).toBeInTheDocument();
  });

  it('"Mostrar arquivados" applies to every section', () => {
    state.openTabs = [...state.openTabs, openTab('t9', 'Duda', state.projects[3], 'm1')]; // an archived project with a running tab
    renderSidebar();
    expect(screen.queryByRole('link', { name: /omega/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar arquivados' }));
    expect(within(section('Outros')).getByRole('link', { name: /omega/ })).toBeInTheDocument();
    expect(within(section('Em execução')).getByRole('link', { name: /omega/ })).toBeInTheDocument();
  });

  it('keeps the project actions (chat, edit) next to the pin and the Grupos… button; delete lives in the project settings', () => {
    renderSidebar();
    const all = section('Outros');
    expect(within(all).getAllByRole('button', { name: 'Chat do projeto' })).toHaveLength(3);
    expect(within(all).getAllByTitle('Editar projeto')).toHaveLength(3);
    expect(within(all).queryByTitle(/Excluir projeto/)).toBeNull();
    expect(within(all).getAllByRole('button', { name: 'Fixar em Favoritos' })).toHaveLength(3);
    expect(within(all).getAllByTitle('Grupos…')).toHaveLength(3);
    expect(within(all).getAllByTitle('Grupos…')[0]).toHaveAttribute('aria-haspopup', 'menu');
  });
});

describe('Sidebar agent rows', () => {
  it('lists each project\'s terminals under the machine each runs on, machines in link order, terminals by position', () => {
    renderSidebar();
    const running = section('Em execução');
    const alpha = agentsOf(running, 'alpha')!;
    expect(within(within(alpha).getByRole('list', { name: 'Terminais em mac' })).getAllByRole('link').map((r) => r.textContent)).toEqual(['Bia']);
    expect(within(within(alpha).getByRole('list', { name: 'Terminais em jarvis' })).getAllByRole('link').map((r) => r.textContent)).toEqual(['Ana']);
    // machine headings come in link order (mac is linked first), not in tab order
    expect(within(alpha).getAllByRole('list').map((l) => l.getAttribute('aria-label'))).toEqual(['Terminais em mac', 'Terminais em jarvis']);

    // one machine: its heading still says where the terminal runs
    const beta = agentsOf(running, 'beta')!;
    expect(within(beta).getByRole('list', { name: 'Terminais em mac' })).toBeInTheDocument();
    expect(within(beta).getByRole('link').textContent).toBe('Caio');
  });

  it('keeps a long terminal name and a long machine name inside the sidebar width', () => {
    renderSidebar();
    const alpha = agentsOf(section('Em execução'), 'alpha')!;
    expect(within(alpha).getByText('Ana')).toHaveClass('min-w-0', 'truncate');
    expect(within(alpha).getByText('jarvis')).toHaveClass('truncate');
  });

  it('names each agent list after its section too, so a running project\'s two lists are told apart', () => {
    renderSidebar();
    const names = screen.getAllByRole('list', { name: /^Agentes de alpha/ }).map((l) => l.getAttribute('aria-label'));
    expect(names).toEqual(['Agentes de alpha · Em execução', 'Agentes de alpha · Outros']);
    const toggles = screen.getAllByRole('button', { name: 'Recolher agentes de alpha' });
    expect(toggles.map((b) => document.getElementById(b.getAttribute('aria-controls')!)?.getAttribute('aria-label'))).toEqual(names);
  });

  it('links each agent to its tab in the project view', () => {
    renderSidebar();
    const alpha = agentsOf(section('Em execução'), 'alpha')!;
    expect(within(alpha).getByRole('link', { name: /Ana/ })).toHaveAttribute('href', '/projects/p1?tab=t1');
    expect(within(alpha).getByRole('link', { name: /Bia/ })).toHaveAttribute('href', '/projects/p1?tab=t2');
  });

  it('colours the dot with the tab state: the pulsing attention colour when it needs you', () => {
    renderSidebar();
    const alpha = agentsOf(section('Em execução'), 'alpha')!;
    const dot = (name: RegExp) => within(alpha).getByRole('link', { name }).querySelector('[data-dot]')!;
    expect(dot(/Ana/)).toHaveClass('bg-attention', 'animate-pulse');
    expect(dot(/Bia/)).toHaveClass('bg-ok');
    expect(dot(/Bia/)).not.toHaveClass('bg-attention');
    const caio = within(agentsOf(section('Em execução'), 'beta')!).getByRole('link', { name: /Caio/ }).querySelector('[data-dot]')!;
    expect(caio).toHaveClass('bg-ok'); // no state reported: the neutral dot the tab bar shows for a live tab
  });

  it('reads the open tabs, not the tabs that reported a state', () => {
    state.openTabs = [];
    state.items = [{ tab: openTab('t1', 'Ana', state.projects[0], 'm1'), project: state.projects[0], machine: state.machines[0] }];
    renderSidebar();
    expect(screen.queryByRole('region', { name: 'Em execução' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ana/ })).not.toBeInTheDocument();
  });

  it('a project without open tabs has no agent list and no chevron', () => {
    renderSidebar();
    const all = section('Outros');
    expect(agentsOf(all, 'gamma')).toBeNull();
    expect(within(all).queryByRole('button', { name: /agentes de gamma/ })).not.toBeInTheDocument();
    expect(within(all).getByRole('button', { name: 'Recolher agentes de alpha' })).toBeInTheDocument();
  });

  it('collapsing a project collapses it in every section, and it is remembered', () => {
    renderSidebar();
    fireEvent.click(within(section('Outros')).getByRole('button', { name: 'Recolher agentes de alpha' }));
    expect(agentsOf(section('Outros'), 'alpha')).toBeNull();
    expect(agentsOf(section('Em execução'), 'alpha')).toBeNull();
    expect(agentsOf(section('Em execução'), 'beta')).not.toBeNull();

    cleanup();
    renderSidebar();
    expect(agentsOf(section('Em execução'), 'alpha')).toBeNull();
    expect(within(section('Em execução')).getByRole('button', { name: 'Expandir agentes de alpha' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('still works when browser storage throws (private mode, blocked site data)', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderSidebar();
      expect(agentsOf(section('Em execução'), 'alpha')).not.toBeNull(); // default: expanded
      fireEvent.click(within(section('Em execução')).getByRole('button', { name: 'Recolher agentes de alpha' }));
      expect(agentsOf(section('Em execução'), 'alpha')).toBeNull();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('no longer lists machines under projects', () => {
    renderSidebar();
    expect(screen.queryByText(/sem máquina/)).not.toBeInTheDocument();
    expect(screen.queryByTitle('Editar')).not.toBeInTheDocument();
  });
});

describe('Sidebar collapse/expand all', () => {
  it('collapses every project with agents when any is expanded, then expands them all', () => {
    renderSidebar();
    const running = () => section('Em execução');
    // one already collapsed, the other expanded: "any expanded" still means collapse all
    fireEvent.click(within(running()).getByRole('button', { name: 'Recolher agentes de beta' }));
    const all = screen.getByRole('button', { name: 'Recolher todos' });
    expect(all).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(all);
    expect(screen.getByRole('button', { name: 'Expandir todos' })).toHaveAttribute('aria-expanded', 'false');
    expect(agentsOf(running(), 'alpha')).toBeNull();
    expect(agentsOf(running(), 'beta')).toBeNull();
    expect(agentsOf(section('Outros'), 'alpha')).toBeNull(); // the same project, collapsed everywhere

    fireEvent.click(screen.getByRole('button', { name: 'Expandir todos' }));
    expect(agentsOf(running(), 'alpha')).not.toBeNull();
    expect(agentsOf(running(), 'beta')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Recolher todos' })).toHaveAttribute('title', 'Recolher todos');
  });

  it('is hidden when no project has agents', () => {
    state.openTabs = [];
    renderSidebar();
    expect(screen.queryByRole('button', { name: /(Recolher|Expandir) todos/ })).not.toBeInTheDocument();
  });
});

describe('Sidebar footer', () => {
  it('has a "Máquinas" nav link to /machines and a single "Novo projeto" add button', () => {
    renderSidebar();
    const machinesLink = screen.getByRole('link', { name: /Máquinas/ });
    expect(machinesLink).toHaveAttribute('href', '/machines');
    expect(screen.getByTitle('Novo projeto')).toBeInTheDocument();
    expect(screen.queryByText('+ máquina')).not.toBeInTheDocument();
  });

  it('shows the daily menus with icons, Escritório first', () => {
    renderSidebar();
    const links = within(screen.getByRole('navigation', { name: 'Menu principal' })).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Escritório', 'Chat', 'Máquinas']);
    expect(links[0].querySelector('svg')).not.toBeNull();
  });

  it('ends with the profile row, which opens Perfil', () => {
    let where = '';
    function Where() {
      where = useLocation().pathname;
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar />
        <Where />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /configurações e perfil/ }));
    expect(where).toBe('/settings/profile');
  });

  it('no longer carries Ver como, Integrações, Configurações, Cookies or Sair', () => {
    renderSidebar();
    for (const name of [/Ver como/, /Integrações/, /^Configurações$/, /Cookies/, /^Sair$/]) {
      expect(screen.queryByRole('link', { name })).toBeNull();
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('collapses with a line icon', () => {
    render(
      <MemoryRouter>
        <Sidebar onCollapse={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Recolher sidebar' }).querySelector('svg')).not.toBeNull();
  });
});

const fav = (ids: string[] = []): ProjectGroup => ({ id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: ids });
const custom = (id: string, name: string, position: number, ids: string[] = []): ProjectGroup => ({ id, name, kind: 'custom', position, project_ids: ids });

describe('Sidebar groups', () => {
  it('gives every section a unique accessible name, even when group names repeat or match Outros/Em execução', () => {
    groupsState.groups = [fav(), custom('g1', 'Clientes', 1, ['p1']), custom('g2', 'Clientes', 2, ['p1']), custom('g3', 'Outros', 3, ['p1']), custom('g4', 'Em execução', 4)];
    renderSidebar();
    const labels = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(labels).toEqual(['Em execução', 'Favoritos', 'Clientes', 'Clientes (2)', 'Outros (2)', 'Em execução (2)', 'Outros']);
    // the visible names stay as the user typed them
    expect(within(section('Clientes (2)')).getByText('Clientes', { selector: 'span' })).toBeInTheDocument();
    const lists = screen.getAllByRole('list', { name: /^Agentes de alpha/ }).map((l) => l.getAttribute('aria-label'));
    expect(new Set(lists).size).toBe(lists.length);
    expect(lists).toContain('Agentes de alpha · Clientes (2)');
    const toggles = screen.getAllByRole('button', { name: /^Recolher Clientes/ }).map((b) => b.getAttribute('aria-label'));
    expect(toggles).toEqual(['Recolher Clientes', 'Recolher Clientes (2)']);
  });

  it('renders sections in order: Em execução, Favoritos, custom groups, Outros', () => {
    groupsState.groups = [fav(['p1']), custom('g1', 'Clientes', 1, ['p1', 'p2'])];
    renderSidebar(); // alpha (p1) and beta (p2) have open tabs
    const labels = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(labels).toEqual(['Em execução', 'Favoritos', 'Clientes', 'Outros']);
    expect(within(section('Clientes')).getAllByRole('link', { name: /^[A-Z]+ [a-z]+/ }).map((l) => l.textContent)).toEqual(['ALPHAalpha', 'BETAbeta']);
    expect(within(section('Outros')).queryByRole('link', { name: /alpha/ })).toBeNull();
    expect(within(section('Outros')).getByRole('link', { name: /gamma/ })).toBeInTheDocument();
    // a project in two groups shows in both, each row with its own agent list
    expect(agentsOf(section('Favoritos'), 'alpha')).not.toBeNull();
    expect(agentsOf(section('Clientes'), 'alpha')).not.toBeNull();
  });

  it('the pin toggles Favoritos and is pressed for favorites', () => {
    groupsState.groups = [fav(['p1'])];
    renderSidebar();
    expect(within(section('Favoritos')).getByRole('button', { name: 'Tirar de Favoritos' })).toHaveAttribute('aria-pressed', 'true');
    const pin = within(section('Outros')).getAllByRole('button', { name: 'Fixar em Favoritos' })[0];
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pin);
    expect(groupsState.toggleFavorite).toHaveBeenCalledWith('p2');
  });

  it('Outros is an accordion with a count and keeps its state', () => {
    renderSidebar();
    expect(within(section('Outros')).getByText('· 3')).toBeInTheDocument();
    const toggle = within(section('Outros')).getByRole('button', { name: 'Recolher Outros' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(localStorage.getItem('termhub:sidebar:collapsed-groups')).toContain('others');
    expect(within(section('Outros')).queryByRole('link', { name: /gamma/ })).toBeNull();

    cleanup();
    renderSidebar();
    expect(within(section('Outros')).getByRole('button', { name: 'Expandir Outros' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(section('Outros')).queryByRole('link', { name: /gamma/ })).toBeNull();
  });

  it('a group collapses on its own', () => {
    groupsState.groups = [custom('g1', 'Clientes', 1, ['p3'])];
    renderSidebar();
    fireEvent.click(within(section('Clientes')).getByRole('button', { name: 'Recolher Clientes' }));
    expect(within(section('Clientes')).queryByRole('link', { name: /gamma/ })).toBeNull();
    expect(within(section('Outros')).getByRole('link', { name: /alpha/ })).toBeInTheDocument();
  });

  it('keeps the archived toggle inside Outros', () => {
    renderSidebar();
    expect(within(section('Outros')).getByRole('button', { name: 'Mostrar arquivados' })).toBeInTheDocument();
  });

  it('renames and deletes a custom group, never Favoritos', async () => {
    groupsState.groups = [fav(), custom('g1', 'Clientes', 1)];
    renderSidebar();
    expect(within(section('Favoritos')).queryByTitle('Renomear grupo')).toBeNull();
    expect(within(section('Favoritos')).queryByTitle('Excluir grupo')).toBeNull();
    const g1 = section('Clientes');
    fireEvent.click(within(g1).getByTitle('Renomear grupo'));
    const input = within(g1).getByRole('textbox');
    fireEvent.change(input, { target: { value: '  Trabalho ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(groupsState.renameGroup).toHaveBeenCalledWith('g1', 'Trabalho');
    expect(groupsState.renameGroup).toHaveBeenCalledTimes(1);
    expect(within(g1).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(g1).getByTitle('Excluir grupo'));
    expect(screen.getByText(/Os projetos não são apagados/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(groupsState.deleteGroup).toHaveBeenCalledWith('g1'));
  });

  it('Esc cancels a rename and an empty name is not saved', () => {
    groupsState.groups = [custom('g1', 'Clientes', 1)];
    renderSidebar();
    const g1 = section('Clientes');
    fireEvent.click(within(g1).getByTitle('Renomear grupo'));
    fireEvent.change(within(g1).getByRole('textbox'), { target: { value: 'Outro nome' } });
    fireEvent.keyDown(within(g1).getByRole('textbox'), { key: 'Escape' });
    expect(within(g1).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(g1).getByTitle('Renomear grupo'));
    fireEvent.change(within(g1).getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.keyDown(within(g1).getByRole('textbox'), { key: 'Enter' });
    expect(groupsState.renameGroup).not.toHaveBeenCalled();
  });

  it('an empty group shows the drop hint', () => {
    groupsState.groups = [custom('g1', 'Vazio', 0)];
    renderSidebar();
    expect(within(section('Vazio')).getByText('arraste projetos para cá')).toBeInTheDocument();
  });

  it('+ grupo creates "Novo grupo" and opens its rename input', async () => {
    groupsState.createGroup.mockImplementationOnce(async (name: string) => {
      const g = custom('g9', name, 1);
      groupsState.groups = [...groupsState.groups, g];
      return g;
    });
    const view = renderSidebar();
    fireEvent.click(screen.getByTitle('Novo grupo'));
    expect(groupsState.createGroup).toHaveBeenCalledWith('Novo grupo');
    await waitFor(() => expect(groupsState.groups).toHaveLength(1));
    view.rerender(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    await waitFor(() => expect(within(section('Novo grupo')).getByRole('textbox')).toHaveValue('Novo grupo'));
  });

  it('the Grupos… button opens the groups menu for that project', () => {
    groupsState.groups = [fav(), custom('g1', 'Clientes', 1, ['p3'])];
    renderSidebar();
    fireEvent.click(within(section('Clientes')).getByTitle('Grupos…'));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Clientes/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('the row actions show while the row has keyboard focus', () => {
    renderSidebar();
    const others = section('Outros');
    const link = within(others).getByRole('link', { name: /gamma/ });
    link.focus();
    const dots = within(link.closest('li')!).getByTitle('Grupos…');
    // the hover-only span also shows on focus-within, so Tab reaches the pin and ⋯
    expect(dots.parentElement).toHaveClass('group-focus-within/p:flex');
    dots.focus();
    expect(dots).toHaveFocus();
  });

  it('the menu focuses its first item, and Esc returns focus to the ⋯ button', () => {
    groupsState.groups = [fav(), custom('g1', 'Clientes', 1, ['p3'])];
    renderSidebar();
    const dots = within(section('Clientes')).getByTitle('Grupos…');
    dots.focus();
    fireEvent.click(dots);
    expect(within(screen.getByRole('menu')).getAllByRole('menuitemcheckbox')[0]).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(dots).toHaveFocus();
  });

  it('⋯ of the same project in another section moves the menu instead of closing it; ⋯ on the same button closes it', () => {
    groupsState.groups = [fav(), custom('g1', 'Clientes', 1, ['p1'])];
    renderSidebar();
    fireEvent.click(within(section('Clientes')).getByTitle('Grupos…'));
    fireEvent.click(within(section('Em execução')).getAllByTitle('Grupos…')[0]); // alpha again, other row
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(within(section('Em execução')).getAllByTitle('Grupos…')[0]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('switching the menu to another project starts it fresh', () => {
    groupsState.groups = [fav(), custom('g1', 'Clientes', 1, ['p1'])];
    renderSidebar();
    fireEvent.click(within(section('Clientes')).getByTitle('Grupos…'));
    fireEvent.click(screen.getByText('Novo grupo…'));
    expect(within(screen.getByRole('menu')).getByRole('textbox')).toBeInTheDocument();
    fireEvent.click(within(section('Outros')).getAllByTitle('Grupos…')[0]); // beta
    expect(within(screen.getByRole('menu')).queryByRole('textbox')).toBeNull();
  });

  it('shows the groups error', () => {
    groupsState.error = 'Não foi possível salvar os grupos. Tente de novo.';
    renderSidebar();
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível salvar');
  });
});

describe('Sidebar project chat', () => {
  const rowOf = (name: string) => within(section('Outros')).getByRole('link', { name: new RegExp(name) }).closest('li')!;

  it('💬 on another project opens its chat and goes to it', () => {
    chat.currentProjectId = 'p1';
    renderSidebar();
    fireEvent.click(within(rowOf('gamma')).getByRole('button', { name: 'Chat do projeto' }));
    expect(chat.setOpen).toHaveBeenCalledWith('p3', true);
    expect(chat.toggle).not.toHaveBeenCalled();
    expect(screen.getByTestId('where').textContent).toBe('/projects/p3');
  });

  it('keeps the 💬 shown without hover, with a dot, while that chat is answering or waiting', () => {
    chat.status.mockImplementation((id: string) => (id === 'p3' ? { busy: false, pending: 1 } : { busy: false, pending: 0 }));
    renderSidebar();
    const button = within(rowOf('gamma')).getByRole('button', { name: 'Chat do projeto' });
    expect(button).toHaveAttribute('data-active', 'true');
    // outside the hover-only actions: its container is not the hidden span
    expect(button.parentElement).not.toHaveClass('hidden');
    expect(within(rowOf('beta')).getByRole('button', { name: 'Chat do projeto' }).parentElement).toHaveClass('hidden');
  });

  it('💬 on the project on screen toggles its chat and stays', () => {
    chat.currentProjectId = 'p3';
    renderSidebar();
    fireEvent.click(within(rowOf('gamma')).getByRole('button', { name: 'Chat do projeto' }));
    expect(chat.toggle).toHaveBeenCalledWith('p3');
    expect(chat.setOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('keeps the 💬 shown without hover for every project whose chat is open', () => {
    chat.openIds = ['p3', 'p2'];
    renderSidebar();
    expect(within(rowOf('gamma')).getByRole('button', { name: 'Chat do projeto' }).parentElement).not.toHaveClass('hidden');
    expect(within(rowOf('beta')).getByRole('button', { name: 'Chat do projeto' }).parentElement).not.toHaveClass('hidden');
  });

  it('has no chat button without the chat permission', () => {
    auth.canChat = false;
    renderSidebar();
    expect(screen.queryByRole('button', { name: 'Chat do projeto' })).toBeNull();
  });
});

describe('Sidebar terminal list (TER-904)', () => {
  const alphaList = () => agentsOf(section('Em execução'), 'alpha')!;

  it('a double click pins the terminal\'s tab and opens the project on it', () => {
    renderSidebar();
    fireEvent.doubleClick(within(alphaList()).getByRole('link', { name: /Bia/ }));
    expect(getEditorTabs('p1')).toEqual({ open: ['t2'], preview: null });
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/p1');
  });

  it('a double click replaces the preview, like the click before it would have, and pins', () => {
    updateEditorTabs('p1', () => ({ open: ['t1'], preview: 't1' }));
    renderSidebar();
    fireEvent.doubleClick(within(alphaList()).getByRole('link', { name: /Bia/ }));
    expect(getEditorTabs('p1')).toEqual({ open: ['t2'], preview: null });
  });

  it('shows which terminals have an open tab, the preview one in italics', () => {
    updateEditorTabs('p1', () => ({ open: ['t1', 't2'], preview: 't2' }));
    renderSidebar();
    expect(within(alphaList()).getByText('Bia')).toHaveClass('italic');
    expect(within(alphaList()).getByText('Ana')).not.toHaveClass('italic');
    expect(within(alphaList()).getByRole('link', { name: /Ana/ })).toHaveClass('text-fg');
    expect(within(agentsOf(section('Em execução'), 'beta')!).getByRole('link', { name: /Caio/ })).toHaveClass('text-fg-muted');
  });

  it('says on the row that a terminal is waiting for you', () => {
    renderSidebar();
    expect(within(within(alphaList()).getByRole('link', { name: /Ana/ })).getByLabelText('esperando você')).toBeInTheDocument();
    expect(within(within(alphaList()).getByRole('link', { name: /Bia/ })).queryByLabelText('esperando você')).toBeNull();
  });

  it('the ✕ next to a working terminal asks first, then ends it and closes its tab', async () => {
    updateEditorTabs('p1', () => ({ open: ['t2'], preview: null }));
    const ended = vi.fn();
    const off = onTerminalEnded(ended);
    renderSidebar();
    fireEvent.click(within(alphaList()).getByRole('button', { name: 'Encerrar terminal Bia' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('que está trabalhando agora');
    expect(apiMock.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Encerrar terminal' }));
    await waitFor(() => expect(apiMock.remove).toHaveBeenCalledWith('t2'));
    await waitFor(() => expect(ended).toHaveBeenCalledWith('p1', 't2'));
    expect(getEditorTabs('p1')).toEqual({ open: [], preview: null });
    off();
  });

  it('cancelling the confirmation leaves the terminal alone', async () => {
    renderSidebar();
    fireEvent.click(within(alphaList()).getByRole('button', { name: 'Encerrar terminal Bia' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    expect(apiMock.remove).not.toHaveBeenCalled();
  });

  it('a terminal whose agent finished ends without asking', async () => {
    state.openTabs = state.openTabs.map((t) => (t.id === 't2' ? { ...t, state: 'idle' as const } : t));
    renderSidebar();
    fireEvent.click(within(alphaList()).getByRole('button', { name: 'Encerrar terminal Bia' }));
    await waitFor(() => expect(apiMock.remove).toHaveBeenCalledWith('t2'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the error when the terminal could not be ended', async () => {
    apiMock.remove.mockRejectedValueOnce(new Error('offline'));
    state.openTabs = state.openTabs.map((t) => (t.id === 't2' ? { ...t, state: 'idle' as const } : t));
    renderSidebar();
    fireEvent.click(within(alphaList()).getByRole('button', { name: 'Encerrar terminal Bia' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Erro ao encerrar o terminal');
  });

  it('has no ✕ without permission to close terminals', () => {
    auth.canDeleteTerminals = false;
    renderSidebar();
    expect(within(alphaList()).queryByRole('button', { name: /Encerrar terminal/ })).toBeNull();
  });
});
