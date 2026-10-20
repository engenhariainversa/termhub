import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../i18n';
import { firstLink, messageCopyText } from '../../lib/chat-plain-text';
import { copyText } from '../../lib/clipboard';
import { useOptionalToast } from '../../lib/toast';
import type { ChatMessage } from '../../lib/types';

/** Where the menu opens: the pointer of a right click, or under the "⋯" button. Viewport coordinates. */
export type MenuPoint = { x: number; y: number };

/** The space the menu keeps from the viewport's edges. */
const EDGE = 8;

/**
 * "⋯" on a row of the thread (TER-1090): opens the row's menu, the same one a right click opens. Shown on
 * hover and on keyboard focus of its `group`, and always on a device with no hover, like "Responder".
 */
export function ChatMoreButton({ onOpen }: { onOpen: (at: MenuPoint) => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t('Mais ações da mensagem')}
      aria-haspopup="menu"
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onOpen({ x: rect.left, y: rect.bottom + 4 });
      }}
      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-dim opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
    >
      ⋯
    </button>
  );
}

/** Whether a right click on the row is the browser's: there is text selected to copy with its own menu. */
export function keepsNativeMenu(): boolean {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

type Item = { key: string; label: string; run: () => void };

/**
 * A row's menu (TER-1090): "Copiar" (the row as it reads, Markdown turned into plain text, links with
 * their address), "Responder", and for a row with a web address "Copiar link" and "Abrir link". Fixed
 * over the page at `at`, moved in to fit the viewport; it closes on a choice, a click outside, Escape,
 * a scroll or a resize. Arrow keys move between the items.
 */
export function ChatMessageMenu({ message, onReply, at, onClose }: { message: ChatMessage; onReply?: () => void; at: MenuPoint; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState(at);

  const items = useMemo<Item[]>(() => {
    const text = messageCopyText(message);
    const link = text ? firstLink(text) : null;
    const copy = (value: string) =>
      void copyText(value).then((ok) => toast?.show({ id: 'chat-copy', title: ok ? t('Copiado') : t('Não foi possível copiar') }));
    const list: Item[] = [];
    if (text) list.push({ key: 'copy', label: t('Copiar'), run: () => copy(text) });
    if (onReply) list.push({ key: 'reply', label: t('Responder'), run: onReply });
    if (link) {
      list.push({ key: 'copy-link', label: t('Copiar link'), run: () => copy(link) });
      list.push({ key: 'open-link', label: t('Abrir link'), run: () => void window.open(link, '_blank', 'noopener,noreferrer') });
    }
    return list;
  }, [message, onReply, t, toast]);

  // Moved in from the right and bottom edges once its size is known; the first item takes the focus.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPlace({
      x: Math.max(EDGE, Math.min(at.x, window.innerWidth - rect.width - EDGE)),
      y: Math.max(EDGE, at.y + rect.height > window.innerHeight - EDGE ? at.y - rect.height : at.y),
    });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [at]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
  };

  if (items.length === 0) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={t('Ações da mensagem')}
      onKeyDown={onKeyDown}
      // A right click on the menu itself must not reach the row and open it again at the pointer.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{ position: 'fixed', left: place.x, top: place.y }}
      className="z-50 min-w-[160px] rounded-md border border-line bg-bg-2 py-1 text-xs shadow-xl"
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className="block w-full px-3 py-1.5 text-left hover:bg-bg-3 focus:bg-bg-3 focus:outline-none"
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
