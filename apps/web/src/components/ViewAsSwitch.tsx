import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { User } from '../lib/types';
import { viewAsLabel } from '../lib/view-as';
import { Combobox } from './Combobox';

/**
 * Admin-only data-scope switch: the app normally shows an admin their own machines, like any user;
 * here they can look at the app as another user (support) or at everything at once.
 */
export function ViewAsSwitch() {
  const { t } = useTranslation();
  const { user, viewAs, setViewAs } = useAuth();
  const [users, setUsers] = useState<User[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isAdmin = !!user?.role_info?.is_admin;

  useEffect(() => {
    if (!isAdmin || !open || users) return;
    api.users
      .list()
      .then((r) => setUsers(r.users))
      .catch(() => setUsers([]));
  }, [isAdmin, open, users]);

  if (!isAdmin) return null;

  const current = viewAs === null ? 'me' : viewAs === 'all' ? 'all' : viewAs.id;
  const label = viewAsLabel(viewAs);

  const choose = async (value: string) => {
    setBusy(true);
    try {
      await setViewAs(value === 'me' ? null : value === 'all' ? '*' : value);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`rounded-lg border px-3 py-2 ${viewAs ? 'border-warn/40 bg-warn/10' : 'border-line bg-bg-2'}`}>
      <button
        className={`flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs ${viewAs ? 'text-warn' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}
        onClick={() => setOpen((v) => !v)}
        title={t('Administrador: ver o app como outro usuário')}
      >
        <span className="flex-1 truncate">{label ?? t('Ver como…')}</span>
        <span className="text-[10px] text-fg-dim">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          <Combobox
            className="w-full py-1 text-xs"
            aria-label={t('Ver como…')}
            value={current}
            disabled={busy}
            onChange={(v) => void choose(v)}
            options={[
              { value: 'me', label: t('Eu ({{name}})', { name: user?.name ?? '' }) },
              { value: 'all', label: t('Todas as máquinas (todos os usuários)') },
              ...(users ?? []).filter((u) => u.id !== user?.id).map((u) => ({ value: u.id, label: u.name, hint: u.email })),
            ]}
          />
          {viewAs && (
            <button className="w-full rounded px-2 py-1 text-xs text-fg-muted hover:bg-bg-3 hover:text-fg" disabled={busy} onClick={() => void choose('me')}>
              {t('Voltar a ver como eu')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
