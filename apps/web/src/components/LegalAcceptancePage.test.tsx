// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LegalStatus, LegalVersion } from '../lib/types';

const { authState, legalApi, dataMounted } = vi.hoisted(() => ({
  authState: {
    current: {
      user: { deletion_scheduled_at: null as string | null } as { deletion_scheduled_at: string | null } | null,
      loading: false,
      legal: { pending: [], upcoming: [] } as LegalStatus,
      setLegal: vi.fn(),
      logout: vi.fn(async () => {}),
    },
  },
  legalApi: { accept: vi.fn(async (): Promise<LegalStatus> => ({ pending: [], upcoming: [] })) },
  dataMounted: vi.fn(),
}));

vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
vi.mock('../lib/api', () => ({
  api: { legal: legalApi },
  ApiError: class ApiError extends Error {},
}));
vi.mock('../lib/data', () => ({
  DataProvider: ({ children }: { children: ReactNode }) => {
    dataMounted();
    return <>{children}</>;
  },
}));
vi.mock('../lib/monitor', () => ({ MonitorProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../lib/project-groups', () => ({ ProjectGroupsProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../lib/toast', () => ({ ToastProvider: ({ children }: { children: ReactNode }) => <>{children}</>, Toaster: () => null }));
vi.mock('./NeedsYouToasts', () => ({ NeedsYouToasts: () => null }));
vi.mock('./NicknamePrompt', () => ({ NicknamePrompt: () => null }));

import { AppShell } from './Layout';
import { LegalAcceptancePage } from './LegalAcceptancePage';
import { LegalConsent } from './LegalConsent';

const TERMS: LegalVersion = {
  id: 'v-terms-2',
  document: 'terms',
  version: '2',
  effective_at: '2026-10-01T12:00:00.000Z',
  url: 'https://termhub.dev/termos/',
  requires_acceptance: true,
  summary: 'Novas regras de uso.',
};
const PRIVACY: LegalVersion = {
  id: 'v-privacy-1',
  document: 'privacy',
  version: '1',
  effective_at: '2026-10-01T12:00:00.000Z',
  url: 'https://termhub.dev/privacidade/',
  requires_acceptance: true,
  summary: null,
};

function mountShell() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<p>app-home</p>} />
        </Route>
        <Route path="/login" element={<p>login-page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  authState.current = { ...authState.current, user: { deletion_scheduled_at: null }, legal: { pending: [], upcoming: [] } };
});

describe('legal acceptance gate', () => {
  it('AppShell shows the gate instead of the app while a version is pending, without mounting its providers', () => {
    authState.current = { ...authState.current, legal: { pending: [TERMS, PRIVACY], upcoming: [] } };
    mountShell();
    expect(screen.getByRole('heading', { name: 'Termos de Uso e Política de Privacidade' })).toBeInTheDocument();
    expect(screen.queryByText('app-home')).toBeNull();
    expect(dataMounted).not.toHaveBeenCalled();
  });

  it('AppShell shows the app when nothing is pending', () => {
    mountShell();
    expect(screen.getByText('app-home')).toBeInTheDocument();
  });

  it('the pending deletion page wins over the gate', () => {
    authState.current = { ...authState.current, user: { deletion_scheduled_at: '2026-10-31T12:00:00.000Z' }, legal: { pending: [TERMS], upcoming: [] } };
    mountShell();
    expect(screen.getByRole('button', { name: 'Cancelar exclusão' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Termos de Uso e Política de Privacidade' })).toBeNull();
  });

  it('lists each document and keeps Continuar disabled until the box is ticked, then accepts the pending ids', async () => {
    const after: LegalStatus = { pending: [], upcoming: [] };
    legalApi.accept.mockResolvedValueOnce(after);
    render(
      <MemoryRouter>
        <LegalAcceptancePage pending={[TERMS, PRIVACY]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Versão 2, em vigor desde 1 de outubro de 2026')).toBeInTheDocument();
    expect(screen.getByText('Novas regras de uso.')).toBeInTheDocument();
    const go = screen.getByRole('button', { name: 'Continuar' });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(go).toBeEnabled();
    await act(async () => {
      fireEvent.click(go);
    });
    expect(legalApi.accept).toHaveBeenCalledWith(['v-terms-2', 'v-privacy-1'], 'web');
    expect(authState.current.setLegal).toHaveBeenCalledWith(after);
  });

  it('shows the error inline when the accept fails', async () => {
    legalApi.accept.mockRejectedValueOnce(new Error('offline'));
    render(
      <MemoryRouter>
        <LegalAcceptancePage pending={[TERMS]} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    });
    expect(screen.getByText('Não foi possível registrar o aceite.')).toBeInTheDocument();
    expect(authState.current.setLegal).not.toHaveBeenCalled();
  });

  it('Sair logs out and goes to the login page', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<LegalAcceptancePage pending={[TERMS]} />} />
          <Route path="/login" element={<p>login-page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
    });
    expect(authState.current.logout).toHaveBeenCalledTimes(1);
    expect(legalApi.accept).not.toHaveBeenCalled();
    expect(screen.getByText('login-page')).toBeInTheDocument();
  });
});

describe('LegalConsent', () => {
  it('links both documents in a new tab', () => {
    render(<LegalConsent termsUrl={TERMS.url} privacyUrl={PRIVACY.url} checked={false} onChange={() => {}} />);
    const terms = screen.getByRole('link', { name: 'Termos de Uso' });
    expect(terms).toHaveAttribute('href', TERMS.url);
    expect(terms).toHaveAttribute('target', '_blank');
    expect(terms.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('link', { name: 'Política de Privacidade' })).toHaveAttribute('href', PRIVACY.url);
  });

  it('names only the documents it has a URL for', () => {
    render(<LegalConsent privacyUrl={PRIVACY.url} checked={false} onChange={() => {}} />);
    expect(screen.getByRole('link', { name: 'Política de Privacidade' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Termos de Uso' })).toBeNull();
  });

  it('reports the tick', () => {
    const onChange = vi.fn();
    render(<LegalConsent termsUrl={TERMS.url} checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
