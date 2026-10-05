import { t } from '@/i18n';

/** The running JS bundle for Ajustes → Versão (TER-913): "binário" when the app runs the bundle
 * embedded in the build, else the OTA update's short id, so a test run can note binary and OTA. */
export function updateLabel(updateId: string | null, isEmbeddedLaunch: boolean): string {
  if (isEmbeddedLaunch || !updateId) return t('OTA: binário');
  return `OTA: ${updateId.slice(0, 8)}`;
}
