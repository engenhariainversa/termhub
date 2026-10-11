import { i18n } from '../i18n';
import type { ViewAs } from './types';

/** What an admin's "Ver como" scope reads as in the chrome and in Perfil; null when viewing their own data. */
export function viewAsLabel(viewAs: ViewAs | undefined): string | null {
  if (!viewAs) return null;
  return viewAs === 'all' ? i18n.t('Vendo: todas as máquinas') : i18n.t('Vendo como {{name}}', { name: viewAs.name });
}
