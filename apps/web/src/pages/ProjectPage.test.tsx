// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project, User } from '../lib/types';

// vi.mock factories are hoisted above every other top-level statement, including this file's own
// `import { ProjectPage } from './ProjectPage'` below — everything a factory needs must come through
// vi.hoisted(), not a plain top-level const.
const { patchMock, dataState, authState } = vi.hoisted(() => {
  const patchMock = vi.fn(async (_id: string, input: Record<string, unknown>) => ({ ...input }));
  const dataState = {
    current: {
      projects: [] as Project[],
      machines: [] as Machine[],
      statuses: {} as Record<string, 'checking' | 'online' | 'offline'>,
      loading: false,
      updateProject: (id: string, input: Record<string, unknown>) => patchMock(id, input),
      machinesOf: (p: Project): Machine[] => p.machines.flatMap((l) => dataState.current.machines.filter((m) => m.id === l.machine_id)),
      refresh: async () => {},
    },
  };
  const authState = { current: { user: null as User | null } };
  return { patchMock, dataState, authState };
});

vi.mock('../lib/data', () => ({ useData: () => dataState.current }));
vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
// The rest of the page (terminals, tasks, tickets, notes, setup) is heavy — sockets, xterm, its own
// API calls — and none of it is this task's concern. Stubbed out so only the header and the publish
// control, which this test is about, render for real.
vi.mock('../components/TerminalsView', () => ({ TerminalsView: () => null }));
vi.mock('../components/TasksBoard', () => ({ TasksBoard: ({ openTaskId }: { openTaskId?: string }) => <div>board {openTaskId ?? ''}</div> }));
vi.mock('../components/BacklogView', () => ({ BacklogView: () => null }));
vi.mock('../components/TicketsView', () => ({ TicketsView: () => null }));
vi.mock('../components/NotesEditor', () => ({ NotesEditor: () => null }));
vi.mock('../components/ProjectSettings', () => ({ ProjectSettings: () => null }));

import { ProjectPage } from './ProjectPage';

function machine(id: string, name: string): Machine {
  return {
    id,
    name,
    host: null,
    ssh_user: null,
    ssh_port: 22,
    type: 'agent',
    os: 'macos',
    capabilities: [],
    checked_at: null,
    agent_version: null,
    agent_last_seen_at: null,
    agent_auto_update: false,
    claude_auto_swap: false,
    is_local: false,
    owner_id: 'u1',
    owner_name: 'pedro',
    created_at: '2026-01-01T00:00:00Z',
  };
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    owner_id: 'u1',
    key: 'MEU',
    next_task_number: 1,
    name: 'meu-projeto',
    status: 'active',
    description: null,
    last_terminal_at: null,
    created_at: '2026-01-01T00:00:00Z',
    machines: [{ machine_id: 'm1', cwd: '/home/pedro/meu-projeto', position: 0 }],
    is_public: false,
    ...over,
  };
}

function renderPage(proj: Project) {
  return render(
    <MemoryRouter initialEntries={[`/projects/${proj.id}`]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectPage />} />
        <Route path="/projects/:id/:section" element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  patchMock.mockReset();
  patchMock.mockImplementation(async (_id, input) => ({ ...input }));
  dataState.current = { ...dataState.current, machines: [machine('m1', 'jarvis')] };
  authState.current = { user: { id: 'u1', email: 'a@b.c', name: 'Pedro', avatar_url: null, role: 'owner', role_info: null, permissions: [], has_password: true, has_google: false, invited_at: null, last_login_at: null, nickname: 'pedro' } };
});

afterEach(() => {
  cleanup();
});

