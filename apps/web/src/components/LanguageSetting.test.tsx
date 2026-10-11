// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n, setLocale as applyLocale } from '../i18n';
import type { User } from '../lib/types';

const { authState } = vi.hoisted(() => ({
  authState: { current: { user: null as Partial<User> | null, setLocale: vi.fn(async (_l: 'pt-BR' | 'en' | null) => {}) } },
}));
vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));

import { LanguageSetting } from './LanguageSetting';

afterEach(() => {
  cleanup();
  localStorage.clear();
  void i18n.changeLanguage('pt-BR');
});

describe('Configurações → Perfil → Idioma', () => {
  it('offers Automático and each language in its own words', () => {
    authState.current = { ...authState.current, user: { locale: null } };
    render(<LanguageSetting />);
    const select = screen.getByLabelText('Idioma');
    expect(select).toHaveValue('auto');
    expect(screen.getByRole('option', { name: 'Automático' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Português (Brasil)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'English' })).toBeInTheDocument();
  });

  it('saves the choice on the account, and the screen follows', async () => {
    const setLocale = vi.fn(async (l: 'pt-BR' | 'en' | null) => applyLocale(l));
    authState.current = { user: { locale: null }, setLocale };
    render(<LanguageSetting />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Idioma'), { target: { value: 'en' } });
    });
    expect(setLocale).toHaveBeenCalledWith('en');
    // now in English, while the language names stay in their own words
    expect(screen.getByLabelText('Language')).toHaveValue('en');
    expect(screen.getByRole('option', { name: 'Automatic' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Português (Brasil)' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });

  it('shows the account choice, and the browser one on a server that does not send it', () => {
    authState.current = { ...authState.current, user: { locale: 'en' } };
    const { unmount } = render(<LanguageSetting />);
    expect(screen.getByLabelText('Idioma')).toHaveValue('en');
    unmount();
    localStorage.setItem('termhub:locale', 'pt-BR');
    authState.current = { ...authState.current, user: {} };
    render(<LanguageSetting />);
    expect(screen.getByLabelText('Idioma')).toHaveValue('pt-BR');
  });

  it('goes back and says why when the account refuses', async () => {
    authState.current = { user: { locale: null }, setLocale: vi.fn(async () => Promise.reject(new Error('offline'))) };
    render(<LanguageSetting />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Idioma'), { target: { value: 'en' } });
    });
    expect(screen.getByLabelText('Idioma')).toHaveValue('auto');
    expect(screen.getByText('Não foi possível salvar o idioma.')).toBeInTheDocument();
  });
});
