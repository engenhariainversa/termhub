// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatPref } from '../../lib/project-chat-prefs';

const mounts = vi.hoisted(() => new Map<string, number>());
const renders = vi.hoisted(() => new Map<string, number>());
vi.mock('./ChatPanel', async () => {
  const { useEffect } = await import('react');
  const { createPortal } = await import('react-dom');
  const { useChatHeaderSlot } = await import('./chat-header-slot');
  // Stands in for `ChatSettingsButton` (TER-1039): the one part of the panel that reads the header slot,
  // a child of its own, so the panel itself does not re-render when the slot arrives — as in the real one.
  const Cog = ({ projectId }: { projectId: string }) => {
    const slot = useChatHeaderSlot();
    return slot ? createPortal(<button type="button">engrenagem {projectId}</button>, slot) : null;
  };
  return {
    // A plain component (not memoized itself), so `ChatDock`'s own `memo(ChatPanel)` is what the test
    // below exercises.
    ChatPanel: ({ projectId }: { projectId: string }) => {
      renders.set(projectId, (renders.get(projectId) ?? 0) + 1);
      useEffect(() => void mounts.set(projectId, (mounts.get(projectId) ?? 0) + 1), [projectId]);
      return (
        <div>
          painel {projectId}
          <Cog projectId={projectId} />
        </div>
      );
    },
  };
});
vi.mock('../../lib/data', () => ({ useData: () => ({ projects: [{ id: 'p1', name: 'termhub' }, { id: 'p2', name: 'engenharia inversa' }, { id: 'p3', name: 'outro' }] }) }));
const narrow = vi.hoisted(() => ({ value: false }));
vi.mock('../../lib/narrow-window', () => ({ useNarrowWindow: () => narrow.value }));
const chat = vi.hoisted(() => ({
  alive: [] as string[],
  shownProjectId: null as string | null,
  prefs: {} as Record<string, ChatPref>,
  setOpen: vi.fn(),
  setWidth: vi.fn(),
  setMaximized: vi.fn(),
}));
vi.mock('../../lib/project-chat', () => ({
  useProjectChat: () => ({ ...chat, pref: (id: string) => chat.prefs[id] ?? { open: false, width: 420, maximized: false } }),
}));

import { ChatDock } from './ChatDock';

const open = (width = 420, maximized = false): ChatPref => ({ open: true, width, maximized });
const renderDock = () => render(<MemoryRouter><ChatDock /></MemoryRouter>);

beforeEach(() => {
  mounts.clear();
  renders.clear();
  narrow.value = false;
  chat.alive = [];
  chat.shownProjectId = null;
  chat.prefs = {};
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('renders nothing on a page that is not a project, or when the chat is closed', () => {
  const { container } = renderDock();
  expect(container.innerHTML).toBe('');
});

it('shows the current project chat beside the page, at its width, with its name', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open(500) };
  renderDock();
  const aside = screen.getByRole('complementary', { name: 'Chat · termhub' });
  expect(aside.style.width).toBe('500px');
  expect(aside.className).toContain('shrink-0');
  expect(screen.getByRole('separator', { name: 'Largura do chat' })).toBeTruthy();
  expect(screen.getByText('painel p1')).toBeTruthy();
});

it('keeps the chat left behind mounted, hidden and inert, when switching project', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open(), p2: open() };
  const { rerender } = renderDock();
  chat.alive = ['p2', 'p1'];
  chat.shownProjectId = 'p2';
  rerender(<MemoryRouter><ChatDock /></MemoryRouter>);
  expect(screen.getByRole('complementary', { name: 'Chat · engenharia inversa' })).toBeTruthy();
  // p1 is still in the DOM, but hidden from focus and screen readers
  const hidden = screen.getByText('painel p1').closest('aside')!;
  expect(hidden.hasAttribute('inert')).toBe(true);
  expect(hidden.getAttribute('aria-hidden')).toBe('true');
  expect(screen.queryByRole('complementary', { name: 'Chat · termhub' })).toBeNull();
  // back to p1: no remount, for either panel
  chat.alive = ['p1', 'p2'];
  chat.shownProjectId = 'p1';
  rerender(<MemoryRouter><ChatDock /></MemoryRouter>);
  expect(mounts.get('p1')).toBe(1);
  expect(mounts.get('p2')).toBe(1);
});

it('renders the alive panels in a stable order, whatever the recency order', () => {
  chat.alive = ['p2', 'p1', 'p3'];
  chat.shownProjectId = 'p2';
  chat.prefs = { p1: open(), p2: open(), p3: open() };
  renderDock();
  expect(screen.getAllByText(/^painel /).map((e) => e.textContent)).toEqual(['painel p1', 'painel p2', 'painel p3']);
});

it('✕ closes the chat, ⤢ maximizes it', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open() };
  renderDock();
  fireEvent.click(screen.getByRole('button', { name: 'Fechar chat' }));
  expect(chat.setOpen).toHaveBeenCalledWith('p1', false);
  fireEvent.click(screen.getByRole('button', { name: 'Tela cheia' }));
  expect(chat.setMaximized).toHaveBeenCalledWith('p1', true);
});

