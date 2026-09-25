// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicCity } from '../lib/types';

// vi.mock factories are hoisted above this file's own imports, so everything they reference has to
// be created through vi.hoisted() — the same rule OfficePage.test.tsx works under.
const { FakeOfficeScene, socket } = vi.hoisted(() => {
  /** The scene stub OfficePage.test.tsx installs: no WebGL in jsdom, so it only records. */
  class FakeOfficeScene {
    static instances: FakeOfficeScene[] = [];
    handlers: { onPickDesk: (tabId: string, projectId: string) => void; onPickBuilding: (projectId: string) => void; onPickSign: (projectId: string) => void; onGoUp: () => void };
    setModel = vi.fn();
    focus = vi.fn();
    destroy = vi.fn();
    constructor(handlers: FakeOfficeScene['handlers']) {
      this.handlers = handlers;
      FakeOfficeScene.instances.push(this);
    }
    static failMount = false;
    onFrame = vi.fn(() => () => {});
    lockCamera = vi.fn();
    async mount(): Promise<void> {
      if (FakeOfficeScene.failMount) throw new Error('no WebGL');
    }
  }
  /**
   * The fake /ws/public channel: `emit` hands a parsed frame to the callback openCitySocket was
   * given, and `hangUp` is the server closing the socket — what it does when something it
   * showed leaves the street.
   */
  const socket = {
    onRobot: null as ((frame: unknown) => void) | null,
    onClosed: null as (() => void) | null,
    opened: 0,
    closed: 0,
    emit(frame: unknown) {
      socket.onRobot?.(frame);
    },
    hangUp() {
      socket.onClosed?.();
    },
  };
  return { FakeOfficeScene, socket };
});

vi.mock('../office/scene/OfficeScene', () => ({ OfficeScene: FakeOfficeScene }));
// only the socket is faked: fetchCity and toBuildingEntries are the real ones, over a stubbed fetch
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  openCitySocket: (_nickname: string, handlers: { onRobot: (frame: unknown) => void; onClosed: () => void }) => {
    socket.opened += 1;
    socket.onRobot = handlers.onRobot;
    socket.onClosed = handlers.onClosed;
    return () => {
      socket.closed += 1;
      socket.onRobot = null;
      socket.onClosed = null;
    };
  },
}));

import { CityPage } from './CityPage';

const AT = '2026-09-22T10:00:00.000Z';
const LATER = '2026-09-22T10:05:00.000Z';
const CITY: PublicCity = { nickname: 'pedro', owner_name: 'Pedro', short_url: null, buildings: [{ id: 'b1', name: 'Engage Easy', robots: [{ id: 'x1', name: 'aba 1', kind: 'terminal', state: 'working', state_at: AT, activity: 'coding', activity_verb: 'Moonwalking', alive: true, progress: null }] }] };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
const scene = () => FakeOfficeScene.instances[0];
/** what the page last handed the scene, as the office's own CityModel */
const desks = (desk: unknown) => ({ buildings: [expect.objectContaining({ desks: [expect.objectContaining(desk as object)] })] });

