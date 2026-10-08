import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatBytes } from '../lib/attachments';
import { formatDateTime } from '../lib/format';
import type { DataExportStatus } from '../lib/types';
import { useTranslation } from '../i18n';

/** How often the section looks again while the archive is being built. */
const POLL_MS = 10_000;

/**
 * Perfil → Exportar meus dados (TER-741, LGPD art. 18). Asks for a zip of everything the account holds;
 * the server builds it in the background and e-mails when it is ready. The download stays here for 7
 * days, for this account only; one request a day.
 */
export function DataExportSection() {
  const { t } = useTranslation();
  const [state, setState] = useState<DataExportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.account.dataExport());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Não foi possível carregar a exportação.'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = state?.export ?? null;
  const building = current?.status === 'pending' || current?.status === 'running';
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [building, load]);

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.account.requestDataExport());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Não foi possível pedir a exportação.'));
      void load();
    } finally {
      setBusy(false);
    }
  };

  const nextAllowed = state?.next_allowed_at && new Date(state.next_allowed_at).getTime() > Date.now() ? state.next_allowed_at : null;

  return (
    <section aria-label={t('Exportar meus dados')} className="rounded-lg border border-line p-4">
      <h3 className="text-sm font-semibold">{t('Exportar meus dados')}</h3>
      <p className="mt-1 text-xs text-fg-muted">
        {t(
          'Gera um arquivo .zip com sua conta, projetos, cards, notas, tickets, chats, memória, abas, máquinas, integrações (sem tokens), contas de IA, aparelhos e notificações. Você recebe um e-mail quando ele fica pronto, e o download fica aqui por 7 dias.',
        )}
      </p>
      {building && <p className="mt-2 text-xs">{t('Preparando o arquivo… Você recebe um e-mail quando ele ficar pronto.')}</p>}
      {current?.status === 'ready' && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <a className="btn-primary" href={api.account.dataExportUrl(current.id)} download>
            <Download size={16} aria-hidden="true" />
            {current.bytes !== null ? t('Baixar ({{size}})', { size: formatBytes(current.bytes) }) : t('Baixar')}
          </a>
          {current.expires_at && <span className="text-xs text-fg-muted">{t('Disponível até {{date}}.', { date: formatDateTime(current.expires_at, { dateStyle: 'short', timeStyle: 'short' }) })}</span>}
        </div>
      )}
      {current?.status === 'failed' && <p className="mt-2 text-xs text-danger">{t('Não foi possível gerar o arquivo. Peça de novo.')}</p>}
      {current?.status === 'expired' && <p className="mt-2 text-xs text-fg-muted">{t('O arquivo da última exportação expirou.')}</p>}
      {!building && (
        <button type="button" className="btn-ghost mt-3" disabled={busy || !state || !!nextAllowed} onClick={() => void ask()}>
          {t('Exportar meus dados')}
        </button>
      )}
      {!building && nextAllowed && (
        <p className="mt-1 text-xs text-fg-muted">{t('Você pode pedir outra exportação a partir de {{date}}.', { date: formatDateTime(nextAllowed, { dateStyle: 'short', timeStyle: 'short' }) })}</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
