import { useState } from 'react';
import { useTranslation } from '../i18n';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dismissNotice, isNoticeDismissed, legalDate } from '../lib/legal';
import type { LegalVersion } from '../lib/types';

/**
 * Global banner (TER-742, spec 2026-10-07 decision 6): a relevant version of the Terms of Use or of the
 * Privacy Policy takes effect soon. The person can read what changes, accept it early ("Li e aceito",
 * so the gate never stops them on the day) or close the notice, which this browser remembers for that
 * set of versions. A failed accept just leaves the banner up: on the day, the gate asks again.
 */
export function LegalNoticeBanner() {
  const { t } = useTranslation();
  const { legal, setLegal } = useAuth();
  const upcoming = legal.upcoming;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = upcoming.map((v) => v.id).join(',');

  if (upcoming.length === 0 || dismissedKey === key || isNoticeDismissed(upcoming)) return null;

  const close = () => {
    dismissNotice(upcoming);
    setDismissedKey(key);
  };

  const accept = async () => {
    setBusy(true);
    try {
      setLegal(
        await api.legal.accept(
          upcoming.map((v) => v.id),
          'web',
        ),
      );
    } catch {
      // stays up; the gate asks again when the version takes effect
    } finally {
      setBusy(false);
    }
  };

  const sentence = (v: LegalVersion) =>
    v.document === 'terms' ? t('Os Termos de Uso mudam em {{date}}.', { date: legalDate(v.effective_at) }) : t('A Política de Privacidade muda em {{date}}.', { date: legalDate(v.effective_at) });

  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-attention/40 bg-attention/10 px-4 py-2 text-sm">
      {upcoming.map((v) => (
        <span key={v.id}>
          {sentence(v)}{' '}
          <a href={v.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">
            {t('Ver o que muda')}
          </a>
        </span>
      ))}
      <span className="ml-auto flex items-center gap-2">
        <button type="button" className="btn-ghost text-xs" disabled={busy} onClick={() => void accept()}>
          {t('Li e aceito')}
        </button>
        <button type="button" className="text-fg-dim hover:text-fg" aria-label={t('Fechar aviso')} title={t('Fechar aviso')} onClick={close}>
          ×
        </button>
      </span>
    </div>
  );
}
