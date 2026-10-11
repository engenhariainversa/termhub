import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { useTranslation } from './i18n';
import { NavigatorBridge } from './lib/app-navigate';
import { FilePage } from './pages/FilePage';
import { AnalyticsGate } from './components/AnalyticsGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppShell, FullScreenMessage, Layout } from './components/Layout';
import { ChatLayout } from './components/ChatLayout';
import { retryOnceOnImportFailure } from './lib/lazy-retry';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { ProjectPage } from './pages/ProjectPage';
import { CardPage } from './pages/CardPage';
import { ChatPage } from './pages/ChatPage';
import { ChatMemoryPage } from './pages/ChatMemoryPage';
import { MachinesPage } from './pages/MachinesPage';
import { SettingsPage } from './pages/SettingsPage';

// lazy so PixiJS stays out of the main bundle; the retry survives the chunk hashes a deploy changes
const OfficePage = lazy(retryOnceOnImportFailure(() => import('./pages/OfficePage').then((m) => ({ default: m.OfficePage }))));

/** The one lazy route: a failed import must show a way out, not unmount the app. */
function OfficeRoute() {
  const { t } = useTranslation();
  return (
    <ErrorBoundary fallback={<RouteFailed />}>
      <Suspense fallback={<FullScreenMessage>{t('Carregando…')}</FullScreenMessage>}>
        <OfficePage />
      </Suspense>
    </ErrorBoundary>
  );
}

function RouteFailed() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-fg-muted">
      <span>{t('Não foi possível carregar esta página.')}</span>
      <button className="rounded border border-line px-3 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => location.reload()}>
        {t('Recarregar')}
      </button>
    </div>
  );
}

/** The route table, apart from the router and providers so a test can mount it in a MemoryRouter. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppShell />}>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          {/* the old Integrações page and the old Início tabs are settings sections now; inside Layout so the layout (and
              what it remembers about the page before settings) survives the redirect */}
          <Route path="/integrations" element={<Navigate to="/settings/integrations" replace />} />
          <Route path="/ai" element={<Navigate to="/settings/ai" replace />} />
          <Route path="/hardware" element={<Navigate to="/settings/hardware" replace />} />
          <Route path="/waitlist" element={<Navigate to="/settings/waitlist" replace />} />
          <Route path="/machines" element={<MachinesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/:section" element={<SettingsPage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/projects/:id/:section" element={<ProjectPage />} />
          {/* a card's own URL (spec §7): TER-12 = project key + card number */}
          <Route path="/project/:ref" element={<CardPage />} />
          <Route path="/office" element={<OfficeRoute />} />
          <Route path="/office/:projectId" element={<OfficeRoute />} />
          <Route path="/files" element={<FilePage />} />
        </Route>
        <Route element={<ChatLayout />}>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/memoria" element={<ChatMemoryPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <NavigatorBridge />
      <AuthProvider>
        <AnalyticsGate>
          <AppRoutes />
        </AnalyticsGate>
      </AuthProvider>
    </BrowserRouter>
  );
}
