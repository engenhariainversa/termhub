// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project, User } from '../lib/types';

// vi.mock factories are hoisted: everything they touch comes through vi.hoisted().
const { patchMock, dataState, authState } = vi.hoisted(() => {
  const patchMock = vi.fn(async (_id: string, input: Record<string, unknown>) => ({ ...input }));
  const dataState = {
    current: {
      projects: [] as Project[],
      machines: [] as Machine[],
      hiddenLocal: [] as Machine[],
      loading: false,
      updateProject: (id: string, input: Record<string, unknown>) => patchMock(id, input),
    },
  };
  const authState = {
    current: {
      user: null as User | null,
      publicCityUrl: 'https://termhub.dev/city' as string | null,
      can: (() => true) as (resource: string, action?: string) => boolean,
      setNickname: vi.fn(async () => {}),
    },
  };
  return { patchMock, dataState, authState };
});

vi.mock('../lib/data', () => ({ useData: () => dataState.current }));
vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
const { monitorState } = vi.hoisted(() => ({ monitorState: { current: { openTabs: [] as Array<{ id: string; project_id: string; machine_id: string }> } } }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => monitorState.current }));

const { cityLinkState } = vi.hoisted(() => ({
  cityLinkState: {
    active: null as boolean | null,
    current: {
      link: null as import('../lib/types').CityLink | null,
      saving: false,
      error: null as string | null,
      setCustom: vi.fn(async (_url: string) => true),
      restorePartner: vi.fn(async () => {}),
      clearError: vi.fn(),
    },
  },
}));
vi.mock('../lib/city-link', () => ({
  useCityLink: (active: boolean) => {
    cityLinkState.active = active;
    return cityLinkState.current;
  },
}));

import { MyCityView } from './MyCityView';

function machine(id: string, name: string, owner_id: string | null = 'u1'): Machine {
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
    owner_id,
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

const baseUser: User = {
  id: 'u1',
  email: 'a@b.c',
  name: 'Pedro',
  avatar_url: null,
  role: 'owner',
  role_info: null,
  permissions: [],
  has_password: true,
  has_google: false,
  invited_at: null,
  last_login_at: null,
  nickname: 'pedro',
};

function renderView() {
  return render(
    <MemoryRouter>
      <MyCityView />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  patchMock.mockReset();
  patchMock.mockImplementation(async (_id, input) => ({ ...input }));
  dataState.current = { ...dataState.current, projects: [], machines: [machine('m1', 'jarvis')], hiddenLocal: [], loading: false };
  authState.current = { ...authState.current, user: { ...baseUser }, publicCityUrl: 'https://termhub.dev/city', can: () => true };
  cityLinkState.active = null;
  cityLinkState.current = { ...cityLinkState.current, link: null, saving: false, error: null };
  cityLinkState.current.setCustom.mockReset().mockResolvedValue(true);
  cityLinkState.current.restorePartner.mockReset().mockResolvedValue(undefined);
  cityLinkState.current.clearError.mockReset();
  monitorState.current = { openTabs: [] };
});

afterEach(() => {
  cleanup();
});

describe('MyCityView nickname', () => {
  it('shows a set nickname read-only, saying why it cannot change', () => {
    renderView();
    expect(screen.getByText('pedro')).toBeTruthy();
    expect(screen.getByText(/não pode ser trocado/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /escolher apelido/i })).toBeNull();
  });

  it('offers to choose a nickname when there is none, through the nickname dialog', () => {
    authState.current = { ...authState.current, user: { ...baseUser, nickname: null } };
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /escolher apelido/i }));
    expect(screen.getByLabelText(/apelido/i)).toBeTruthy();
  });
});

describe('MyCityView link', () => {
  it('builds the link from the instance base and the nickname, with copy and open', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    dataState.current = { ...dataState.current, projects: [project({ is_public: true })] };
    renderView();

    expect(screen.getByText('https://termhub.dev/city/@pedro')).toBeTruthy();
    const open = screen.getByRole('link', { name: /^abrir$/i });
    expect(open.getAttribute('href')).toBe('https://termhub.dev/city/@pedro');
    expect(open.getAttribute('target')).toBe('_blank');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copiar/i }));
    });
    expect(writeText).toHaveBeenCalledWith('https://termhub.dev/city/@pedro');
    expect(screen.getByRole('button', { name: /copiado/i })).toBeTruthy();
  });

  it('explains there is no link yet without a nickname', () => {
    authState.current = { ...authState.current, user: { ...baseUser, nickname: null } };
    renderView();
    expect(screen.queryByRole('button', { name: /copiar/i })).toBeNull();
    expect(screen.getByText(/escolha um apelido para ter o endereço/i)).toBeTruthy();
  });

  it('warns that the city is empty while nothing is published', () => {
    dataState.current = { ...dataState.current, projects: [project({ is_public: false })] };
    renderView();
    expect(screen.getByText('https://termhub.dev/city/@pedro')).toBeTruthy();
    expect(screen.getByText(/nenhum projeto publicado ainda/i)).toBeTruthy();
  });

  it('leads to the public page to make images and the video there', () => {
    renderView();
    const open = screen.getByRole('link', { name: 'Abrir minha cidade para compartilhar' });
    expect(open.getAttribute('href')).toBe('https://termhub.dev/city/@pedro');
    expect(open.getAttribute('target')).toBe('_blank');
  });

  // city-by-project §2.4: a published project is always on the street, with or without machines
  it('stops warning once a project is published, even one with no machine linked', () => {
    dataState.current = { ...dataState.current, projects: [project({ is_public: true, machines: [] })] };
    renderView();
    expect(screen.queryByText(/nenhum projeto publicado ainda/i)).toBeNull();
  });
});

