import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { ANALYTICS_ENABLED } from '../lib/analytics';
import { useAuth } from '../lib/auth';
import { openCookieBanner } from './AnalyticsGate';
import { Avatar } from './Avatar';
import { DeleteAccountDialog } from './DeleteAccountDialog';
import { LanguageSetting } from './LanguageSetting';
import { ViewAsSwitch } from './ViewAsSwitch';

/**
 * Configurações → Perfil (spec 2026-09-23 app chrome §4.1): who is signed in, and what used to sit in
 * the sidebar's profile row — the admin's "Ver como…" (ViewAsSwitch renders nothing for others), the
 * cookie choice when analytics is on, Sair, and the danger zone to delete one's own account (TER-720).
 */
export function ProfileView() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="space-y-4">
      <section aria-label={t('Conta')} className="flex items-center gap-3 rounded-lg border border-line bg-bg-2 p-4">
        <Avatar user={user} size={40} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{user?.name}</p>
          <p className="truncate text-xs text-fg-muted">{user?.email}</p>
        </div>
      </section>
      <LanguageSetting />
      <ViewAsSwitch />
      <div className="flex flex-wrap gap-2">
        {ANALYTICS_ENABLED && (
          <button type="button" className="btn-ghost" onClick={openCookieBanner}>
            {t('Preferências de cookies')}
          </button>
        )}
        <button type="button" className="btn-ghost text-danger" onClick={() => void logout().then(() => navigate('/login'))}>
          <LogOut size={16} aria-hidden="true" />
          {t('Sair')}
        </button>
      </div>
      <section aria-label={t('Excluir minha conta')} className="rounded-lg border border-danger/40 p-4">
        <h3 className="text-sm font-semibold text-danger">{t('Excluir minha conta')}</h3>
        <p className="mt-1 text-xs text-fg-muted">
          {t('A conta é desativada na hora e excluída com todos os seus dados 30 dias depois. Até lá, dá para cancelar entrando de novo.')}
        </p>
        <button type="button" className="btn-danger mt-3" onClick={() => setDeleting(true)}>
          {t('Excluir minha conta')}
        </button>
      </section>
      {deleting && <DeleteAccountDialog open onClose={() => setDeleting(false)} />}
    </div>
  );
}
