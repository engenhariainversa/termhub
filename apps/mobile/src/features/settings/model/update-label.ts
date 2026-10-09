import { t } from '@/i18n';
import { formatDateTime } from '@/i18n/format';

export type RunningUpdate = { updateId: string | null; isEmbeddedLaunch: boolean; createdAt: Date | null };

/** The running JS bundle for Ajustes → Versão (TER-913): "binário" when the app runs the bundle
 * embedded in the build, else the OTA update's full id and publish time, so a person can tell
 * which update the phone runs and match it against the xprem server. */
export function updateLabel({ updateId, isEmbeddedLaunch, createdAt }: RunningUpdate): string {
  if (isEmbeddedLaunch || !updateId) return t('OTA: binário');
  return createdAt ? `OTA: ${updateId} · ${formatDateTime(createdAt)}` : `OTA: ${updateId}`;
}
