import { useAuth } from '../lib/auth';

/**
 * "Termos de uso · Política de privacidade" for the login screen and Configurações → Perfil. The
 * addresses come from the server (TERMS_URL / PRIVACY_URL): a self-hosted instance is not covered by
 * termhub.dev's documents, so with neither set nothing renders.
 */
export function LegalLinks({ className = '' }: { className?: string }) {
  const { config } = useAuth();
  const links = [
    { href: config?.terms_url, label: 'Termos de uso' },
    { href: config?.privacy_url, label: 'Política de privacidade' },
  ].filter((l): l is { href: string; label: string } => !!l.href);
  if (links.length === 0) return null;
  return (
    <nav aria-label="Documentos legais" className={`flex flex-wrap items-center gap-x-2 text-xs text-fg-dim ${className}`}>
      {links.map((l, i) => (
        <span key={l.href} className="flex items-center gap-x-2">
          {i > 0 && <span aria-hidden="true">·</span>}
          <a href={l.href} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-fg hover:underline">
            {l.label}
          </a>
        </span>
      ))}
    </nav>
  );
}
