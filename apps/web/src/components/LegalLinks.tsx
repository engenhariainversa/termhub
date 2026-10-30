import { useAuth } from '../lib/auth';
import { LegalFooter } from '../city/LegalFooter';

/** The legal footer of the login screen and Configurações → Perfil, from the instance's /auth/config. */
export function LegalLinks({ className = '' }: { className?: string }) {
  const { config } = useAuth();
  return <LegalFooter config={config} className={className} />;
}
