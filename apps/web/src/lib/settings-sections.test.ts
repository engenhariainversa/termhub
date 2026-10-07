import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, settingsGroups, visibleSettingsSections } from './settings-sections';

const keysOf = (groups: ReturnType<typeof settingsGroups>) => groups.map((g) => [g.label, g.sections.map((s) => s.key)]);

describe('settings sections', () => {
  it('lists Conta, then Administração, in the settings sidebar order', () => {
    expect(SETTINGS_SECTIONS.map((s) => `${s.group}:${s.key}`)).toEqual([
      'account:profile',
      'account:city',
      'account:security',
      'account:integrations',
      'account:api-tokens',
      'account:devices',
      'account:chat-grants',
      'account:ai',
      'account:hardware',
      'admin:users',
      'admin:waitlist',
      'admin:roles',
      'admin:permissions',
      'admin:uploads',
    ]);
  });

  it('puts Segurança under Conta, for every signed-in user', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'security')).toEqual({ key: 'security', label: 'Segurança', resource: null, group: 'account' });
  });

  it('opens on Perfil, which every signed-in user sees', () => {
    expect(DEFAULT_SETTINGS_SECTION).toBe('profile');
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'profile')).toEqual({ key: 'profile', label: 'Perfil', resource: null, group: 'account' });
    expect(visibleSettingsSections(() => false).map((s) => s.key)).toEqual(['profile', 'city', 'security']);
    expect(visibleSettingsSections(() => true)[0]?.key).toBe('profile');
  });

  it('puts Contas de IA and Hardware under Conta, gated by their resources', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'ai')).toEqual({ key: 'ai', label: 'Contas de IA', resource: 'ai_accounts', group: 'account' });
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'hardware')).toEqual({ key: 'hardware', label: 'Hardware', resource: 'hardware', group: 'account' });
    expect(visibleSettingsSections((r) => r === 'hardware').map((s) => s.key)).toEqual(['profile', 'city', 'security', 'hardware']);
  });

  it('puts the Waitlist under Administração, gated by its resource', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'waitlist')).toEqual({ key: 'waitlist', label: 'Waitlist', resource: 'waitlist', group: 'admin' });
    expect(visibleSettingsSections((r) => r === 'waitlist').map((s) => s.key)).toEqual(['profile', 'city', 'security', 'waitlist']);
  });

  it('gates Integrações and Tokens de API by their resource', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'integrations')).toEqual({ key: 'integrations', label: 'Integrações', resource: 'integrations', group: 'account' });
    expect(visibleSettingsSections((r) => r === 'api_tokens').map((s) => s.key)).toEqual(['profile', 'city', 'security', 'api-tokens']);
    expect(visibleSettingsSections((r) => r === 'integrations').map((s) => s.key)).toEqual(['profile', 'city', 'security', 'integrations']);
  });

  it('keeps the admin sections under their current resources', () => {
    expect(visibleSettingsSections((r) => r === 'roles').map((s) => s.key)).toEqual(['profile', 'city', 'security', 'roles', 'permissions']);
    expect(visibleSettingsSections((r) => r === 'users').map((s) => s.key)).toEqual(['profile', 'city', 'security', 'users']);
  });

  it('puts Permissões do chat under Conta, gated by the chat resource', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'chat-grants')).toEqual({ key: 'chat-grants', label: 'Permissões do chat', resource: 'chat', group: 'account' });
    expect(visibleSettingsSections((r) => r === 'chat').map((s) => s.key)).toEqual(['profile', 'city', 'security', 'chat-grants']);
  });

  it('leaves Administração out when nothing in it is visible', () => {
    expect(keysOf(settingsGroups(() => false))).toEqual([['Conta', ['profile', 'city', 'security']]]);
    expect(keysOf(settingsGroups((r) => r === 'uploads'))).toEqual([
      ['Conta', ['profile', 'city', 'security']],
      ['Administração', ['uploads']],
    ]);
  });
});
