// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from '../lib/types';

const { authState } = vi.hoisted(() => ({ authState: { config: null as Partial<AuthConfig> | null } }));
vi.mock('../lib/auth', () => ({ useAuth: () => authState }));

import { LegalLinks } from './LegalLinks';

afterEach(() => {
  cleanup();
  authState.config = null;
});

describe('LegalLinks', () => {
  it('renders nothing before the config arrives or when the instance has no documents', () => {
    const { container } = render(<LegalLinks />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    authState.config = { terms_url: null, privacy_url: null };
    expect(render(<LegalLinks />).container).toBeEmptyDOMElement();
  });

  it('links both documents in a new tab', () => {
    authState.config = { terms_url: 'https://example.com/termos/', privacy_url: 'https://example.com/privacidade/' };
    render(<LegalLinks />);
    const terms = screen.getByRole('link', { name: 'Termos de uso' });
    expect(terms).toHaveAttribute('href', 'https://example.com/termos/');
    expect(terms).toHaveAttribute('target', '_blank');
    expect(terms).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: 'Política de privacidade' })).toHaveAttribute('href', 'https://example.com/privacidade/');
  });

  it('shows only the document that is set', () => {
    authState.config = { terms_url: null, privacy_url: 'https://example.com/privacidade/' };
    render(<LegalLinks />);
    expect(screen.queryByRole('link', { name: 'Termos de uso' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Política de privacidade' })).toBeInTheDocument();
  });
});
