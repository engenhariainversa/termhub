/** Helpers for self-service account deletion (TER-720). */

/** "1 de novembro de 2026": the day the account is deleted for good. */
export function deletionDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
}

// The request ends the session, so the confirmation is read on the login page, after the app has
// already let go of the user (a background 401 may get there first). sessionStorage survives that hop.
const NOTICE_KEY = 'termhub:account-deletion-notice';

export function saveDeletionNotice(scheduledAt: string): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, scheduledAt);
  } catch {
    // storage blocked: the login page just shows no notice
  }
}

/** Reads and forgets the notice, so it shows once. */
export function takeDeletionNotice(): string | null {
  try {
    const v = sessionStorage.getItem(NOTICE_KEY);
    if (v) sessionStorage.removeItem(NOTICE_KEY);
    return v;
  } catch {
    return null;
  }
}
