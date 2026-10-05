import { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { useAuth } from '../lib/auth';
import { DataProvider } from '../lib/data';
import { FocusProvider, useFocusMode } from '../lib/focus';
import { MonitorProvider } from '../lib/monitor';
import { useNarrowWindow } from '../lib/narrow-window';
import { ProjectChatProvider, useProjectChat } from '../lib/project-chat';
import { ProjectGroupsProvider } from '../lib/project-groups';
import { isSettingsPath, useSettingsExit } from '../lib/settings-nav';
import { ToastProvider, Toaster } from '../lib/toast';
import { ChatDock } from './chat/ChatDock';
import { DeviceRequestBanner } from './DeviceRequestBanner';
import { NeedsYouToasts } from './NeedsYouToasts';
import { SettingsSidebar } from './SettingsSidebar';
import { SidebarRail } from './SidebarRail';
import { Sidebar } from './Sidebar';
import { NicknamePrompt } from './NicknamePrompt';
import { PendingDeletionPage } from './PendingDeletionPage';
import { useEscapeLayer } from './Modal';

const SIDEBAR_KEY = 'termhub:sidebar-collapsed';

/**
 * Everything signed-in routes need that isn't visual chrome: the auth guard, the
 * data/monitor/toast providers and the "precisando de você" overlays. Both the sidebar layout
 * (`Layout`) and the chat's full-screen layout (`ChatLayout`) render under this, so a chat page
 * still receives monitor pushes and toasts.
 */
export function AppShell() {
  const { user, loading } = useAuth();
  const { t } = useTranslation();

  if (loading) return <FullScreenMessage>{t('Carregando…')}</FullScreenMessage>;
  if (!user) return <Navigate to="/login" replace />;
  // A deactivated account (deletion pending) gets only the page that lets it cancel.
  if (user.deletion_scheduled_at) return <PendingDeletionPage scheduledAt={user.deletion_scheduled_at} />;
  return (
    <DataProvider>
      <MonitorProvider>
        <ProjectGroupsProvider>
          <ToastProvider>
            <Outlet />
            <NeedsYouToasts />
            <NicknamePrompt />
            <Toaster />
          </ToastProvider>
        </ProjectGroupsProvider>
      </MonitorProvider>
    </DataProvider>
  );
}

export function Layout() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');
  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  }, [collapsed]);
  // remembers the last page outside settings and answers Esc under settings (lib/settings-nav)
  const leaveSettings = useSettingsExit();

  return (
    <FocusProvider>
      <ProjectChatProvider>
        <LayoutRow collapsed={collapsed} setCollapsed={setCollapsed} onLeaveSettings={leaveSettings} />
      </ProjectChatProvider>
    </FocusProvider>
  );
}

/**
 * The app's row: sidebar, page, and the project chat dock after the page (spec 2026-09-26 project chat
 * dock §4.5). Inside the chat provider, since it reads whether the shown chat fills the window: then
 * the page is hidden, not unmounted, so the terminals behind it keep their sessions (TerminalsView
 * ignores the 0×0 reading).
 */
