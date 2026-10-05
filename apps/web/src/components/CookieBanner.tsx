import { useTranslation } from '../i18n';
import { writeConsent } from '../lib/consent';

/**
 * Cookie notice for the app's Google Analytics.
 *
 * Deliberately not a modal: no overlay, the app stays usable while it is open.
 * Writing the choice fires the consent event `App` listens to, which is what
 * closes the banner and (on "Aceitar") starts analytics.
 */
export function CookieBanner({ open }: { open: boolean }) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-labelledby="cookie-title"
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-30 rounded-md border border-line bg-bg-2 p-4 text-sm shadow-lg md:left-auto md:right-6 md:max-w-md"
    >
      <h2 id="cookie-title" className="font-medium text-fg">
        {t('Cookies')}
      </h2>
      <p className="mt-1 text-xs text-fg-muted">
        {t(
          'Usamos o Google Analytics para entender como o termhub é usado: telas visitadas e ações como conectar uma máquina. Nada do que você digita nos terminais, nem seu e-mail, é enviado.',
        )}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={() => writeConsent('granted')}>
          {t('Aceitar')}
        </button>
        <button type="button" className="btn-ghost" onClick={() => writeConsent('denied')}>
          {t('Recusar')}
        </button>
      </div>
    </div>
  );
}