it('maximized: fills the row, no width and no separator; ⤡ goes back', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open(500, true) };
  renderDock();
  const aside = screen.getByRole('complementary', { name: 'Chat · termhub' });
  expect(aside.className).toContain('flex-1');
  expect(aside.style.width).toBe('');
  expect(screen.queryByRole('separator')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Sair da tela cheia' }));
  expect(chat.setMaximized).toHaveBeenCalledWith('p1', false);
});

it('narrow window: full screen, no separator and no maximize, body locked while shown', () => {
  narrow.value = true;
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open() };
  const { rerender } = renderDock();
  expect(screen.getByRole('complementary', { name: 'Chat · termhub' }).className).toContain('fixed');
  expect(screen.queryByRole('separator')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Tela cheia' })).toBeNull();
  expect(document.body.classList.contains('chat-locked')).toBe(true);
  chat.shownProjectId = null;
  rerender(<MemoryRouter><ChatDock /></MemoryRouter>);
  expect(document.body.classList.contains('chat-locked')).toBe(false);
});

it('wide window (an iPad): tracks the height the keyboard leaves while a chat is shown, without locking the body', () => {
  // On iPadOS the keyboard only shrinks the visual viewport; the row this chat sits in (Layout) is
  // sized from `--app-height`, so the composer stays above the keyboard instead of Safari scrolling a
  // screen-tall page under it (TER-313).
  const visualViewport = { height: 500, scale: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  Object.defineProperty(window, 'visualViewport', { value: visualViewport, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true }); // a touch screen
  try {
    chat.alive = ['p1'];
    chat.shownProjectId = 'p1';
    chat.prefs = { p1: open() };
    const { rerender } = renderDock();
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('500px');
    // `chat-locked` brings `touch-action: pan-y`, which would stop the board's sideways scroll beside it.
    expect(document.body.classList.contains('chat-locked')).toBe(false);
    chat.shownProjectId = null;
    rerender(<MemoryRouter><ChatDock /></MemoryRouter>);
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('');
  } finally {
    delete (window as { visualViewport?: unknown }).visualViewport;
    delete (navigator as { maxTouchPoints?: unknown }).maxTouchPoints;
  }
});

it('wide window without a touch screen (a desktop): leaves --app-height alone, so the row keeps the window height (TER-385)', () => {
  // No on-screen keyboard can ever shrink a desktop window, so nothing the visual viewport reports
  // there is worth sizing the row to: Chrome on a Mac reported about half the window, and the whole
  // app (sidebar, terminal, chat) ended halfway down the page. The row's CSS fallback is 100%.
  const visualViewport = { height: 480, scale: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  Object.defineProperty(window, 'visualViewport', { value: visualViewport, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
  try {
    chat.alive = ['p1'];
    chat.shownProjectId = 'p1';
    chat.prefs = { p1: open() };
    renderDock();
    expect(screen.getByRole('complementary', { name: 'Chat · termhub' })).toBeTruthy();
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('');
    expect(visualViewport.addEventListener).not.toHaveBeenCalled();
  } finally {
    delete (window as { visualViewport?: unknown }).visualViewport;
    delete (navigator as { maxTouchPoints?: unknown }).maxTouchPoints;
  }
});

it('Escape does not close the docked chat', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open() };
  renderDock();
  act(() => void fireEvent.keyDown(window, { key: 'Escape' }));
  expect(chat.setOpen).not.toHaveBeenCalled();
});

it('memoizes the mounted panel: a pref change for another project does not re-render it', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open() };
  const { rerender } = renderDock();
  expect(renders.get('p1')).toBe(1);
  // A change that has nothing to do with p1 (a different project's pref) still re-renders ChatDock
  // itself (a new `useProjectChat()` value): only a memoized panel skips the re-render.
  chat.prefs = { p1: chat.prefs.p1, p2: open(600) };
  rerender(<MemoryRouter><ChatDock /></MemoryRouter>);
  expect(renders.get('p1')).toBe(1);
});

it("puts each panel's cog in its own header, before the window controls (TER-1039)", () => {
  chat.alive = ['p1', 'p2'];
  chat.shownProjectId = 'p2';
  chat.prefs = { p1: open(), p2: open() };
  renderDock();
  const headers = [...document.querySelectorAll('aside header')] as HTMLElement[];
  expect(headers).toHaveLength(2);
  for (const [i, id] of ['p1', 'p2'].entries()) {
    const cog = screen.getByRole('button', { name: `engrenagem ${id}`, hidden: true });
    expect(headers[i]!.contains(cog)).toBe(true);
    // Before ✕, so the dock's own controls stay at the end of the bar.
    const close = within(headers[i]!).getByRole('button', { name: 'Fechar chat', hidden: true });
    expect(cog.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});

it('the separator commits the width of the shown project', () => {
  chat.alive = ['p1'];
  chat.shownProjectId = 'p1';
  chat.prefs = { p1: open() };
  renderDock();
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Largura do chat' }), { key: 'ArrowLeft' });
  expect(chat.setWidth).toHaveBeenCalledWith('p1', 436);
});
