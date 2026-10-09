import { useMemo, useSyncExternalStore } from 'react';
import { api } from './api';
import type { AiLoginStatusRow } from './types';

/**
 * Whether each AI account's CLI is still logged in on its machine (TER-1047), shared by every place that
 * warns about it (sidebar, Máquinas, Contas de IA): one subscription, one poll. The server keeps the state
 * (its background check runs every 10 min), so this only re-reads what it has — every 2 min while the app
 * is open and whenever the window regains focus.
 */
export const LOGIN_STATUS_POLL_MS = 2 * 60_000;

let state: AiLoginStatusRow[] | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function publish(next: AiLoginStatusRow[]) {
  state = next;
  listeners.forEach((l) => l());
}

/** Re-reads the login state; a failed read keeps the last good one. */
export async function refreshAiLoginStatus(): Promise<void> {
  try {
    publish((await api.aiAccounts.loginStatus()).accounts);
  } catch {
    /* keep what is on screen */
  }
}

const onFocus = () => {
  if (document.visibilityState !== 'hidden') void refreshAiLoginStatus();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshAiLoginStatus();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    timer = setInterval(() => void refreshAiLoginStatus(), LOGIN_STATUS_POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    // The last state stays: moving between pages must not blink the warning.
    if (listeners.size === 0) {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

/** Tests only: forget the shared state between cases. */
export function resetAiLoginStatusForTests(): void {
  state = null;
}

/** The accounts whose login expired, in the server's order. Pure. */
export function accountsNeedingLogin(rows: AiLoginStatusRow[] | null): AiLoginStatusRow[] {
  return (rows ?? []).filter((r) => r.state === 'login_required');
}

export function useAiLoginStatus(): { accounts: AiLoginStatusRow[] | null; needsLogin: AiLoginStatusRow[]; refresh: () => Promise<void> } {
  const accounts = useSyncExternalStore(subscribe, () => state);
  const needsLogin = useMemo(() => accountsNeedingLogin(accounts), [accounts]);
  return { accounts, needsLogin, refresh: refreshAiLoginStatus };
}
