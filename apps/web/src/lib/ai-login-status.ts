import { useMemo, useSyncExternalStore } from 'react';
import { api } from './api';
import type { AiLoginStatusRow } from './types';

/**
 * Whether each AI account's CLI is still logged in on its machine (TER-1047), and whether that login is
 * about to expire (TER-1079), shared by every place that warns about it (sidebar, Máquinas, Contas de IA):
 * one subscription, one poll. The server keeps the state (its background check runs every 10 min), so this
 * only re-reads what it has — every 2 min while the app is open and whenever the window regains focus.
 */
export const LOGIN_STATUS_POLL_MS = 2 * 60_000;
/** The server's default window, shown until the first read (and with a server that does not send one). */
export const LOGIN_WARN_DEFAULT_DAYS = 3;

interface LoginStatus {
  accounts: AiLoginStatusRow[];
  warnDays: number;
}

let state: LoginStatus | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function publish(next: LoginStatus) {
  state = next;
  listeners.forEach((l) => l());
}

/** Re-reads the login state; a failed read keeps the last good one. */
export async function refreshAiLoginStatus(): Promise<void> {
  try {
    const r = await api.aiAccounts.loginStatus();
    publish({ accounts: r.accounts, warnDays: r.warn_days ?? LOGIN_WARN_DEFAULT_DAYS });
  } catch {
    /* keep what is on screen */
  }
}

/** Saves the person's warning window and re-reads the state it changes ("expires soon" follows it). Throws on failure. */
export async function saveAiLoginWarnDays(days: number): Promise<void> {
  await api.aiAccounts.setLoginWarning(days);
  await refreshAiLoginStatus();
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

/** The accounts still logged in whose login ends within the person's window (TER-1079). Pure. */
export function accountsExpiringSoon(rows: AiLoginStatusRow[] | null): AiLoginStatusRow[] {
  return (rows ?? []).filter((r) => r.expires_soon === true && r.state !== 'login_required');
}

export function useAiLoginStatus(): { accounts: AiLoginStatusRow[] | null; needsLogin: AiLoginStatusRow[]; expiringSoon: AiLoginStatusRow[]; warnDays: number; refresh: () => Promise<void> } {
  const status = useSyncExternalStore(subscribe, () => state);
  const accounts = status?.accounts ?? null;
  const needsLogin = useMemo(() => accountsNeedingLogin(accounts), [accounts]);
  const expiringSoon = useMemo(() => accountsExpiringSoon(accounts), [accounts]);
  return { accounts, needsLogin, expiringSoon, warnDays: status?.warnDays ?? LOGIN_WARN_DEFAULT_DAYS, refresh: refreshAiLoginStatus };
}
