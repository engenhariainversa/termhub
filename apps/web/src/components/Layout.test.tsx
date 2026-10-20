// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./Sidebar', async () => {
  const { Link } = await import('react-router-dom');
  return {
    Sidebar: ({ onCollapse }: { onCollapse?: () => void }) => (
      <>
        <p>projects-sidebar</p>
        <button onClick={onCollapse}>recolher</button>
        <Link to="/settings/profile" data-chrome-focus="profile">
          perfil
        </Link>
      </>
    ),
  };
});
vi.mock('./SettingsSidebar', () => ({
  SettingsSidebar: ({ onBack }: { onBack: () => void }) => (
    <button onClick={onBack} data-chrome-focus="settings-back">
      settings-sidebar
    </button>
  ),
}));
vi.mock('./SidebarRail', () => ({
  SidebarRail: ({ mode, onBack, onExpand }: { mode: string; onBack: () => void; onExpand: () => void }) => (
    <>
      <button onClick={onBack} data-chrome-focus={mode === 'settings' ? 'settings-back' : 'profile'}>{`rail-${mode}`}</button>
      <button onClick={onExpand}>expandir</button>
    </>
  ),
}));
vi.mock('./chat/ChatDock', () => ({ ChatDock: () => <aside aria-label="dock" /> }));
const dock = vi.hoisted(() => ({ shownProjectId: null as string | null, maximized: false }));
vi.mock('../lib/project-chat', () => ({
  ProjectChatProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useProjectChat: () => ({ shownProjectId: dock.shownProjectId, pref: () => ({ open: true, width: 420, maximized: dock.maximized }) }),
}));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: () => true }) }));
// The banner reads the API on mount; not this test's concern.
vi.mock('./DeviceRequestBanner', () => ({ DeviceRequestBanner: () => null }));
vi.mock('./LegalNoticeBanner', () => ({ LegalNoticeBanner: () => null }));

import { FocusProvider } from '../lib/focus';
import { Chrome, Layout } from './Layout';

function mount(path: string, collapsed = false, setCollapsed: (v: boolean) => void = () => {}) {
  const onLeaveSettings = vi.fn();
  render(
    <MemoryRouter initialEntries={[path]}>
      <FocusProvider>
        <Chrome collapsed={collapsed} setCollapsed={setCollapsed} onLeaveSettings={onLeaveSettings} />
      </FocusProvider>
    </MemoryRouter>,
  );
  return onLeaveSettings;
}

/** Chrome with a real way back (to /machines) and a link into settings from the page content. */
function Navigating({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  return (
    <>
      <Chrome collapsed={collapsed} setCollapsed={() => {}} onLeaveSettings={() => void navigate('/machines')} />
      <Link to="/settings/integrations">link na página</Link>
      {/* drops focus before navigating, as the real profile button does when its sidebar unmounts */}
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          void navigate('/settings/profile');
        }}
      >
        ir às configurações
      </button>
    </>
  );
}
function mountNavigating(path: string, collapsed = false) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <FocusProvider>
        <Navigating collapsed={collapsed} />
      </FocusProvider>
    </MemoryRouter>,
  );
}
/** Keyboard activation: focus the control, then activate it. */
function activate(el: HTMLElement) {
  el.focus();
  fireEvent.click(el);
}

afterEach(cleanup);

describe('Chrome focus when the sidebar swaps', () => {
  it('entering settings from the profile row focuses the way back; leaving focuses the profile row', () => {
    mountNavigating('/machines');
    activate(screen.getByText('perfil'));
    expect(document.activeElement).toBe(screen.getByText('settings-sidebar'));
    activate(screen.getByText('settings-sidebar'));
    expect(document.activeElement).toBe(screen.getByText('perfil'));
  });

  it('does the same in the rail', () => {
    mountNavigating('/machines', true);
    activate(screen.getByText('ir às configurações'));
    expect(document.activeElement).toBe(screen.getByText('rail-settings'));
  });

  it('leaves focus alone when it is still on something in the page', () => {
    mountNavigating('/machines');
    activate(screen.getByText('link na página'));
    expect(screen.getByText('settings-sidebar')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByText('link na página'));
  });

  it('does not take focus when the app opens straight on settings', () => {
    mountNavigating('/settings/users');
    expect(document.activeElement).toBe(document.body);
  });
});

