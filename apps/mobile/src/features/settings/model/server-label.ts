import { t } from '@/i18n';

// Ajustes → "Versão": which server this build talks to (design spec §7). Parsed by hand rather
// than with `URL`, whose React Native polyfill does not implement every getter.

/** `Servidor: mock`, or `Servidor: <host[:port]>` of `url` (`TERMHUB_URL`) in http mode. */
export function serverLabel(mode: 'mock' | 'http', url: string): string {
  if (mode === 'mock') return t('Servidor: {{host}}', { host: 'mock' });
  const host = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  return t('Servidor: {{host}}', { host: host || url });
}