function LayoutRow({ collapsed, setCollapsed, onLeaveSettings }: { collapsed: boolean; setCollapsed: (v: boolean) => void; onLeaveSettings: () => void }) {
  const { can } = useAuth();
  const { shownProjectId, pref } = useProjectChat();
  const narrow = useNarrowWindow();
  const maximized = shownProjectId !== null && !narrow && pref(shownProjectId).maximized;
  // `--app-height` is the height the on-screen keyboard leaves, tracked by ChatDock while a chat is
  // shown on a touch screen (lib/viewport); otherwise unset — on every desktop, and on a touch screen
  // without a chat — and the row is the full height it always was.
  //
  // `overflow-clip`: the row is the window (`html`, `body` and `#root` are 100% of it), and every
  // page scrolls inside its own region, so the document itself must never scroll. Anything laid out
  // past the row — a leak from a panel, a terminal, a banner — used to extend the document instead,
  // and one wheel over a header (which has no scroller of its own) scrolled the whole app up: the
  // sidebar, the terminal and the chat ended halfway down the page with empty background below
  // (TER-385). `clip` cuts such a leak at the row's edge, which is the window's edge, and unlike
  // `hidden` it makes no scroll container: nothing, not even a focus, can scroll the row. Fixed
  // descendants (toasts, modals, the dock's hidden panels) are not clipped by it.
  return (
    <div className="flex h-[var(--app-height,100%)] overflow-clip">
      <Chrome collapsed={collapsed} setCollapsed={setCollapsed} onLeaveSettings={onLeaveSettings} />
      <main className={`relative min-w-0 flex-1 ${maximized ? 'hidden' : ''}`}>
        <DeviceRequestBanner />
        <Outlet />
      </main>
      {can('chat') && <ChatDock />}
    </div>
  );
}

/**
 * The sidebar slot: Configurações' own sidebar under /settings, the projects sidebar elsewhere, the
 * rail when collapsed. Hidden entirely while the page is in focus mode — only `/office` has one (lib/focus).
 * On a narrow window the rail is always what sits in the page, whatever the stored preference, and
 * expanding it opens the sidebar as an overlay above the content (backdrop, Esc and navigating close
 * it) instead of pushing the content aside; the stored preference is left for wide windows.
 */
export function Chrome({ collapsed, setCollapsed, onLeaveSettings }: { collapsed: boolean; setCollapsed: (v: boolean) => void; onLeaveSettings: () => void }) {
  const { t } = useTranslation();
  const { focus } = useFocusMode();
  const { pathname } = useLocation();
  const settings = isSettingsPath(pathname);
  const narrow = useNarrowWindow();
  const [overlay, setOverlay] = useState(false);
  const closeOverlay = () => setOverlay(false);
  useEffect(() => setOverlay(false), [pathname, narrow]);
  useEscapeLayer(narrow && overlay, closeOverlay);
  useSwapFocus(settings);
  if (focus) return null;
  const mode = settings ? 'settings' : 'main';
  if (narrow) {
    return (
      <>
        <SidebarRail mode={mode} onExpand={() => setOverlay(true)} onBack={onLeaveSettings} />
        {overlay && (
          <>
            <div data-testid="sidebar-backdrop" aria-hidden="true" className="fixed inset-0 z-40 bg-black/50" onClick={closeOverlay} />
            <div role="dialog" aria-modal="true" aria-label={t('Menu')} className="fixed inset-y-0 left-0 z-50 flex max-w-[85vw] shadow-2xl">
              {settings ? <SettingsSidebar onBack={onLeaveSettings} onCollapse={closeOverlay} /> : <Sidebar onCollapse={closeOverlay} />}
            </div>
          </>
        )}
      </>
    );
  }
  if (collapsed) return <SidebarRail mode={mode} onExpand={() => setCollapsed(false)} onBack={onLeaveSettings} />;
  if (settings) return <SettingsSidebar onBack={onLeaveSettings} onCollapse={() => setCollapsed(true)} />;
  return <Sidebar onCollapse={() => setCollapsed(true)} />;
}

/**
 * Swapping the sidebar unmounts the control that was pressed (the profile row, Voltar), dropping focus
 * on <body>. Hand it to the new sidebar's counterpart: the way back when entering settings, the
 * profile button when leaving. Only when focus was actually lost, and never on the first render, so a
 * page opened straight on settings or a link pressed in the page keeps its focus.
 */
function useSwapFocus(settings: boolean) {
  const previous = useRef(settings);
  useEffect(() => {
    if (previous.current === settings) return;
    previous.current = settings;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    document.querySelector<HTMLElement>(`[data-chrome-focus="${settings ? 'settings-back' : 'profile'}"]`)?.focus();
  }, [settings]);
}

export function FullScreenMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-fg-muted">{children}</div>;
}
