// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatLayout } from './ChatLayout';
import { ChatPage } from '../pages/ChatPage';

// Just enough of the chat for `ChatPage` to mount under the layout: the conversation's cog is the
// panel's, portalled into this header (TER-1039), so the header can only be tested with a panel in it.
vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    chat: () => Promise.resolve({ conversation: { id: 'c1', ai_account_id: null }, messages: [], actions: [], host: { kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'default' }, sessionAtStake: false } }),
    machines: { list: () => Promise.resolve({ machines: [], latest_agent_version: null }) },
    aiAccounts: { list: () => Promise.resolve({ accounts: [] }) },
  },
}));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' }, viewAs: null }) }));
vi.mock('../lib/chat', () => ({ useChatStream: () => ({ connected: true }) }));

function Marker() {
  return <p>conteúdo do chat</p>;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/chat']}>
      <Routes>
        <Route element={<ChatLayout />}>
          <Route path="/chat" element={<Marker />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** The real `/chat` page under the layout, as the app routes it. */
function mountChat() {
  return render(
    <MemoryRouter initialEntries={['/chat']}>
      <Routes>
        <Route element={<ChatLayout />}>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/memoria" element={<p>tela da memória</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

async function openSettings() {
  fireEvent.click(await screen.findByRole('button', { name: 'Configurações da conversa' }));
  return within(await screen.findByRole('dialog', { name: 'Configurações da conversa' }));
}

afterEach(() => {
  cleanup();
});

describe('ChatLayout', () => {
  it('renders the routed child', () => {
    mount();
    expect(screen.getByText('conteúdo do chat')).toBeTruthy();
  });

  it('renders no nav (sem menus)', () => {
    mount();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('names the page in its header, so the screen has a heading', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeTruthy();
  });

  it('puts the routed page in a main landmark, like every sidebar route', () => {
    mount();
    // /chat is a full page of its own, so it needs the landmark a screen reader skips the header by.
    expect(screen.getByRole('main').textContent).toContain('conteúdo do chat');
  });

  it('offers a labelled way back to the app', () => {
    mount();
    const back = screen.getByRole('link', { name: /voltar/i });
    expect(back.getAttribute('href')).toBe('/');
  });

  it('keeps the header to the way back, the title and the cog: no "Memória" link of its own (TER-1039)', async () => {
    mountChat();
    const header = screen.getByRole('banner');
    await within(header).findByRole('button', { name: 'Configurações da conversa' });
    expect(within(header).queryByRole('link', { name: 'Memória' })).toBeNull();
    expect(within(header).queryByTitle('build')).toBeNull();
    expect(within(header).getAllByRole('link')).toHaveLength(1); // ← Voltar
  });

  it("portals the chat panel's cog into its header, not above the thread", async () => {
    mountChat();
    const cog = await screen.findByRole('button', { name: 'Configurações da conversa' });
    expect(screen.getByRole('banner').contains(cog)).toBe(true);
    expect(screen.getByRole('main').contains(cog)).toBe(false);
    expect(screen.getAllByRole('button', { name: 'Configurações da conversa' })).toHaveLength(1);
  });

  it('links to "Memória do chat" from the conversation settings, and closes them on the way', async () => {
    mountChat();
    const settings = await openSettings();
    const link = settings.getByRole('link', { name: 'Memória' });
    expect(link.getAttribute('href')).toBe('/chat/memoria');
    fireEvent.click(link);
    expect(await screen.findByText('tela da memória')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Configurações da conversa' })).toBeNull();
  });

it('locks the document while it is mounted, and gives it back on the way out', () => {
  // On iOS a drag that starts on a child which cannot scroll — the message box — is handed to the
  // document, which is the "press and drag the box and it scrolls for ever" report. The class is
  // scoped to the chat so the terminals keep their own scrolling; jsdom applies no CSS, so what is
  // pinned here is that the class arrives and, just as importantly, leaves.
  const { unmount } = render(
    <MemoryRouter initialEntries={['/chat']}>
      <Routes>
        <Route element={<ChatLayout />}>
          <Route path="/chat" element={<p>conversa</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  expect(document.body.classList.contains('chat-locked')).toBe(true);
  unmount();
  expect(document.body.classList.contains('chat-locked')).toBe(false);
});

it('sizes itself to the visible viewport while it is mounted, and stops when it is not', () => {
  // The keyboard shrinks the visual viewport and nothing else: without this the shell stays a whole
  // screen tall behind the keyboard, which is the empty space that could be scrolled on a phone.
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true }); // a phone
  const { unmount } = render(
    <MemoryRouter initialEntries={['/chat']}>
      <Routes>
        <Route element={<ChatLayout />}>
          <Route path="/chat" element={<p>conversa</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  // jsdom has no visualViewport, so the fallback (innerHeight) is what lands here.
  expect(document.documentElement.style.getPropertyValue('--app-height')).toBe(`${window.innerHeight}px`);
  unmount();
  expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('');
  delete (navigator as { maxTouchPoints?: unknown }).maxTouchPoints;
});

it('on a desktop (no touch screen) it leaves the height to CSS: no keyboard can ever shrink that window (TER-385)', () => {
  const { unmount } = render(
    <MemoryRouter initialEntries={['/chat']}>
      <Routes>
        <Route element={<ChatLayout />}>
          <Route path="/chat" element={<p>conversa</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('');
  unmount();
});

it('shows which bundle it is running, in the conversation settings', async () => {
  // So "it did not change on my phone" is answered by reading the settings (TER-1039: no longer the
  // header), not by guessing between a stale page and a fix that does not work.
  mountChat();
  const settings = await openSettings();
  // Version first, because that is what was asked for; then whatever identifies the build — the
  // commit in a deployed image, the build time in a local one, since the version alone has not
  // moved since 0.1.0 and could never tell two deploys apart.
  expect(settings.getByTitle('build').textContent).toMatch(/^v\d+\.\d+\.\d+ · .+/);
});
});