describe('MyCityView projects', () => {
  it('lists only the projects the user owns, each saying whether it is published and how many of its terminals are on the street now', () => {
    dataState.current = {
      ...dataState.current,
      machines: [machine('m1', 'jarvis'), machine('m2', 'servidor-alheio', 'u2')],
      projects: [
        project({ is_public: true, machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }, { machine_id: 'm2', cwd: '/a', position: 1 }] }),
        project({ id: 'p3', key: 'PRIV', name: 'privado' }),
        project({ id: 'p2', key: 'OUTRO', name: 'projeto-de-outro', owner_id: 'u2' }),
      ],
    };
    monitorState.current = {
      openTabs: [
        { id: 't1', project_id: 'p1', machine_id: 'm1' },
        { id: 't2', project_id: 'p1', machine_id: 'm1' },
        // on somebody else's machine: never on the street, so never counted
        { id: 't3', project_id: 'p1', machine_id: 'm2' },
      ],
    };
    renderView();
    const [published, priv] = screen.getAllByRole('listitem');
    expect(within(published).getByText('meu-projeto')).toBeTruthy();
    expect(within(published).getByText('publicado · 2 terminais agora')).toBeTruthy();
    expect(within(priv).getByText('não publicado')).toBeTruthy();
    // the machines are no longer part of what a city shows
    expect(within(published).queryByText(/jarvis|servidor-alheio|Aparece em/)).toBeNull();
    expect(within(published).getByRole('link', { name: /abrir projeto meu-projeto/i }).getAttribute('href')).toBe('/projects/p1');
    expect(screen.queryByText('projeto-de-outro')).toBeNull();
  });

  // the data layer only knows the open terminals (not the simulator tabs the street also draws), so the row says terminals
  it('says one terminal in the singular, and none for a published project with nobody in it', () => {
    dataState.current = { ...dataState.current, projects: [project({ is_public: true }), project({ id: 'p4', key: 'VAZIO', name: 'vazio', is_public: true })] };
    monitorState.current = { openTabs: [{ id: 't1', project_id: 'p1', machine_id: 'm1' }] };
    renderView();
    expect(screen.getByText('publicado · 1 terminal agora')).toBeTruthy();
    expect(screen.getByText('publicado · 0 terminais agora')).toBeTruthy();
  });

  // review fix: an archived project is never a building, published or not, so its row must not say it is on the street
  it('says an archived project does not show on the city, whatever its switch says', () => {
    dataState.current = {
      ...dataState.current,
      projects: [project({ is_public: true, status: 'archived' }), project({ id: 'p5', key: 'ARQ', name: 'arquivado-privado', status: 'archived' })],
    };
    monitorState.current = { openTabs: [{ id: 't1', project_id: 'p1', machine_id: 'm1' }] };
    renderView();
    expect(screen.queryByText(/publicado ·/)).toBeNull();
    expect(screen.getAllByText('arquivado (não aparece na cidade)')).toHaveLength(2);
  });

  it('publishes from the list through the same path as the project page', async () => {
    dataState.current = { ...dataState.current, projects: [project()] };
    renderView();

    fireEvent.click(screen.getByRole('switch', { name: /publicar/i }));
    expect(screen.getByText(/o nome do projeto e cada agente \(aba\) dele que roda nas suas máquinas/i)).toBeTruthy();
    expect(screen.getByText(/agentes em máquinas de outras pessoas não aparecem/i)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^publicar$/i }));
    });
    expect(patchMock).toHaveBeenCalledWith('p1', expect.objectContaining({ is_public: true }));
  });

  it('shows an empty state when the user owns no project', () => {
    dataState.current = { ...dataState.current, projects: [project({ owner_id: 'u2' })] };
    renderView();
    expect(screen.getByText(/você ainda não tem projetos/i)).toBeTruthy();
  });

  it('shows the empty state for an account that cannot list projects, instead of loading forever', () => {
    dataState.current = { ...dataState.current, loading: true };
    authState.current = { ...authState.current, can: () => false };
    renderView();
    expect(screen.getByText(/você ainda não tem projetos/i)).toBeTruthy();
  });
});

