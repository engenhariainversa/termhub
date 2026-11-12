import { tk, useTranslation } from '../i18n';
import type { AuthConfig } from '../lib/types';

export type LegalConfig = Pick<AuthConfig, 'terms_url' | 'privacy_url' | 'legal_entity'>;

/**
 * "Termos de uso · Política de privacidade", with the operator's name and CNPJ under them, as this
 * instance's server sets them (TERMS_URL / PRIVACY_URL / LEGAL_ENTITY). A self-hosted instance is
 * neither covered by termhub.dev's documents nor run by its operator, so with none set nothing renders.
 * It lives with the public city because the city's bundle may not import the private app
 * (bundle.test.ts); the app's LegalLinks wraps it with the session's config.
 */
export function LegalFooter({ config, className = '' }: { config: Partial<LegalConfig> | null | undefined; className?: string }) {
  const { t } = useTranslation();
  const all: { href: string | null | undefined; label: string }[] = [
    { href: config?.terms_url, label: tk('Termos de uso') },
    { href: config?.privacy_url, label: tk('Política de privacidade') },
  ];
  const links = all.filter((l): l is { href: string; label: string } => !!l.href);
  const entity = config?.legal_entity;
  if (links.length === 0 && !entity) return null;
  return (
    <div className={`flex flex-col gap-1 text-xs text-fg-dim ${className}`}>
      {links.length > 0 && (
        <nav aria-label={t('Documentos legais')} className="flex flex-wrap items-center gap-x-2">
          {links.map((l, i) => (
            <span key={l.href} className="flex items-center gap-x-2">
              {i > 0 && <span aria-hidden="true">·</span>}
              <a href={l.href} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-fg hover:underline">
                {t(l.label)}
              </a>
            </span>
          ))}
        </nav>
      )}
      {entity && <p>{entity}</p>}
    </div>
  );
}
