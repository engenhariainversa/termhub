import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject, ReactNode, UIEvent } from 'react';
import { isNearBottom } from '../../lib/chat-scroll';

export interface ChatThreadProps {
  children: ReactNode;
  /** The empty state (one line saying what this screen is for), rendered above the list. */
  empty?: ReactNode;
  /** The socket is down and being retried: an overlay badge, never a line that shifts the thread. */
  reconnecting: boolean;
  /** Changes whenever new content arrives (a row, a card, a streamed delta): what the pin follows. */
  followKey: unknown;
  /**
   * Whether the thread follows new content. Owned here unless the panel hands its own in — `send` is
   * the reader's own way of saying "take me to the bottom", and the panel sets it before the row lands.
   */
  stickRef?: MutableRefObject<boolean>;
}

/** How long a smooth scroll may keep firing scroll events before `onScroll` reads them as the person's. */
const SMOOTH_SETTLE_MS = 600;

const nextFrame: (cb: () => void) => void = typeof requestAnimationFrame === 'function' ? (cb) => void requestAnimationFrame(cb) : (cb) => void setTimeout(cb, 16);

/**
 * The conversation's list, its scroll and the "novas mensagens" pill. The `<ol>` keeps the `Conversa`
 * name (a rendered answer can contain lists of its own; this is how the thread is told apart from
 * them, by screen readers and by the tests) and sits inside the element that scrolls, so an observer
 * on the list sees the content grow while the scroll container keeps its height.
 *
 * The pin runs in a layout effect — before paint, so a new row never shows at the old scroll position
 * for a frame — and again whenever the list or the scroll container changes size: a card that appears,
 * a streamed line, an image thumbnail that loads, the grant strip growing, the keyboard opening.
 *
 * `stick` starts `true` (a page just opened is at its own bottom) and is written only from `onScroll`
 * and from the pill — never recomputed from the list's live geometry inside the effect: jsdom lays
 * nothing out, and in a real browser a thread shorter than the viewport would read as "far from the
 * bottom". Programmatic scrolls raise a flag so `onScroll` does not read them as the person's.
 */
export function ChatThread({ children, empty, reconnecting, followKey, stickRef }: ChatThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const ownStick = useRef(true);
  const stick = stickRef ?? ownStick;
  const programmatic = useRef(false);
  /** Something arrived while the reader was scrolled up: show the pill. */
  const [unread, setUnread] = useState(false);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    programmatic.current = true;
    if (smooth && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      // `onScroll` clears the flag when the scroll lands; this is the guard for a scroll that never fires.
      window.setTimeout(() => {
        programmatic.current = false;
      }, SMOOTH_SETTLE_MS);
    } else {
      el.scrollTop = el.scrollHeight;
      // The scroll event of this assignment is dispatched before the next frame's callbacks run.
      nextFrame(() => {
        programmatic.current = false;
      });
    }
  }, []);

  useLayoutEffect(() => {
    if (stick.current) {
      scrollToBottom(false);
      setUnread(false);
    } else setUnread(true);
  }, [followKey, stick, scrollToBottom]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stick.current) scrollToBottom(false);
    });
    observer.observe(list);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [stick, scrollToBottom]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const near = isNearBottom(e.currentTarget);
    if (programmatic.current) {
      if (near) programmatic.current = false;
      return;
    }
    stick.current = near;
    if (near) setUnread(false);
  };

  const jump = () => {
    stick.current = true;
    setUnread(false);
    scrollToBottom(true);
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {reconnecting && (
        <p role="status" className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-line bg-bg-2 px-3 py-1 text-xs text-warn shadow">
          Reconectando…
        </p>
      )}
      {empty}
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain" onScroll={onScroll}>
        <ol ref={listRef} aria-label="Conversa" className="min-w-0 space-y-5 py-4">
          {children}
        </ol>
      </div>
      {unread && (
        <button type="button" className="chat-enter absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-bg-2 px-3 py-1 text-xs text-fg shadow hover:bg-bg-3" onClick={jump}>
          ↓ novas mensagens
        </button>
      )}
    </div>
  );
}
