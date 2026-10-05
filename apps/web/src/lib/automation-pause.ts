import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { useMonitor } from './monitor';
import type { AutomationPauseState } from './types';

/**
 * Slow safety net while the switch is visible: the pushed `automation` frame (and focus) is what keeps it
 * current. A global pause records its event on every project with automatic work, so the frame arrives
 * whenever the pause matters.
 */
export const PAUSE_FALLBACK_MS = 60_000;

let state: AutomationPauseState | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let lastFrame = 0;

function publish(next: AutomationPauseState | null) {
  state = next;
  listeners.forEach((l) => l());
}

/** The switch has something to show: automatic work is on somewhere, or a pause is still active. */
export function pauseControlsVisible(s: AutomationPauseState | null): boolean {
  return !!s && (s.has_automation || s.paused_at !== null || s.projects.length > 0);
}

/** Reads the state; a failed read keeps the last good one. */
export async function refreshPauseState(): Promise<void> {
  try {
    publish(await api.automation.pauseState());
  } catch {
    /* keep what is on screen */
  }
}

const onFocus = () => void refreshPauseState();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshPauseState();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    timer = setInterval(() => {
      if (pauseControlsVisible(state)) void refreshPauseState();
    }, PAUSE_FALLBACK_MS);
  }
  return () => {
    listeners.delete(listener);
    // The last state stays: moving between pages must not blink the button.
    if (listeners.size === 0) {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      if (timer) clearInterval(timer);
      timer = null;
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

/** The automatic work's pause switch, shared by every component showing it (one subscription, one refresh per frame). */
export function useAutomationPause() {
  const current = useSyncExternalStore(subscribe, () => state);
  const { automationSeq } = useMonitor();
  useEffect(() => {
    // Every consumer sees the same frame number: only the first one to run re-reads.
    if (automationSeq && automationSeq !== lastFrame) {
      lastFrame = automationSeq;
      void refreshPauseState();
    }
  }, [automationSeq]);
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
