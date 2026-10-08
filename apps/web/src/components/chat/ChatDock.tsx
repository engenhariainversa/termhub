import { useTranslation } from '../../i18n';
import { memo, useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useData } from '../../lib/data';
import { useNarrowWindow } from '../../lib/narrow-window';
import { useProjectChat } from '../../lib/project-chat';
import { trackAppHeight } from '../../lib/viewport';
import { ChatPanel } from './ChatPanel';
import { ChatResizer } from './ChatResizer';
import { ChatHeaderSlot } from './chat-header-slot';

// `ChatDock` re-renders on every status, pref or `alive` change (each is a new `useProjectChat()`
// value), which would otherwise re-render every one of the up-to-3 mounted panels too, tearing down
// and rebuilding whatever local state a re-render loses. `ChatPanel`'s only prop is `projectId`, which
// changes only when a panel actually mounts or unmounts, so memoizing it here skips all of those
// unrelated re-renders. Module-level (not created per render of `ChatDock`), so the memoized identity
// is stable across the dock's own re-renders.
const DockPanel = memo(ChatPanel);

type SlotMap = ReadonlyMap<string, HTMLElement>;

/**
 * The element in a panel's header its cog is portalled into (TER-1039), registered by project id so
 * each panel gets its own header's slot. The ref is stable per id, so the map only changes when an
 * element mounts or unmounts, and the memoized panels re-render for that and nothing else.
 */
function DockSlot({ id, onSlot }: { id: string; onSlot: Dispatch<SetStateAction<SlotMap>> }) {
  const ref = useCallback(
    (el: HTMLDivElement | null) =>
      onSlot((prev) => {
        if (el ? prev.get(id) === el : !prev.has(id)) return prev;
        const next = new Map(prev);
        if (el) next.set(id, el);
        else next.delete(id);
        return next;
      }),
    [id, onSlot],
  );
  return <div ref={ref} className="flex items-center" />;
}

/**
 * The project chat, docked in the project window (spec 2026-09-26 project chat dock §4.5). Rendered in
 * `Layout` right after `main`, so on desktop it is a column beside the page and the terminals re-fit
 * to the space left. Only the project on screen shows its chat, and only when it is open there.
 *
 * Every alive panel is rendered here, under this one parent and keyed by project, so showing another
 * one only changes classes: nothing remounts, and an answer keeps streaming into the panel left
 * behind. The hidden ones sit off screen with their last width (laid out, so the thread keeps its
 * scroll and never reads 0×0) and `inert`, so focus and screen readers skip them. They are rendered in
 * a stable order: a keyed reorder would move DOM nodes, which can reset their scroll.
 *
 * Escape does not close it: next to a terminal, Escape belongs to the program running there.
 *
 * No ancestor of the dock (this component or anything above it in `Layout`) may get a `transform`,
 * `filter` or `contain` style: any of those creates a new containing block, and a hidden panel is
 * positioned `fixed` (`-left-[200vw]`, off screen) precisely so it stays laid out without taking space
 * in the flow — inside a `transform`ed ancestor `fixed` would resolve against that ancestor instead of
 * the viewport, breaking the "still laid out, never 0×0" trick this file's docstring above relies on.
 */
export function ChatDock() {
  const { t } = useTranslation();
  const { alive, shownProjectId, pref, setOpen, setWidth, setMaximized } = useProjectChat();
  const { projects } = useData();
  const narrow = useNarrowWindow();
  const fullScreen = narrow && shownProjectId !== null;

  // The composer has to stay above the on-screen keyboard wherever the chat is shown. iPadOS, like
  // iOS, never shrinks the layout viewport for the keyboard, only the visual one: a docked chat in a
  // row sized to the full screen kept its composer behind the keyboard, Safari scrolled the whole
  // page up to reveal it, and the keyboard's extra scroll range then let the page pan on past the
  // row's end into empty background (TER-313). `Layout`'s row reads `--app-height`, so tracking it
  // here sizes the docked chat, the page and the sidebar to what is visible. On a window without a
  // touch screen (a desktop) the tracker is a no-op and the row keeps its full height (TER-385).
  useEffect(() => (shownProjectId !== null ? trackAppHeight() : undefined), [shownProjectId]);
  // On a phone the chat covers the page, with the same body lock as `/chat` (ChatLayout), so a drag on
  // the composer does not pan the document. Not on a wide window: the lock's `touch-action: pan-y`
  // would also stop the sideways scroll of the page beside the dock (the board's columns).
  useEffect(() => {
    if (!fullScreen) return;
    document.body.classList.add('chat-locked');
    return () => document.body.classList.remove('chat-locked');
  }, [fullScreen]);

  const [slots, setSlots] = useState<SlotMap>(() => new Map());

  const ids = [...new Set(shownProjectId ? [...alive, shownProjectId] : alive)].sort();
  if (ids.length === 0) return null;

  return (
    <>
      {ids.map((id) => {
        const shown = id === shownProjectId;
        const p = pref(id);
        const title = t('Chat · {{name}}', { name: projects.find((x) => x.id === id)?.name ?? t('projeto') });
        const docked = shown && !narrow && !p.maximized;
        const place = !shown
          ? 'fixed top-0 -left-[200vw] h-full'
          : narrow
            ? 'fixed inset-x-0 top-0 z-40 h-[var(--app-height,100svh)]'
            : p.maximized
              ? 'relative min-w-0 flex-1'
              : 'relative max-w-[60%] shrink-0';
        return (
          <aside
            key={id}
            aria-label={title}
            aria-hidden={shown ? undefined : true}
            inert={!shown}
            className={`flex flex-col border-l border-line bg-bg ${place}`}
            style={shown && (narrow || p.maximized) ? undefined : { width: p.width }}
          >
            {docked && <ChatResizer width={p.width} onCommit={(w) => setWidth(id, w)} />}
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-bg-2 px-3">
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{title}</h2>
              {/* The panel's cog (TER-1039) lands here, before the dock's own window controls. */}
              <DockSlot id={id} onSlot={setSlots} />
              {!narrow && (
                <button
                  type="button"
                  className="rounded px-2 py-1 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg"
                  aria-label={p.maximized ? t('Sair da tela cheia') : t('Tela cheia')}
                  title={p.maximized ? t('Sair da tela cheia') : t('Tela cheia')}
                  onClick={() => setMaximized(id, !p.maximized)}
                >
                  {p.maximized ? '⤡' : '⤢'}
                </button>
              )}
              <button type="button" className="rounded px-2 py-1 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg" aria-label={t('Fechar chat')} title={t('Fechar')} onClick={() => setOpen(id, false)}>
                ✕
              </button>
            </header>
            <div className="flex min-h-0 flex-1 flex-col">
              <ChatHeaderSlot.Provider value={slots.get(id) ?? null}>
                <DockPanel projectId={id} />
              </ChatHeaderSlot.Provider>
            </div>
          </aside>
        );
      })}
    </>
  );
}
