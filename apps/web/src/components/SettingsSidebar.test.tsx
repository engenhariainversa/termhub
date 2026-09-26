// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ can: (() => true) as (resource: string, action?: string) => boolean }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: authState.can }) }));

import { SettingsSidebar } from './SettingsSidebar';

function mount(path = '/settings/profile', onCollapse?: () => void) {
  const onBack = vi.fn();
  render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsSidebar onBack={onBack} onCollapse={onCollapse} />
    </MemoryRouter>,
  );
  return onBack;
}
const linksOf = (group: string) =>
  within(screen.getByRole('group', { name: group }))
    .getAllByRole('link')
    .map((l) => [l.textContent, l.getAttribute('href')]);

beforeEach(() => {
  authState.can = () => true;
});
afterEach(cleanup);

describe('SettingsSidebar', () => {
  it('lists the sections under Conta and Administração, with icons', () => {
    mount();
    expect(linksOf('Conta')).toEqual([
      ['Perfil', '/settings/profile'],
      ['Minha cidade', '/settings/city'],
      ['Integrações', '/settings/integrations'],
      ['Tokens de API', '/settings/api-tokens'],
      ['Aparelhos', '/settings/devices'],
      ['Abas confiáveis', '/settings/chat-grants'],
      ['Contas de IA', '/settings/ai'],
      ['Hardware', '/settings/hardware'],
    ]);
    expect(linksOf('Administração')).toEqual([
      ['Usuários', '/settings/users'],
      ['Waitlist', '/settings/waitlist'],
      ['Roles', '/settings/roles'],
      ['Permissões', '/settings/permissions'],
      ['Arquivos', '/settings/uploads'],
    ]);
    expect(screen.getByRole('link', { name: 'Perfil' }).querySelector('svg')).not.toBeNull();
  });

  it('shows only Conta to a user with no admin grants', () => {
    authState.can = () => false;
    mount();
    expect(linksOf('Conta')).toEqual([
      ['Perfil', '/settings/profile'],
      ['Minha cidade', '/settings/city'],
    ]);
    expect(screen.queryByRole('group', { name: 'Administração' })).toBeNull();
    expect(screen.queryByText('Administração')).toBeNull();
  });

  it('marks the open section', () => {
    mount('/settings/users');
    expect(screen.getByRole('link', { name: 'Usuários' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Perfil' })).not.toHaveAttribute('aria-current');
  });

  it('goes back from its header', () => {
    const onBack = mount();
    expect(screen.getByRole('button', { name: 'Voltar de Configurações' })).toHaveAttribute('data-chrome-focus', 'settings-back');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar de Configurações' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('collapses only when the layout allows it', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Recolher sidebar' })).toBeNull();
    cleanup();
    const onCollapse = vi.fn();
    mount('/settings/profile', onCollapse);
    fireEvent.click(screen.getByRole('button', { name: 'Recolher sidebar' }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('slides in', () => {
    mount();
    expect(screen.getByRole('complementary', { name: 'Configurações' })).toHaveClass('chrome-slide-in');
  });
});
