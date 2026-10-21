import { i18n } from '../i18n';
import type { ChatEvent } from './types';

/**
 * TER-1101: the concierge's notices as browser notifications. The server already applied the person's rules
 * (levels, quiet hours, grouping, the cap) before it sent `concierge_notice`; the browser only needs the
 * permission. Every open termhub tab gets the event: the notification's `tag` is the conversation's, so the
 * browser keeps one of them.
 */
export type ConciergeNoticeEvent = Extract<ChatEvent, { type: 'concierge_notice' }>;
export type BrowserNotifyState = 'unsupported' | 'default' | 'granted' | 'denied';

export function browserNotifyState(): BrowserNotifyState {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported';
  return window.Notification.permission;
}

/** Asks the browser once (it must come from a click); answers the state after it. */
export async function askBrowserNotify(): Promise<BrowserNotifyState> {
  if (browserNotifyState() === 'unsupported') return 'unsupported';
  try {
    return await window.Notification.requestPermission();
  } catch {
    return browserNotifyState();
  }
}

/** The notification's words, in the page's language: the level, then the concierge's own headline. */
export function conciergeNoticeText(e: Pick<ConciergeNoticeEvent, 'level' | 'headline' | 'count'>): { title: string; body: string } {
  const title = e.level === 'needs_you' ? i18n.t('O concierge precisa de você') : i18n.t('Novidade do concierge');
  return { title, body: e.count > 1 ? i18n.t('{{headline}} (+{{count}} avisos)', { headline: e.headline, count: e.count - 1 }) : e.headline };
}

/**
 * Shows the notice unless the person is looking at that very chat right now (the page visible and focused,
 * with that conversation's chat on screen). A click focuses the tab and opens the chat at the message.
 * Answers whether a notification was shown.
 */
export function showConciergeNotice(e: ConciergeNoticeEvent, opts: { chatOnScreen: boolean; onOpen: () => void }): boolean {
  if (browserNotifyState() !== 'granted') return false;
  const looking = document.visibilityState === 'visible' && document.hasFocus() && opts.chatOnScreen;
  if (looking) return false;
  const { title, body } = conciergeNoticeText(e);
  try {
    const n = new window.Notification(title, { body, tag: `concierge:${e.conversation_id}` });
    n.onclick = () => {
      window.focus();
      opts.onOpen();
      n.close();
    };
    return true;
  } catch {
    // Some browsers only show notifications from a service worker: the chat still has the message.
    return false;
  }
}

/** The status feed (one /ws/chat per page, `project-chat.tsx`) hands the notices to whoever shows them. */
const noticeListeners = new Set<(e: ConciergeNoticeEvent) => void>();

export function publishConciergeNotice(e: ConciergeNoticeEvent): void {
  for (const l of noticeListeners) l(e);
}

export function subscribeConciergeNotices(listener: (e: ConciergeNoticeEvent) => void): () => void {
  noticeListeners.add(listener);
  return () => void noticeListeners.delete(listener);
}