describe('MyCityView short link', () => {
  const PARTNER = { enabled: true, city_url: 'https://termhub.dev/city/@pedro', short_url: 'https://77a.it/pedro', source: 'partner' as const, partner_url: 'https://77a.it/pedro' };
  const section = () => screen.getByRole('region', { name: 'Link curto' });

  it('asks for the link only once there is a nickname', () => {
    renderView();
    expect(cityLinkState.active).toBe(true);
    cleanup();
    authState.current = { ...authState.current, user: { ...baseUser, nickname: null } };
    renderView();
    expect(cityLinkState.active).toBe(false);
  });

  it('shows nothing while the instance has no short links', () => {
    cityLinkState.current = { ...cityLinkState.current, link: { enabled: false, city_url: 'https://termhub.dev/city/@pedro', short_url: null, source: null, partner_url: null } };
    renderView();
    expect(screen.queryByRole('region', { name: 'Link curto' })).toBeNull();
  });

  it('shows the partner link with its note, and copies it whole', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    cityLinkState.current = { ...cityLinkState.current, link: PARTNER };
    renderView();
    expect(within(section()).getByText('Link curto: 77a.it/pedro')).toBeTruthy();
    expect(within(section()).getByText('Criado pelo TypeToAccess, parceiro do termhub')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: /^copiar$/i }));
    });
    expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
  });

  it('pastes a link of one’s own, and shows the server’s refusal', async () => {
    cityLinkState.current = { ...cityLinkState.current, link: PARTNER, error: 'Esse link leva para https://termhub.dev/city/@ana, não para a sua cidade (https://termhub.dev/city/@pedro).' };
    cityLinkState.current.setCustom.mockResolvedValue(false);
    renderView();
    fireEvent.click(within(section()).getByRole('button', { name: 'Usar meu próprio link curto' }));
    expect(within(section()).getByRole('link', { name: 'typetoaccess.it' }).getAttribute('href')).toBe('https://typetoaccess.it');
    fireEvent.change(within(section()).getByLabelText('Seu link curto'), { target: { value: 'https://77a.it/meu' } });
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Salvar' }));
    });
    expect(cityLinkState.current.setCustom).toHaveBeenCalledWith('https://77a.it/meu');
    expect(within(section()).getByRole('alert').textContent).toMatch(/leva para https:\/\/termhub\.dev\/city\/@ana/);
    // a refused link keeps the form open with what was typed
    expect((within(section()).getByLabelText('Seu link curto') as HTMLInputElement).value).toBe('https://77a.it/meu');
  });

  it('goes back to the partner link from a custom one', async () => {
    cityLinkState.current = { ...cityLinkState.current, link: { ...PARTNER, short_url: 'https://77a.it/meu', source: 'custom' } };
    renderView();
    expect(within(section()).getByText('Link curto: 77a.it/meu')).toBeTruthy();
    expect(within(section()).queryByText('Criado pelo TypeToAccess, parceiro do termhub')).toBeNull();
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Voltar ao link da parceria' }));
    });
    expect(cityLinkState.current.restorePartner).toHaveBeenCalled();
  });

  it('says when the short link is not there yet', () => {
    cityLinkState.current = { ...cityLinkState.current, link: { ...PARTNER, short_url: null, source: null, partner_url: null } };
    renderView();
    expect(within(section()).getByText(/o link curto ainda não foi criado/i)).toBeTruthy();
  });

  // Review fix 1: without a partner link, "back to the partnership" has nothing to go back to
  it('offers no way back to the partner link when there is none', () => {
    cityLinkState.current = { ...cityLinkState.current, link: { ...PARTNER, short_url: 'https://77a.it/meu', source: 'custom', partner_url: null } };
    renderView();
    expect(within(section()).queryByRole('button', { name: 'Voltar ao link da parceria' })).toBeNull();
  });

  // Review fix 2: a failed restore happens outside the form, and must still be seen
  it('shows a refusal outside the form too', () => {
    cityLinkState.current = { ...cityLinkState.current, link: { ...PARTNER, short_url: 'https://77a.it/meu', source: 'custom' }, error: 'Não foi possível criar o link da parceria agora.' };
    renderView();
    expect(within(section()).queryByLabelText('Seu link curto')).toBeNull();
    expect(within(section()).getByRole('alert').textContent).toMatch(/link da parceria/);
  });

  it('starts the form clean, and cancelling drops what was typed and the error', () => {
    cityLinkState.current = { ...cityLinkState.current, link: PARTNER };
    renderView();
    fireEvent.click(within(section()).getByRole('button', { name: 'Usar meu próprio link curto' }));
    expect(cityLinkState.current.clearError).toHaveBeenCalledTimes(1);
    fireEvent.change(within(section()).getByLabelText('Seu link curto'), { target: { value: 'https://77a.it/meu' } });
    fireEvent.click(within(section()).getByRole('button', { name: 'Cancelar' }));
    expect(cityLinkState.current.clearError).toHaveBeenCalledTimes(2);
    fireEvent.click(within(section()).getByRole('button', { name: 'Usar meu próprio link curto' }));
    expect((within(section()).getByLabelText('Seu link curto') as HTMLInputElement).value).toBe('');
  });
});