describe('Chrome', () => {
  it('shows the projects sidebar outside settings', () => {
    mount('/machines');
    expect(screen.getByText('projects-sidebar')).toBeTruthy();
    expect(screen.queryByText('settings-sidebar')).toBeNull();
  });

  it('swaps in the settings sidebar under /settings, wired to the way back', () => {
    const leave = mount('/settings/users');
    expect(screen.queryByText('projects-sidebar')).toBeNull();
    fireEvent.click(screen.getByText('settings-sidebar'));
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('hides all chrome in the office focus mode', () => {
    mount('/office?focus=1');
    expect(screen.queryByText('projects-sidebar')).toBeNull();
    expect(screen.queryByText('settings-sidebar')).toBeNull();
  });

  it('collapsed, shows the rail with the projects outside settings', () => {
    mount('/machines', true);
    expect(screen.getByText('rail-main')).toBeTruthy();
    expect(screen.queryByText('projects-sidebar')).toBeNull();
  });

  it('collapsed under /settings, shows the settings rail wired to the way back', () => {
    const leave = mount('/settings/users', true);
    fireEvent.click(screen.getByText('rail-settings'));
    expect(leave).toHaveBeenCalledTimes(1);
  });
});

/** A phone-sized window: only the md breakpoint query matches. */
function narrowWindow(narrow: boolean) {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({ matches: narrow && query === '(max-width: 767px)', media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList;
}

describe('Chrome below the md breakpoint', () => {
  beforeEach(() => narrowWindow(true));
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('shows the rail even when the stored preference is expanded', () => {
    mount('/machines', false);
    expect(screen.getByText('rail-main')).toBeTruthy();
    expect(screen.queryByText('projects-sidebar')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
  });

  it('expands as an overlay above the content, with a backdrop, leaving the stored preference alone', () => {
    const setCollapsed = vi.fn();
    mount('/machines', true, setCollapsed);
    fireEvent.click(screen.getByText('expandir'));
    const overlay = screen.getByRole('dialog', { name: 'Menu' });
    expect(within(overlay).getByText('projects-sidebar')).toBeTruthy();
    expect(screen.getByTestId('sidebar-backdrop')).toBeTruthy();
    expect(setCollapsed).not.toHaveBeenCalled();
  });

  it('closes on the backdrop', () => {
    mount('/machines');
    fireEvent.click(screen.getByText('expandir'));
    fireEvent.click(screen.getByTestId('sidebar-backdrop'));
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
  });

  it('closes on Escape', () => {
    mount('/machines');
    fireEvent.click(screen.getByText('expandir'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
  });

  it("closes from the sidebar's own collapse button", () => {
    mount('/machines');
    fireEvent.click(screen.getByText('expandir'));
    fireEvent.click(screen.getByText('recolher'));
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
  });

  it('closes when the user navigates', () => {
    mountNavigating('/machines');
    fireEvent.click(screen.getByText('expandir'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Menu' })).getByText('perfil'));
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
  });
});

describe('Chrome on a wide window', () => {
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('keeps the sidebar in the page flow, as before', () => {
    narrowWindow(false);
    mount('/machines', false);
    expect(screen.getByText('projects-sidebar')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
  });

  it('treats a browser without matchMedia as wide', () => {
    mount('/machines', false);
    expect(screen.getByText('projects-sidebar')).toBeTruthy();
  });

  it('expands in place from the rail through the stored preference', () => {
    narrowWindow(false);
    const setCollapsed = vi.fn();
    mount('/machines', true, setCollapsed);
    fireEvent.click(screen.getByText('expandir'));
    expect(setCollapsed).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
  });
});

describe('Layout chat dock', () => {
  const mountLayout = () =>
    render(
      <MemoryRouter initialEntries={['/machines']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/machines" element={<p>página</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

  it('puts the dock after main, in the same row', () => {
    mountLayout();
    const main = screen.getByRole('main');
    expect(main.nextElementSibling?.getAttribute('aria-label')).toBe('dock');
    expect(main.className).not.toContain('hidden');
  });

  it('sizes the row from --app-height (the keyboard-aware height ChatDock tracks), falling back to the full height', () => {
    mountLayout();
    expect(screen.getByRole('main').parentElement!.className).toContain('h-[var(--app-height,100%)]');
  });

  it('clips what leaks out of the row, so nothing inside can ever make the document taller or scrollable (TER-385)', () => {
    // `html`, `body` and `#root` are the window; the row is 100% of it. Anything laid out past the
    // row used to extend the document, and one wheel over a header (no scroller of its own) scrolled
    // the whole app up, leaving the sidebar, the terminal and the chat ending halfway down the page.
    mountLayout();
    expect(screen.getByRole('main').parentElement!.className).toContain('overflow-clip');
  });

  it('hides main (still mounted) while the shown chat is maximized', () => {
    dock.shownProjectId = 'p1';
    dock.maximized = true;
    mountLayout();
    expect(screen.getByText('página')).toBeTruthy();
    expect(screen.getByText('página').closest('main')!.className).toContain('hidden');
    dock.shownProjectId = null;
    dock.maximized = false;
  });
});
