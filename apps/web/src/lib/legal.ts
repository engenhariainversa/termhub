/** Helpers for the acceptance of the Terms of Use and of the Privacy Policy (TER-742). */
import { tk } from '../i18n';
import { formatDate } from './format';
import type { LegalVersion } from './types';

/** The document's name, as a `tk()` key: show it with `t(LEGAL_DOCUMENT_NAME[doc.document])`. */
export const LEGAL_DOCUMENT_NAME: Record<LegalVersion['document'], string> = {
  terms: tk('Termos de Uso'),
  privacy: tk('Política de Privacidade'),
};

/** "7 de outubro de 2026": the day a version takes (or took) effect. */
export function legalDate(iso: string): string {
  return formatDate(iso, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** The public page of each document among `versions` (the first one listed wins). */
export function legalUrls(versions: LegalVersion[]): { termsUrl?: string; privacyUrl?: string } {
  return {
    termsUrl: versions.find((v) => v.document === 'terms')?.url,
    privacyUrl: versions.find((v) => v.document === 'privacy')?.url,
  };
}

const DISMISS_PREFIX = 'termhub:legal-notice-dismissed:';

/** The notice is closed per set of versions: a new version shows it again. */
function dismissKey(versions: LegalVersion[]): string {
  return DISMISS_PREFIX + versions.map((v) => v.id).sort().join(',');
}

export function isNoticeDismissed(versions: LegalVersion[]): boolean {
  try {
    return localStorage.getItem(dismissKey(versions)) === '1';
  } catch {
    return false;
  }
}

export function dismissNotice(versions: LegalVersion[]): void {
  try {
    localStorage.setItem(dismissKey(versions), '1');
  } catch {
    // storage blocked: the notice is closed for this page only
  }
}
