import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n';

export interface ToastInput {
  /** a toast with the same id replaces the one on screen */
  id: string;
  title: string;
  body?: string;
  /** clicking the toast navigates here */
  href?: string;
}

interface ToastState {
  toasts: ToastInput[];
  show: (t: ToastInput) => void;
  dismiss: (id: string) => void;
}

/** how long a toast stays on screen */
export const TOAST_MS = 8_000;
const MAX_TOASTS = 3;

const ToastContext = createContext<ToastState | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastInput[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((list) => (list.some((t) => t.id === id) ? list.filter((t) => t.id !== id) : list));
  }, []);

  const show = useCallback(
    (t: ToastInput) => {
      const old = timers.current.get(t.id);
      if (old) clearTimeout(old);
      timers.current.set(
        t.id,
        setTimeout(() => dismiss(t.id), TOAST_MS),
      );
      setToasts((list) => {
        const next = [t, ...list.filter((x) => x.id !== t.id)];
        for (const dropped of next.slice(MAX_TOASTS)) {
          clearTimeout(timers.current.get(dropped.id));
          timers.current.delete(dropped.id);
        }
        return next.slice(0, MAX_TOASTS);
      });
    },
    [dismiss],
  );

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((timer) => clearTimeout(timer));
  }, []);

  const value = useMemo(() => ({ toasts, show, dismiss }), [toasts, show, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): Pick<ToastState, 'show' | 'dismiss'> {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast fora do ToastProvider');
  return ctx;
}

/** Top-right stack of toasts, newest first. */
export function Toaster() {
  const ctx = useContext(ToastContext);
  const navigate = useNavigate();
  const { t } = useTranslation();
  if (!ctx || ctx.toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-3 top-3 z-50 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
      {ctx.toasts.map((toast) => (
        <div key={toast.id} role="status" className="pointer-events-auto flex items-start gap-2 rounded-md border border-attention/40 bg-bg-2 p-3 text-xs shadow-lg">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-attention" aria-hidden />
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={() => {
              ctx.dismiss(toast.id);
              if (toast.href) navigate(toast.href);
            }}
          >
            <p className="truncate font-medium text-fg">{toast.title}</p>
            {toast.body && <span className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-fg-muted">{toast.body}</span>}
          </button>
          <button type="button" className="shrink-0 rounded px-1 text-fg-dim hover:bg-bg-3 hover:text-fg" aria-label={t('Fechar aviso')} onClick={() => ctx.dismiss(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