beforeEach(() => {
  FakeOfficeScene.instances = [];
  FakeOfficeScene.failMount = false;
  fetchMock.mockReset();
  socket.onRobot = null;
  socket.onClosed = null;
  socket.opened = 0;
  socket.closed = 0;
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const card = () => screen.queryByRole('region', { name: /beta gratuito/i });

describe('CityPage', () => {
  it('draws the city of the nickname in the URL and says whose it is', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);

    expect(await screen.findByText(/Cidade de Pedro/)).toBeTruthy();
    // no credentials on a public read, structurally and not by luck of the default
    expect(fetchMock).toHaveBeenCalledWith('/api/public/city/pedro', { credentials: 'omit' });
    expect(screen.getByRole('button', { name: /participar do beta grátis/i })).toBeTruthy();
  });

  // review fix: the snapshot of a deploy this bundle does not know (the old machine-and-rooms
  // payload) draws as buildings with nobody in them, and a frame for one of them does not throw
  it('draws a snapshot of an unexpected shape instead of blanking the page', async () => {
    const old = { nickname: 'pedro', owner_name: 'Pedro', short_url: null, buildings: [{ id: 'b1', name: 'jarvis', rooms: [{ id: 'r1', name: 'Engage Easy', robots: [] }] }] };
    fetchMock.mockResolvedValueOnce(json(old));
    render(<CityPage nickname="pedro" />);
    expect(await screen.findByText(/Cidade de Pedro/)).toBeTruthy();
    await waitFor(() => expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining({ buildings: [expect.objectContaining({ id: 'b1', desks: [] })] })));
    act(() => socket.emit({ type: 'robot', building: 'b1', robot: CITY.buildings[0].robots[0] }));
    await waitFor(() => expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining(desks({ id: 'x1' }))));
  });

  it('opens the beta card on a first visit, naming whose agents these are', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);

    expect(card()).toBeTruthy();
    expect(screen.getByText(/agentes de IA de Pedro trabalhando ao vivo/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /entrar no beta gratuito/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /conheça o termhub/i }).getAttribute('href')).toBe('https://termhub.dev/');
  });

  it('remembers a collapsed card on the next visit, and the top-bar button opens it again', async () => {
    fetchMock.mockImplementation(async () => json(CITY));
    const first = render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    fireEvent.click(screen.getByRole('button', { name: /recolher/i }));
    expect(card()).toBeNull();
    first.unmount();

    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    expect(card()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /participar do beta grátis/i }));
    expect(card()).toBeTruthy();
  });

  it('on a phone, opens as one line and shows the whole form only when asked', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    // the full card is hidden below `sm` (CSS), the one-line invitation shown there instead
    const sheet = () => card()!.parentElement!;
    expect(sheet().className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.getByRole('region', { name: 'Convite para o beta' }).textContent).toMatch(/Agentes de IA de Pedro ao vivo/);

    fireEvent.click(screen.getByRole('button', { name: 'Quero participar' }));
    expect(sheet().className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.queryByRole('region', { name: 'Convite para o beta' })).toBeNull();
  });

  it('closes the one-line invitation for good, like the card', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar convite' }));
    expect(card()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Convite para o beta' })).toBeNull();
    expect(localStorage.getItem('termhub:city-beta-collapsed')).toBe('1');
  });

  it('works without storage: open on arrival, still collapses and reopens', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);

    expect(card()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /recolher/i }));
    expect(card()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /participar do beta grátis/i }));
    expect(card()).toBeTruthy();
  });

  it('shows the beta card, open and without a name, on the not-found page', async () => {
    // a visitor who collapsed it on another city still gets it here: this page has nothing else to show
    localStorage.setItem('termhub:city-beta-collapsed', '1');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    render(<CityPage nickname="ninguem" />);
    await screen.findByText(/cidade não encontrada/i);

    expect(card()).toBeTruthy();
    expect(screen.getByText(/cada robô é um terminal de verdade/)).toBeTruthy();
    expect(screen.queryByText(/agentes de IA de/)).toBeNull();
  });

  it('shows the not-found state for a city that does not answer', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    render(<CityPage nickname="ninguem" />);

    expect(await screen.findByText(/cidade não encontrada/i)).toBeTruthy();
  });

  it('applies a live robot frame without refetching the snapshot', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    await waitFor(() => expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining(desks({ activity: 'coding' }))));

    act(() => socket.emit({ type: 'robot', building: 'b1', robot: { ...CITY.buildings[0].robots[0], activity: 'reading', state_at: LATER } }));

    await waitFor(() => expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining(desks({ activity: 'reading' }))));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('draws the published spinner verb like the office does', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    await waitFor(() => expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining(desks({ activity: 'coding', verb: 'Moonwalking' }))));
  });

  // A tab closed or deleted while somebody watches leaves the room, instead of sitting there until a reload.
  it('removes a robot when the channel says its tab is gone', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    await waitFor(() => expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining(desks({ activity: 'coding' }))));

    act(() => socket.emit({ type: 'robot_gone', building: 'b1', robot: 'x1' }));

    await waitFor(() =>
      expect(scene().setModel).toHaveBeenLastCalledWith(
        expect.objectContaining({ buildings: [expect.objectContaining({ desks: [] })] }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('goes to the not-found state, without a reload, when the city is unpublished under the visitor', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY)).mockResolvedValueOnce(new Response('', { status: 404 }));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);

    // the server hangs the socket up when something it showed leaves the street
    await act(async () => {
      socket.hangUp();
    });

    expect(await screen.findByText(/cidade não encontrada/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops knocking once a city is known not to be there', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    render(<CityPage nickname="ninguem" />);
    await screen.findByText(/cidade não encontrada/i);

    // opened once on arrival, then closed for good: no channel is kept open for a 404
    expect(socket.opened).toBe(1);
    expect(socket.closed).toBe(1);
    expect(socket.onClosed).toBeNull();
  });

  it('does not call a city missing when it merely could not be read, and comes back', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 500 })).mockResolvedValueOnce(json(CITY));
      render(<CityPage nickname="pedro" />);
      await act(async () => {});

      expect(fetchMock).toHaveBeenCalledTimes(1);
      // a server that could not answer is not a city that does not exist
      expect(screen.queryByText(/cidade não encontrada/i)).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(screen.getByText(/Cidade de Pedro/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // city-by-project §4: the street's model has no machine, so no desk carries a machine line
  it('hands the scene desks with no machine', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    await waitFor(() => expect(scene().setModel).toHaveBeenLastCalledWith(expect.objectContaining(desks({ machine: null }))));
  });
});

