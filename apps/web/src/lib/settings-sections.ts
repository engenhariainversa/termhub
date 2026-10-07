import { tk } from '../i18n';

/**
 * Configurações' sections in the settings sidebar's order, the resource that unlocks each and the
 * heading each sits under (spec 2026-09-23 app chrome §4). `resource: null` is a section every
 * signed-in user sees; Perfil is one, so `/settings` always has somewhere to land.
 */
export type SettingsSection = 'profile' | 'city' | 'security' | 'integrations' | 'api-tokens' | 'devices' | 'chat-grants' | 'ai' | 'hardware' | 'users' | 'waitlist' | 'roles' | 'permissions' | 'uploads';
export type SettingsGroupId = 'account' | 'admin';

export interface SettingsSectionInfo {
  key: SettingsSection;
  /** a pt-BR key: show it with t(section.label) */
  label: string;
  resource: string | null;
  group: SettingsGroupId;
}

export const SETTINGS_SECTIONS: SettingsSectionInfo[] = [
  { key: 'profile', label: tk('Perfil'), resource: null, group: 'account' },
  { key: 'city', label: tk('Minha cidade'), resource: null, group: 'account' },
  { key: 'security', label: tk('Segurança'), resource: null, group: 'account' },
  { key: 'integrations', label: tk('Integrações'), resource: 'integrations', group: 'account' },
  { key: 'api-tokens', label: tk('Tokens de API'), resource: 'api_tokens', group: 'account' },
  { key: 'devices', label: tk('Aparelhos'), resource: 'devices', group: 'account' },
  { key: 'chat-grants', label: tk('Permissões do chat'), resource: 'chat', group: 'account' },
  { key: 'ai', label: tk('Contas de IA'), resource: 'ai_accounts', group: 'account' },
  { key: 'hardware', label: tk('Hardware'), resource: 'hardware', group: 'account' },
  { key: 'users', label: tk('Usuários'), resource: 'users', group: 'admin' },
  { key: 'waitlist', label: tk('Waitlist'), resource: 'waitlist', group: 'admin' },
  { key: 'roles', label: tk('Roles'), resource: 'roles', group: 'admin' },
  { key: 'permissions', label: tk('Permissões'), resource: 'roles', group: 'admin' },
  { key: 'uploads', label: tk('Arquivos'), resource: 'uploads', group: 'admin' },
];

/** where `/settings` lands, and where an address this role cannot open falls back to */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'profile';

const GROUP_LABEL: Record<SettingsGroupId, string> = { account: tk('Conta'), admin: tk('Administração') };

export function visibleSettingsSections(can: (resource: string) => boolean): SettingsSectionInfo[] {
  return SETTINGS_SECTIONS.filter((s) => s.resource === null || can(s.resource));
}

/** The visible sections under their headings; a heading with nothing visible under it is left out. */
export function settingsGroups(can: (resource: string) => boolean): { id: SettingsGroupId; label: string; sections: SettingsSectionInfo[] }[] {
  const visible = visibleSettingsSections(can);
  return (Object.keys(GROUP_LABEL) as SettingsGroupId[])
    .map((id) => ({ id, label: GROUP_LABEL[id], sections: visible.filter((s) => s.group === id) }))
    .filter((g) => g.sections.length > 0);
}
