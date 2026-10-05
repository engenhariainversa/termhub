import { Building2, MessageSquare, Monitor, type LucideIcon } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { useAuth } from '../lib/auth';
import { useMonitor } from '../lib/monitor';

interface Item {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Escritório's "someone needs you" dot */
  dot: boolean;
}

/**
 * The daily menus — Escritório, Chat, Máquinas — each under its permission (spec 2026-09-23 app
 * chrome §3). `list` is the open sidebar's rows; `rail` the collapsed sidebar's icons, named by label.
 */
export function MainNav({ variant }: { variant: 'list' | 'rail' }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { needsYou } = useMonitor();
  const items: Item[] = [];
  if (can('projects', 'read') && can('terminals', 'read')) items.push({ to: '/office', label: t('Escritório'), icon: Building2, dot: needsYou.length > 0 });
  if (can('chat')) items.push({ to: '/chat', label: t('Chat'), icon: MessageSquare, dot: false });
  if (can('machines')) items.push({ to: '/machines', label: t('Máquinas'), icon: Monitor, dot: false });
  if (items.length === 0) return null;

  if (variant === 'rail') {
    return (
      <nav aria-label={t('Menu principal')} className="flex w-full shrink-0 flex-col items-center gap-1 border-t border-line py-2">
        {items.map(({ to, label, icon: Icon, dot }) => (
          <NavLink
            key={to}
            to={to}
            aria-label={dot ? t('{{label}}, alguém precisa de você', { label }) : label}
            title={label}
            className={({ isActive }) => `relative flex h-8 w-8 items-center justify-center rounded ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}
          >
            <Icon size={18} aria-hidden="true" />
            {dot && <i aria-hidden="true" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-attention" />}
          </NavLink>
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label={t('Menu principal')} className="shrink-0 border-t border-line px-3 py-1.5">
      {items.map(({ to, label, icon: Icon, dot }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => `flex items-center gap-2 rounded px-2 py-1 text-xs ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}
        >
          <Icon size={16} aria-hidden="true" />
          <span className="flex-1">{label}</span>
          {dot && <i className="h-1.5 w-1.5 rounded-full bg-attention" aria-label={t('alguém precisa de você')} />}
        </NavLink>
      ))}
    </nav>
  );
}
