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
 * bottom". The instant pin raises no guard against its own scroll event: that event reads "near the
 * bottom", which leaves `stick` as it was, while one reading "far" can only be the person — and while
 * an answer streams the pin runs every frame, so any guard that lasted a frame would swallow every
 * attempt to scroll up. Only the pill's smooth scroll is told apart from the person, by position.
 */
export function ChatThread({ children, empty, reconnecting, followKey, stickRef }: ChatThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const ownStick = useRef(true);
  const stick = stickRef ?? ownStick;
  /** The bottom the pill's smooth scroll is heading for while it is under way; `null` otherwise. */
  const smoothTarget = useRef<number | null>(null);
  /** Where the last scroll event (or the pill click) left the thread: a smooth scroll's own events move down from here. */
  const lastTop = useRef(0);
  /** The content's size at the last look: what says whether something arrived at the bottom. */
  const measured = useRef({ height: 0, rows: 0 });
  /** Something arrived while the reader was scrolled up: show the pill. */
  const [unread, setUnread] = useState(false);

  /** Reads the content's size and says whether it grew since the last read (a row, a streamed line). */
  const grew = useCallback(() => {
    const el = scrollRef.current;
    const list = listRef.current;
    if (!el || !list) return false;
    const next = { height: el.scrollHeight, rows: list.childElementCount };
    const prev = measured.current;
    measured.current = next;
    return next.height > prev.height || next.rows > prev.rows;
  }, []);

  const pin = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    // Read first, so a change that adds nothing at the bottom (a card whose status flipped) never
    // raises the pill.
    const more = grew();
    if (stick.current) {
      pin();
      setUnread(false);
    } else if (more) setUnread(true);
  }, [followKey, stick, grew, pin]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // A row that grew in place (a thumbnail that loaded) is not news: the size is noted so the next
      // `followKey` compares against it, and only a stuck thread moves.
      grew();
      if (stick.current) pin();
    });
    observer.observe(list);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [stick, grew, pin]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const top = el.scrollTop;
    const near = isNearBottom(el);
    const target = smoothTarget.current;
    if (target !== null) {
      // The pill's smooth scroll is under way. Its own events move down toward the target: not the
      // person's, and not a reason to re-read `stick`. One that landed ends it; one that moved up is
      // the person grabbing the thread, and ends it too.
      if (near || top >= target) smoothTarget.current = null;
      else if (top >= lastTop.current) {
        lastTop.current = top;
        return;
      } else smoothTarget.current = null;
    }
    lastTop.current = top;
    stick.current = near;
    if (near) setUnread(false);
  };

  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    setUnread(false);
    if (typeof el.scrollTo === 'function') {
      smoothTarget.current = el.scrollHeight;
      lastTop.current = el.scrollTop;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else pin();
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
