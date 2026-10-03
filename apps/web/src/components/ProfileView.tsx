import { LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ANALYTICS_ENABLED } from '../lib/analytics';
import { useAuth } from '../lib/auth';
import { openCookieBanner } from './AnalyticsGate';
import { Avatar } from './Avatar';
import { LegalLinks } from './LegalLinks';
import { ViewAsSwitch } from './ViewAsSwitch';

/**
 * Configurações → Perfil (spec 2026-09-23 app chrome §4.1): who is signed in, and what used to sit in
 * the sidebar's profile row — the admin's "Ver como…" (ViewAsSwitch renders nothing for others), the
 * cookie choice when analytics is on, and Sair.
 */
export function ProfileView() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="space-y-4">
      <section aria-label="Conta" className="flex items-center gap-3 rounded-lg border border-line bg-bg-2 p-4">
        <Avatar user={user} size={40} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{user?.name}</p>
          <p className="truncate text-xs text-fg-muted">{user?.email}</p>
        </div>
      </section>
      <ViewAsSwitch />
      <div className="flex flex-wrap gap-2">
        {ANALYTICS_ENABLED && (
          <button type="button" className="btn-ghost" onClick={openCookieBanner}>
            Preferências de cookies
          </button>
        )}
        <button type="button" className="btn-ghost text-danger" onClick={() => void logout().then(() => navigate('/login'))}>
          <LogOut size={16} aria-hidden="true" />
          Sair
        </button>
      </div>
      <LegalLinks />
    </div>
  );
}
