// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LegalStatus, LegalVersion } from '../lib/types';

const { authState, legalApi } = vi.hoisted(() => ({
  authState: {
    current: {
      legal: { pending: [], upcoming: [] } as LegalStatus,
      setLegal: vi.fn(),
    },
  },
  legalApi: { accept: vi.fn(async (): Promise<LegalStatus> => ({ pending: [], upcoming: [] })) },
}));

vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
vi.mock('../lib/api', () => ({ api: { legal: legalApi } }));

import { LegalNoticeBanner } from './LegalNoticeBanner';

const TERMS: LegalVersion = {
  id: 'v-terms-3',
  document: 'terms',
  version: '3',
  effective_at: '2026-11-06T12:00:00.000Z',
  url: 'https://termhub.dev/termos/',
  requires_acceptance: true,
  summary: null,
};
const PRIVACY: LegalVersion = { ...TERMS, id: 'v-privacy-2', document: 'privacy', version: '2', url: 'https://termhub.dev/privacidade/' };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  authState.current = { ...authState.current, legal: { pending: [], upcoming: [] } };
});

describe('LegalNoticeBanner', () => {
  it('renders nothing when no change is coming', () => {
    const { container } = render(<LegalNoticeBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('tells which documents change and when, with a link to each', () => {
    authState.current = { ...authState.current, legal: { pending: [], upcoming: [TERMS, PRIVACY] } };
    render(<LegalNoticeBanner />);
    expect(screen.getByText(/Os Termos de Uso mudam em 6 de novembro de 2026\./)).toBeInTheDocument();
    expect(screen.getByText(/A Política de Privacidade muda em 6 de novembro de 2026\./)).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Ver o que muda' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual([TERMS.url, PRIVACY.url]);
  });

  it('closing hides it and remembers it for these versions', () => {
    authState.current = { ...authState.current, legal: { pending: [], upcoming: [TERMS] } };
    render(<LegalNoticeBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar aviso' }));
    expect(screen.queryByText(/Os Termos de Uso mudam/)).toBeNull();
    cleanup();
    render(<LegalNoticeBanner />);
    expect(screen.queryByText(/Os Termos de Uso mudam/)).toBeNull();
    // a newer version shows it again
    authState.current = { ...authState.current, legal: { pending: [], upcoming: [{ ...TERMS, id: 'v-terms-4' }] } };
    cleanup();
    render(<LegalNoticeBanner />);
    expect(screen.getByText(/Os Termos de Uso mudam/)).toBeInTheDocument();
  });

  it('Li e aceito accepts the upcoming versions early', async () => {
    authState.current = { ...authState.current, legal: { pending: [], upcoming: [TERMS, PRIVACY] } };
    render(<LegalNoticeBanner />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Li e aceito' }));
    });
    expect(legalApi.accept).toHaveBeenCalledWith(['v-terms-3', 'v-privacy-2'], 'web');
    expect(authState.current.setLegal).toHaveBeenCalledWith({ pending: [], upcoming: [] });
  });
});
