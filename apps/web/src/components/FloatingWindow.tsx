import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Rect } from '../lib/layout';
import { useTranslation } from '../i18n';

export const FLOATING_TITLE_HEIGHT = 24;
const RESIZE_HANDLE_SIZE = 16;

interface Props {
  rect: Rect;
  title: string;
  onMove: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
  onDock: () => void;
  onFocus: () => void;
  children: ReactNode;
}

/**
 * Draggable/resizable frame positioned by `rect` inside the terminals area. Pointer capture keeps
 * the gesture alive when the cursor leaves the handle; the parent clamps the values it receives.
 *
 * Returns the frame and the resize handle as siblings (a fragment): the frame is `absolute z-20`,
 * which creates its own stacking context, so a handle nested inside it can never out-rank a sibling
 * element with a higher z-index elsewhere in the terminals area (e.g. the floating tab's body
 * wrapper). Keeping the handle outside the frame, at the same stacking level, lets its `z-30` win.
 */
export function FloatingWindow({ rect, title, onMove, onResize, onDock, onFocus, children }: Props) {
  const { t } = useTranslation();
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const resize = useRef<{ x0: number; y0: number; w0: number; h0: number } | null>(null);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus();
    drag.current = { dx: e.clientX - rect.x, dy: e.clientY - rect.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onMove(e.clientX - drag.current.dx, e.clientY - drag.current.dy);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus();
    resize.current = { x0: e.clientX, y0: e.clientY, w0: rect.w, h0: rect.h };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resize.current) return;
    onResize(resize.current.w0 + (e.clientX - resize.current.x0), resize.current.h0 + (e.clientY - resize.current.y0));
  };
  const endResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resize.current) return;
    resize.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <>
      <div
        className="absolute z-20 flex flex-col overflow-hidden rounded-md border border-accent/50 bg-bg shadow-2xl"
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        onPointerDown={onFocus}
      >
        <div
          className="flex shrink-0 cursor-move select-none items-center gap-2 border-b border-line bg-bg-2 px-2 text-[11px] text-fg-muted"
          style={{ height: FLOATING_TITLE_HEIGHT }}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span className="text-[10px]" aria-hidden>
            📱
          </span>
          <span className="truncate text-fg">{title}</span>
          <button className="ml-auto rounded px-1 hover:bg-bg-4 hover:text-fg" onPointerDown={(e) => e.stopPropagation()} onClick={onDock} title={t('Encaixar no painel focado')}>
            {t('Encaixar')}
          </button>
          <button
            className="rounded px-1 hover:bg-bg-4 hover:text-fg"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onDock}
            title={t('Encaixar (fechar a janela)')}
            aria-label={t('Encaixar')}
          >
            ✕
          </button>
        </div>
        <div className="relative min-h-0 flex-1">{children}</div>
      </div>
      <div
        className="absolute z-30 cursor-nwse-resize"
        style={{
          left: rect.x + rect.w - RESIZE_HANDLE_SIZE,
          top: rect.y + rect.h - RESIZE_HANDLE_SIZE,
          width: RESIZE_HANDLE_SIZE,
          height: RESIZE_HANDLE_SIZE,
          background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.25) 50%)',
        }}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        role="separator"
        aria-label={t('Redimensionar')}
      />
    </>
  );
}
