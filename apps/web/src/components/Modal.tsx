import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from '../i18n';

// Open layers (modals, an image opened from the chat), innermost last: only the top one answers Escape,
// so closing a nested dialog never closes the one under it too.
const openStack: symbol[] = [];

/**
 * Joins the stack of open layers for as long as `open` is true: only the top one answers Escape, so a
 * dialog opened over the chat's image viewer closes before the viewer does. Keyed on `open` only, so a
 * re-render with a new callback keeps the stack order. A `base` layer (a page's own Esc, like leaving
 * settings) goes under every other layer, whenever each opened: a dialog or the chat's image viewer
 * always answers first, even one opened before the page's layer joined.
 */
export function useEscapeLayer(open: boolean, onEscape: (e: KeyboardEvent) => void, enabled = true, options: { base?: boolean } = {}): void {
  const latest = useRef({ onEscape, enabled });
  latest.current = { onEscape, enabled };
  const base = !!options.base;
  useEffect(() => {
    if (!open) return;
    const id = Symbol('layer');
    if (base) openStack.unshift(id);
    else openStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openStack[openStack.length - 1] !== id) return;
      if (latest.current.enabled) latest.current.onEscape(e);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      openStack.splice(openStack.indexOf(id), 1);
    };
  }, [open, base]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hidden && !el.closest('[inert]'));

/**
 * Focus for a modal layer (TER-199): on open, focus goes in — unless something inside already took it
 * (an `autoFocus` field; React applies it during commit, before this effect) — to `initialFocusRef` or
 * else the container itself (give it `tabIndex={-1}`). Tab and Shift+Tab wrap inside through the returned
 * `onKeyDown`, which only sees keys pressed inside this dialog, so stacked layers do not fight (and a
 * nested dialog's own wrap, once handled, stops the outer one from also acting on the same key). On
 * close, focus goes back to what had it before — but only once focus has actually fallen to the page
 * (`null`/`<body>`): StrictMode's simulated cleanup, and a Modal that closes the same update another
 * dialog opens in, both run this same cleanup while focus is still meaningfully elsewhere, and must not
 * steal it back.
 */
export function useDialogFocus(open: boolean, containerRef: RefObject<HTMLElement | null>, initialFocusRef?: RefObject<HTMLElement | null>) {
  // The opener is read during the render that opens the dialog: by the time any effect runs, an
  // `autoFocus` child has already taken focus, and the opener would be lost.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) (initialFocusRef?.current ?? container).focus();
    return () => {
      const back = opener.current;
      const active = document.activeElement;
      // Only when focus has nowhere else to be. In StrictMode's simulated cleanup the container is
      // still mounted and focus is still inside it (not null/body), so this does nothing and the
      // effect that runs right after is left alone. On a real close the container is already gone
      // and the browser has already moved focus to body, so the opener gets it back.
      if (back && back.isConnected && (active === null || active === document.body)) back.focus();
    };
  }, [open, containerRef, initialFocusRef]);

  return (e: ReactKeyboardEvent) => {
    if (e.defaultPrevented) return;
    const container = containerRef.current;
    if (e.key !== 'Tab' || !container) return;
    const items = focusables(container);
    if (items.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === container)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

interface Props {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  /** false disables Escape and backdrop-click dismissal; the header × still closes it. Default true. */
  dismissible?: boolean;
}

export function Modal({ title, open, onClose, children, width = 'max-w-md', dismissible = true }: Props) {
  useEscapeLayer(open, onClose, dismissible);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useDialogFocus(open, dialogRef);
  const { t } = useTranslation();

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={dismissible ? onClose : undefined}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`flex max-h-[calc(100vh-2rem)] w-full ${width} flex-col rounded-lg border border-line bg-bg-2 shadow-2xl outline-none`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button className="text-fg-dim hover:text-fg" onClick={onClose} aria-label={t('Fechar')}>
            ✕
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel, danger, onConfirm, onCancel }: ConfirmProps) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') void onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onConfirm]);

  return (
    <Modal title={title} open={open} onClose={onCancel} width="max-w-sm">
      <div className="text-sm text-fg-muted">{message}</div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onCancel}>
          {t('Cancelar')}
        </button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={() => void onConfirm()} autoFocus>
          {confirmLabel ?? t('Confirmar')}
        </button>
      </div>
    </Modal>
  );
}