describe('CityPage rests', () => {
  beforeEach(() => history.replaceState(null, '', '/city/@pedro'));

  it('walks into a building from its ground or its sign, shows the trail, and Esc walks back out', async () => {
    fetchMock.mockResolvedValueOnce(json(CITY));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    act(() => scene().handlers.onPickBuilding('b1'));
    expect(location.pathname).toBe('/city/@pedro/b1');
    expect(screen.getByLabelText('Trilha').textContent).toBe('Cidade›Engage Easy');
    expect(scene().focus).toHaveBeenLastCalledWith({ kind: 'building', projectId: 'b1' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(location.pathname).toBe('/city/@pedro');
    expect(screen.getByLabelText('Trilha').textContent).toBe('');
    act(() => scene().handlers.onPickSign('b1'));
    expect(location.pathname).toBe('/city/@pedro/b1');
  });

  // city-by-project §2.5/§7: links shared under the old scheme — a machine's id, a ?room= — open the city
  it('opens an old link as the city, with no trail, and copies the city link from it', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    history.replaceState(null, '', '/city/@pedro/old-machine-id?room=old-room-id');
    fetchMock.mockResolvedValueOnce(json({ ...CITY, short_url: 'https://77a.it/pedro' }));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    expect(screen.getByLabelText('Trilha').textContent).toBe('');
    expect(scene().focus.mock.calls.at(-1)?.[0]).toEqual({ kind: 'city' });
    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
    });
    expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
  });
});

describe('CityPage sharing', () => {
  const withLink = { ...CITY, short_url: 'https://77a.it/pedro' };
  // these tests read the rest from the address bar, so each starts at the city itself
  beforeEach(() => history.replaceState(null, '', '/city/@pedro'));
  function stubClipboard() {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    return writeText;
  }

  it('keeps Compartilhar disabled until the city is drawn', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    render(<CityPage nickname="pedro" />);
    expect((screen.getByRole('button', { name: 'Compartilhar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the share panel, whose link is the short link at the city', async () => {
    const writeText = stubClipboard();
    fetchMock.mockResolvedValueOnce(json(withLink));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }));
    const panel = screen.getByRole('dialog', { name: 'Compartilhar a cidade' });
    expect(panel).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
    });
    expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
  });

  it('copies the long link of a building: only the city has a short link', async () => {
    const writeText = stubClipboard();
    history.replaceState(null, '', '/city/@pedro/b1');
    fetchMock.mockResolvedValueOnce(json(withLink));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
    });
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/city/@pedro/b1`);
  });

  it('closes the panel on Esc without walking the camera up, and gives the focus back', async () => {
    history.replaceState(null, '', '/city/@pedro/b1');
    fetchMock.mockResolvedValueOnce(json(withLink));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    const share = screen.getByRole('button', { name: 'Compartilhar' });
    fireEvent.click(share);
    const panel = screen.getByRole('dialog', { name: 'Compartilhar a cidade' });
    expect(panel.contains(document.activeElement)).toBe(true);
    const focusCalls = scene().focus.mock.calls.length;
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Compartilhar a cidade' })).toBeNull();
    expect(location.pathname).toBe('/city/@pedro/b1');
    expect(scene().focus.mock.calls.length).toBe(focusCalls);
    expect(document.activeElement).toBe(share);
    // with the panel gone, Esc walks up again
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(location.pathname).toBe('/city/@pedro');
  });

  it('gives the focus back to Compartilhar when the panel is closed with its button', async () => {
    fetchMock.mockResolvedValueOnce(json(withLink));
    render(<CityPage nickname="pedro" />);
    await screen.findByText(/Cidade de Pedro/);
    const share = screen.getByRole('button', { name: 'Compartilhar' });
    fireEvent.click(share);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(document.activeElement).toBe(share);
  });

  it('hides Compartilhar when the scene cannot draw, and keeps Copiar link in the page', async () => {
    const writeText = stubClipboard();
    FakeOfficeScene.failMount = true;
    fetchMock.mockResolvedValueOnce(json(withLink));
    render(<CityPage nickname="pedro" />);
    await screen.findByText('Seu navegador não conseguiu desenhar a cidade.');
    expect(screen.queryByRole('button', { name: 'Compartilhar' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
    });
    expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
  });
});
