import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useTranslation } from '../i18n';
import { useAuth } from '../lib/auth';
import { LEGAL_DOCUMENT_NAME, legalDate, legalUrls } from '../lib/legal';
import type { LegalVersion } from '../lib/types';
import { LegalConsent } from './LegalConsent';

/**
 * What a signed-in person sees, instead of the app, while a version in force of the Terms of Use or
 * of the Privacy Policy waits for their acceptance (TER-742). For a new account this is the sign-up
 * step; for a current one, the re-acceptance after a relevant change. Nothing below AppShell mounts
 * until it is accepted. API tokens and the MCP are not gated (spec 2026-10-07, decision 4).
 */
export function LegalAcceptancePage({ pending }: { pending: LegalVersion[] }) {
  const { t } = useTranslation();
  const { setLegal, logout } = useAuth();
  const navigate = useNavigate();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      setLegal(
        await api.legal.accept(
          pending.map((v) => v.id),
          'web',
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Não foi possível registrar o aceite.'));
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-md rounded-xl border border-line bg-bg-2 p-6 shadow-2xl">
        <h1 className="mb-2 text-lg font-semibold tracking-tight">{t('Termos de Uso e Política de Privacidade')}</h1>
        <p className="text-sm text-fg-muted">{t('Para continuar usando o termhub, leia e aceite a versão em vigor dos documentos abaixo.')}</p>
        <ul className="mt-4 space-y-3">
          {pending.map((v) => (
            <li key={v.id} className="rounded-lg border border-line p-3 text-sm">
              <a href={v.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">
                {t(LEGAL_DOCUMENT_NAME[v.document])}
              </a>
              <p className="mt-0.5 text-xs text-fg-muted">{t('Versão {{version}}, em vigor desde {{date}}', { version: v.version, date: legalDate(v.effective_at) })}</p>
              {v.summary && <p className="mt-2 whitespace-pre-line text-fg-muted">{v.summary}</p>}
            </li>
          ))}
        </ul>
        <div className="mt-4">
          <LegalConsent {...legalUrls(pending)} checked={checked} onChange={setChecked} disabled={busy} />
        </div>
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void logout().then(() => navigate('/login'))}>
            {t('Sair')}
          </button>
          <button type="button" className="btn-primary" disabled={busy || !checked} onClick={() => void accept()}>
            {busy ? t('Salvando…') : t('Continuar')}
          </button>
        </div>
      </div>
    </div>
  );
}
