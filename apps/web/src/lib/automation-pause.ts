import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { useMonitor } from './monitor';
import type { AutomationPauseState } from './types';

/** How often the pause state is re-read while a screen shows it: the global pause is not pushed on the socket. */
export const PAUSE_POLL_MS = 4_000;

let state: AutomationPauseState | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function publish(next: AutomationPauseState | null) {
  state = next;
  listeners.forEach((l) => l());
}

/** Reads the state; a failed read keeps the last good one (the next tick retries). */
export async function refreshPauseState(): Promise<void> {
  try {
    publish(await api.automation.pauseState());
  } catch {
    /* keep what is on screen */
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshPauseState();
    timer = setInterval(() => void refreshPauseState(), PAUSE_POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      state = null;
    }
  };
}

/** When the work of `projectId` stopped: the person's "Pausar tudo", else the project's own pause; null = running. */
export function pausedSince(s: AutomationPauseState | null, projectId?: string): string | null {
  if (!s) return null;
  if (s.paused_at) return s.paused_at;
  if (projectId) return s.projects.find((p) => p.id === projectId)?.paused_at ?? null;
  return null;
}

/** "10:42" in the browser's clock, for "Automático pausado desde 10:42." */
export function pauseClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * The automatic work's pause switch, shared by every component showing it: one poll while any is mounted,
 * re-read on a push of an `automation` frame, when the tab regains focus and after an action of this one.
 */
export function useAutomationPause() {
  const current = useSyncExternalStore(subscribe, () => state);
  const { automationSeq } = useMonitor();
  useEffect(() => {
    if (automationSeq) void refreshPauseState();
  }, [automationSeq]);
  useEffect(() => {
    const onFocus = () => void refreshPauseState();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);
  const pause = useCallback(async (scope: string, interrupt = false) => {
    await api.automation.pause(scope, interrupt);
    await refreshPauseState();
  }, []);
  const resume = useCallback(async (scope: string) => {
    await api.automation.resume(scope);
    await refreshPauseState();
  }, []);
  return { state: current, pause, resume };
}
