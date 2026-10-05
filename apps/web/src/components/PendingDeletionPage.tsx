import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { deletionDate } from '../lib/account-deletion';
import { useTranslation } from '../i18n';
import { useAuth } from '../lib/auth';

/**
 * What a signed-in person sees while their account waits to be deleted (TER-720), instead of the app:
 * the server refuses everything else anyway, so nothing below AppShell mounts (no lists, no sockets).
 * Cancelling brings the account back and the normal app with it.
 */
export function PendingDeletionPage({ scheduledAt }: { scheduledAt: string }) {
  const { t } = useTranslation();
  const { refresh, logout } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.account.cancelDeletion();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Não foi possível cancelar a exclusão.'));
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-md rounded-xl border border-line bg-bg-2 p-6 shadow-2xl">
        <h1 className="mb-2 text-lg font-semibold tracking-tight">{t('Sua conta será excluída em {{date}}', { date: deletionDate(scheduledAt) })}</h1>
        <p className="text-sm text-fg-muted">
          {t(
            'Você pediu para excluir sua conta, e ela está desativada até lá. Nessa data, suas máquinas, projetos, chats e o resto dos seus dados são apagados para sempre. Se mudou de ideia, cancele a exclusão para voltar a usar o termhub como antes.',
          )}
        </p>
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void logout().then(() => navigate('/login'))}>
            {t('Sair')}
          </button>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void cancel()}>
            {busy ? t('Cancelando…') : t('Cancelar exclusão')}
          </button>
        </div>
      </div>
    </div>
  );
}
