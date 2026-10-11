import { useTranslation } from '../../i18n';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CHAT_DEFAULT_WIDTH, CHAT_MAX_WIDTH, CHAT_MIN_WIDTH, clampChatWidth } from '../../lib/project-chat-prefs';

export const CHAT_WIDTH_STEP = 16;

/** The dock is on the right: its width is the distance from the pointer to its right edge. */
export const widthFromPointer = (asideRight: number, x: number): number => clampChatWidth(asideRight - x);

export function nudgeWidth(width: number, key: string): number | null {
  switch (key) {
    case 'ArrowLeft':
      return clampChatWidth(width + CHAT_WIDTH_STEP);
    case 'ArrowRight':
      return clampChatWidth(width - CHAT_WIDTH_STEP);
    case 'Home':
      return CHAT_MAX_WIDTH;
    case 'End':
      return CHAT_MIN_WIDTH;
    default:
      return null;
  }
}

/**
 * The chat dock's left edge (spec 2026-09-26 project chat dock §4.6). A drag shows a line and commits
 * the width once, on release: the terminals beside the chat re-fit once and the PTY gets one resize,
 * instead of one per frame. A transparent overlay covers the page while dragging, so xterm never takes
 * the pointer.
 */
export function ChatResizer({ width, onCommit }: { width: number; onCommit: (w: number) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const right = useRef(0);
  const [dragX, setDragX] = useState<number | null>(null);

  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    right.current = ref.current?.parentElement?.getBoundingClientRect().right ?? 0;
    try {
      ref.current?.setPointerCapture?.(e.pointerId);
    } catch {
      /* no capture (a synthetic event): the overlay still catches the moves */
    }
    setDragX(e.clientX);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragX !== null) setDragX(e.clientX);
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragX === null) return;
    setDragX(null);
    onCommit(widthFromPointer(right.current, e.clientX));
  };

  return (
    <>
      <div
        ref={ref}
        role="separator"
        tabIndex={0}
        aria-label={t('Largura do chat')}
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={CHAT_MIN_WIDTH}
        aria-valuemax={CHAT_MAX_WIDTH}
        title={t('Arraste para mudar a largura (duplo clique volta ao padrão)')}
        className="absolute inset-y-0 -left-[3px] z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => setDragX(null)}
        onDoubleClick={() => onCommit(CHAT_DEFAULT_WIDTH)}
        onKeyDown={(e) => {
          const next = nudgeWidth(width, e.key);
          if (next === null) return;
          e.preventDefault();
          onCommit(next);
        }}
      />
      {dragX !== null && (
        <div
          data-testid="chat-resize-overlay"
          className="fixed inset-0 z-50 cursor-col-resize"
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={() => setDragX(null)}
        >
          <div className="absolute inset-y-0 w-0.5 bg-accent" style={{ left: right.current - widthFromPointer(right.current, dragX) }} />
        </div>
      )}
    </>
  );
}
