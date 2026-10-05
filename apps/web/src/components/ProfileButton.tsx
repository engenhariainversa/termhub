import { Settings as SettingsIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { useAuth } from '../lib/auth';
import { viewAsLabel } from '../lib/view-as';
import { Avatar } from './Avatar';

/**
 * The way into Configurações (spec 2026-09-23 app chrome §3, §5): the whole profile row — avatar,
 * name, gear — is one button that opens Perfil; in the rail, just the avatar. While an admin's
 * "Ver como" is on, both say so in warning colours: the switch itself lives in Perfil, and nothing
 * else on screen would tell that the machines shown are someone else's. The accessible name starts
 * with the visible name (WCAG 2.5.3).
 */
export function ProfileButton({ variant }: { variant: 'row' | 'rail' }) {
  const { t } = useTranslation();
  const { user, viewAs } = useAuth();
  const navigate = useNavigate();
  const open = () => navigate('/settings/profile');
  const viewing = viewAsLabel(viewAs);
  const name = [user?.name ? t('{{name}} — configurações e perfil', { name: user.name }) : t('Configurações e perfil'), viewing].filter(Boolean).join(' — ');

  if (variant === 'rail') {
    return (
      <button
        type="button"
        data-chrome-focus="profile"
        className={`relative mb-2 shrink-0 rounded-full p-1 hover:bg-bg-3 ${viewing ? 'ring-2 ring-warn' : ''}`}
        onClick={open}
        aria-label={name}
        title={name}
      >
        <Avatar user={user} size={28} />
        {viewing && <i data-view-as aria-hidden="true" className="absolute right-0 top-0 h-2 w-2 rounded-full bg-warn" />}
      </button>
    );
  }
  return (
    <button
      type="button"
      data-chrome-focus="profile"
      className={`flex w-full shrink-0 items-center gap-2 border-t px-3 py-2 text-left ${viewing ? 'border-warn/40 bg-warn/10 hover:bg-warn/20' : 'border-line hover:bg-bg-3'}`}
      onClick={open}
      aria-label={name}
      title={user?.email}
    >
      <Avatar user={user} size={24} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-fg-muted">{user?.name}</span>
        {viewing && <span className="truncate text-[11px] text-warn">{viewing}</span>}
      </span>
      <SettingsIcon size={16} aria-hidden="true" className="shrink-0 text-fg-dim" />
    </button>
  );
}