describe('ProjectPage publish switch', () => {
  it('says what publishing makes readable before it flips', async () => {
    const proj = project();
    dataState.current = { ...dataState.current, projects: [proj] };
    renderPage(proj);

    fireEvent.click(screen.getByRole('switch', { name: /publicar/i }));
    expect(screen.getByText(/o nome do projeto e cada agente \(aba\) dele que roda nas suas máquinas/i)).toBeTruthy();
    // city-by-project §5: an agent on somebody else's machine never shows, and the panel says so
    expect(screen.getByText(/agentes em máquinas de outras pessoas não aparecem/i)).toBeTruthy();
    // the owner's display name and nickname become public too
    expect(screen.getByText(/além do seu nome e apelido/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /publicar/i }));
    });
    expect(patchMock).toHaveBeenCalledWith(proj.id, expect.objectContaining({ is_public: true }));
  });

  it('asks for the nickname when the server says it is missing', async () => {
    const proj = project();
    dataState.current = { ...dataState.current, projects: [proj] };
    patchMock.mockRejectedValueOnce({ code: 'NICKNAME_REQUIRED' });
    renderPage(proj);

    fireEvent.click(screen.getByRole('switch', { name: /publicar/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /publicar/i }));
    });

    // The account here already has a nickname on the client, so the dialog opens in its read-only
    // form (a set nickname is never changed); what matters is that the refusal opens it at all.
    expect((await screen.findAllByText(/apelido/i)).length).toBeGreaterThan(0);
  });

  it('opens the nickname dialog straight away when the account has none yet, without asking the server', async () => {
    const proj = project();
    dataState.current = { ...dataState.current, projects: [proj] };
    authState.current = { user: { ...authState.current.user!, nickname: null } };
    renderPage(proj);

    fireEvent.click(screen.getByRole('switch', { name: /publicar/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /publicar/i }));
    });

    expect(await screen.findByLabelText(/apelido/i)).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('unpublishes immediately, without the confirmation panel', async () => {
    const proj = project({ is_public: true });
    dataState.current = { ...dataState.current, projects: [proj] };
    renderPage(proj);

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: /publicar/i }));
    });

    expect(patchMock).toHaveBeenCalledWith(proj.id, expect.objectContaining({ is_public: false }));
    expect(screen.queryByText(/o nome do projeto e cada agente \(aba\) dele que roda nas suas máquinas/i)).toBeNull();
  });

  it('says so when unpublishing fails, on the same path that bypasses the confirmation panel', async () => {
    const proj = project({ is_public: true });
    dataState.current = { ...dataState.current, projects: [proj] };
    patchMock.mockRejectedValueOnce(new Error('network down'));
    renderPage(proj);

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: /publicar/i }));
    });

    expect(screen.getByText('Erro ao despublicar')).toBeTruthy();
  });

  it('keeps the switch reading "off" to a screen reader while the confirmation is still pending', async () => {
    const proj = project();
    dataState.current = { ...dataState.current, projects: [proj] };
    renderPage(proj);

    fireEvent.click(screen.getByRole('switch', { name: /publicar/i }));

    // the warning is up, but nothing has actually published yet — aria-checked must say so too
    expect(screen.getByRole('switch', { name: /publicar/i }).getAttribute('aria-checked')).toBe('false');
  });
});

describe('ProjectPage header', () => {
  it('is the shared page header: the name as the only title, its sections as tabs, publish among the actions', () => {
    const proj = project({ open_tasks: 3 });
    dataState.current = { ...dataState.current, projects: [proj] };
    renderPage(proj);
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['meu-projeto']);
    expect(screen.getByText('MEU · jarvis')).toBeTruthy();
    // the machines' working directories, which the old header showed on hover
    expect(screen.getByText('MEU · jarvis').getAttribute('title')).toContain('/home/pedro/meu-projeto');
    const tabs = screen.getByRole('navigation', { name: 'Seções de meu-projeto' });
    expect(within(tabs).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      '/projects/p1',
      '/projects/p1/tasks',
      '/projects/p1/backlog',
      '/projects/p1/tickets',
      '/projects/p1/notes',
      '/projects/p1/settings',
    ]);
    expect(within(tabs).getByRole('link', { name: /Board/ }).textContent).toBe('Board3');
    expect(within(tabs).getByRole('link', { name: 'Terminais' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('switch', { name: /publicar/i }).closest('header')).not.toBeNull();
  });
});

describe('ProjectPage with a card', () => {
  it('shows the Board with that card open, whatever the URL is', () => {
    const proj = project();
    dataState.current = { ...dataState.current, projects: [proj] };
    render(
      <MemoryRouter initialEntries={['/project/MEU-3']}>
        <Routes>
          <Route path="/project/:ref" element={<ProjectPage card={{ projectId: 'p1', taskId: 'k3' }} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('board k3')).toBeTruthy();
  });
});

describe('ProjectPage with a project the list does not have yet', () => {
  it('reads the list again before giving up, and shows the project it brings', async () => {
    const fresh = project({ id: 'new1', name: 'iptransporte' });
    const refresh = vi.fn(async () => {
      dataState.current = { ...dataState.current, projects: [fresh] };
    });
    dataState.current = { ...dataState.current, projects: [], refresh };
    renderPage(fresh);
    expect(screen.getByText('Carregando…')).toBeTruthy();
    // the re-read settles and the page renders again, now finding the project
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Projeto não encontrado.')).toBeNull();
    expect(screen.getAllByText('iptransporte').length).toBeGreaterThan(0);
  });

  it('says it is not there only after that one re-read', async () => {
    const refresh = vi.fn(async () => {});
    dataState.current = { ...dataState.current, projects: [], refresh };
    renderPage(project({ id: 'gone' }));
    expect(screen.getByText('Carregando…')).toBeTruthy();
    await act(async () => {});
    expect(await screen.findByText('Projeto não encontrado.')).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
