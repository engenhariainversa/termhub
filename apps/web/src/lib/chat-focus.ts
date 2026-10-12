import { useEffect } from 'react';
import { api } from './api';

/** How often a screen in focus says so. The server counts a person in focus while any screen's beat is
 *  under 45 s old, and tells this number in `focus_beat_seconds` (15 unless configured otherwise). */
export const FOCUS_BEAT_MS = 15_000;

/** This browser tab's own id for `POST /chat/focus`: random, kept for the page's life (never stored). */
let clientId: string | null = null;
export function focusClientId(): string {
  if (!clientId) {
    // `randomUUID` needs a secure context; a plain-http LAN address gets a random id of the same alphabet.
    clientId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return clientId;
}

export interface FocusReporter {
  /** The screen's focus as it reads now; sends only when it changed. */
  set: (focused: boolean) => void;
  /** Stops beating and, when the screen was in focus, says it no longer is. */
  stop: () => void;
}

/**
 * The reporting rule, apart from the DOM (TER-642): `send(true)` when the screen gains focus and again
 * every `beatMs` while it keeps it, `send(false)` once when it loses it. Out of focus it stays quiet —
 * a screen that was never in focus has nothing to take back.
 */
export function createFocusReporter(send: (focused: boolean) => void, beatMs: number = FOCUS_BEAT_MS): FocusReporter {
  let focused = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const set = (now: boolean) => {
    if (now === focused) return;
    focused = now;
    if (timer !== null) clearInterval(timer);
    timer = now ? setInterval(() => send(true), beatMs) : null;
    send(now);
  };
  return { set, stop: () => set(false) };
}

/** Termhub is in focus on this screen: the page is visible and its window has the keyboard. */
export const screenFocused = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

/**
 * Tells the server whether termhub is in focus here (TER-642): a suggested automatic answer only counts
 * down while the person is looking at termhub somewhere. Mounted once for a signed-in person who has
 * the chat. Best effort throughout: a report that fails is simply followed by the next one.
 */
export function useChatFocusReporter(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const reporter = createFocusReporter((focused) => {
      try {
        void api.reportChatFocus(focusClientId(), focused);
      } catch {
        // best effort
      }
    });
    const read = () => reporter.set(screenFocused());
    const leave = () => reporter.set(false);
    read();
    document.addEventListener('visibilitychange', read);
    window.addEventListener('focus', read);
    window.addEventListener('blur', read);
    // `pageshow`: a page restored from the back/forward cache is in focus again without any other event.
    window.addEventListener('pageshow', read);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', read);
      window.removeEventListener('focus', read);
      window.removeEventListener('blur', read);
      window.removeEventListener('pageshow', read);
      window.removeEventListener('pagehide', leave);
      reporter.stop();
    };
  }, [enabled]);
}
