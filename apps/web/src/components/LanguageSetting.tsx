import { useState } from 'react';
import { readStoredLocale, useTranslation, type Locale } from '../i18n';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

type Choice = Locale | 'auto';

/**
 * Configurações → Perfil → Idioma (spec 2026-10-04 i18n §2). Automático follows the browser's
 * languages; the others are written in their own language, so someone who cannot read the screen
 * still finds theirs. The choice goes to the account (e-mails and push follow it) and to this browser.
 */
export function LanguageSetting() {
  const { t } = useTranslation();
  const { user, setLocale } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = user?.locale !== undefined ? user.locale : readStoredLocale();
  const [choice, setChoice] = useState<Choice>(saved ?? 'auto');

  const change = async (next: Choice) => {
    const previous = choice;
    setChoice(next);
    setError(null);
    setBusy(true);
    try {
      await setLocale(next === 'auto' ? null : next);
    } catch (err) {
      setChoice(previous);
      setError(err instanceof ApiError ? err.message : t('Não foi possível salvar o idioma.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-line bg-bg-2 p-4">
      <label htmlFor="language-select" className="text-sm font-semibold">
        {t('Idioma')}
      </label>
      <p className="mt-1 text-xs text-fg-muted">{t('Vale para o app, os e-mails e as notificações. Automático segue o idioma do navegador.')}</p>
      <select id="language-select" className="input mt-3 w-auto py-1 text-sm" value={choice} disabled={busy} onChange={(e) => void change(e.target.value as Choice)}>
        <option value="auto">{t('Automático')}</option>
        {/* each language in its own words, whatever language the screen is in */}
        <option value="pt-BR" lang="pt-BR">
          Português (Brasil) {/* i18n-ignore */}
        </option>
        <option value="en" lang="en">
          English {/* i18n-ignore */}
        </option>
        <option value="es" lang="es">
          Español {/* i18n-ignore */}
        </option>
      </select>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
