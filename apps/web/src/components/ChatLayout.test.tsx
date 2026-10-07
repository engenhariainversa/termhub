// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The legal notice reads the auth context; not this test's concern.
vi.mock('./LegalNoticeBanner', () => ({ LegalNoticeBanner: () => null }));

import { ChatLayout } from './ChatLayout';

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

  it('links to "Memória do chat"', () => {
    mount();
    const link = screen.getByRole('link', { name: 'Memória' });
    expect(link.getAttribute('href')).toBe('/chat/memoria');
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

it('shows which bundle it is running', () => {
  // So "it did not change on my phone" is answered by reading the header, not by guessing between a
  // stale page and a fix that does not work.
  render(
    <MemoryRouter initialEntries={['/chat']}>
      <Routes>
        <Route element={<ChatLayout />}>
          <Route path="/chat" element={<p>conversa</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  // Version first, because that is what was asked for; then whatever identifies the build — the
  // commit in a deployed image, the build time in a local one, since the version alone has not
  // moved since 0.1.0 and could never tell two deploys apart.
  expect(screen.getByTitle('build').textContent).toMatch(/^v\d+\.\d+\.\d+ · .+/);
});
});
