// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    config: { modes: ['app'], password: true, google: true },
    login: vi.fn(),
    sendCode: vi.fn(),
    verifyCode: vi.fn(),
  }),
}));

import { LoginPage } from './LoginPage';

beforeEach(() => {
  void i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  void i18n.changeLanguage('pt-BR');
});

describe('LoginPage in English', () => {
  it('shows the sign-in screen in English', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("Your machines' terminals, in the browser.")).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get a code by email' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with a password' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sign in with Google/ })).toBeInTheDocument();
  });

  it('translates an OAuth error kept as a key in a table', () => {
    render(
      <MemoryRouter initialEntries={['/login?error=google_denied']}>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Google sign-in canceled.')).toBeInTheDocument();
  });
});
