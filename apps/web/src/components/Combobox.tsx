import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../i18n';
import { useEscapeLayer } from './Modal';

export interface ComboboxOption {
  value: string;
  /** What the person reads; the value when left out. */
  label?: string;
  /** A second, dimmer text on the row. Also searched by the filter. */
  hint?: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  /** The list is on its way: shows a "loading" row and keeps the options it already has. */
  loading?: boolean;
  /**
   * The value does not have to be on the list (an `owner/repo` nobody listed yet): the filter opens with
   * the current value and behaves like a text field, so leaving it with Tab or a click outside keeps what
   * was typed, and only Esc discards it.
   */
  allowFreeText?: boolean;
  /**
   * Shows the text filter (default). Off, for a short fixed list (TER-1165): the panel is just the list,
   * walked with the arrows, Home/End and type-ahead like a native `<select>`, but placed next to the field
   * by the page instead of by the browser or the system, which on macOS with several screens can draw a
   * native list on another monitor. Ignored with `allowFreeText`.
   */
  searchable?: boolean;
  /** Shown on the closed field when the value is empty and no option has an empty value. */
  placeholder?: string;
  /** Called each time the panel opens, so a caller can load the options only when someone wants them. */
  onOpen?: () => void;
  disabled?: boolean;
  /** Lets a `<label htmlFor>` name the field. */
  id?: string;
  'aria-label'?: string;
  /** Monospaced text, for ids and paths. */
  mono?: boolean;
  /** Classes of the closed field, on top of `input` (`w-auto py-1 text-xs`). */
  className?: string;
  testId?: string;
}

/** The space the panel keeps from the field and from the viewport's edges. */
const GAP = 4;
const EDGE = 8;
const MAX_HEIGHT = 320;
const MIN_WIDTH = 200;
const FILTER_HEIGHT = 48;
const ROW_HEIGHT = 34;

/** Lowercase and without accents, so "sao" finds "São". */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Where a folded query falls in `text`, in indexes of the original text: folding can change the length
 * (a decomposed "é" is two units that fold to one), so the positions are mapped back character by character.
 */
export function matchRange(text: string, foldedQuery: string): [number, number] | null {
  if (!foldedQuery) return null;
  let folded = '';
  const starts: number[] = [];
  for (let i = 0; i < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(i)!);
    const piece = foldText(char);
    for (let k = 0; k < piece.length; k++) starts.push(i);
    folded += piece;
    i += char.length;
  }
  starts.push(text.length);
  const at = folded.indexOf(foldedQuery);
  return at < 0 ? null : [starts[at]!, starts[at + foldedQuery.length]!];
}

/**
 * Fixed-position box of the panel for a field at `rect`: under it when the panel fits or when there is at
 * least as much room below as above, otherwise over it, and never past the viewport's edges.
 */
export function placePanel(
  rect: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'width'>,
  rows: number,
  viewport: { width: number; height: number },
  withFilter = true,
): CSSProperties {
  const width = Math.min(Math.max(rect.width, MIN_WIDTH), viewport.width - 2 * EDGE);
  const left = Math.max(EDGE, Math.min(rect.left, viewport.width - width - EDGE));
  const wanted = Math.min(MAX_HEIGHT, (withFilter ? FILTER_HEIGHT : 8) + Math.max(rows, 1) * ROW_HEIGHT);
  const below = viewport.height - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  if (below >= wanted || below >= above) return { left, width, top: rect.bottom + GAP, maxHeight: Math.min(MAX_HEIGHT, below) };
  return { left, width, bottom: viewport.height - rect.top + GAP, maxHeight: Math.min(MAX_HEIGHT, above) };
}

const labelOf = (o: ComboboxOption) => o.label ?? o.value;

/** How long the letters typed on a list without filter add up to one search, like a native select's. */
const TYPEAHEAD_MS = 700;

/** The option `typed` (already folded) jumps to: the next one whose label starts with it, from `from`. */
export function typeaheadIndex(options: ComboboxOption[], typed: string, from: number): number {
  if (!typed || options.length === 0) return -1;
  // Repeating one letter cycles through the options that start with it, as in a native select.
  const cycling = typed.length > 1 && [...typed].every((c) => c === typed[0]);
  const prefix = cycling ? typed[0]! : typed;
  const start = cycling || typed.length === 1 ? from + 1 : from;
  for (let k = 0; k < options.length; k++) {
    const i = (((start + k) % options.length) + options.length) % options.length;
    if (foldText(labelOf(options[i]!)).startsWith(prefix)) return i;
  }
  return -1;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const range = matchRange(text, query);
  if (!range) return <>{text}</>;
  return (
    <>
      {text.slice(0, range[0])}
      <mark className="bg-transparent font-semibold text-accent">{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
    </>
  );
}

/**
 * Dropdown with a text filter, for lists a native `<select>` or `<datalist>` handles badly: the browser's
 * autocomplete covers a datalist, and neither one searches the middle of a long list. The panel goes to
 * `document.body` with fixed position, so a modal or a scrolling panel never clips it; React events still
 * bubble to the opener's tree, which keeps a modal's focus wrap working, and it joins the same Escape stack
 * as the modals, so Esc closes the panel and not the modal under it.
 */
export function Combobox({ value, onChange, options, loading = false, allowFreeText = false, searchable = true, placeholder, onOpen, disabled, id, 'aria-label': ariaLabel, mono = false, className = '', testId }: Props) {
  const { t } = useTranslation();
  const baseId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const withFilter = searchable || allowFreeText;
  const typeahead = useRef({ text: '', at: 0 });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // In free-text mode the filter opens holding the current value, which must not hide the rest of the
  // list: it only starts filtering once the person types.
  const [touched, setTouched] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<CSSProperties>({});
  const selectOnOpen = useRef(false);

  const listId = `${baseId}-list`;
  const valueId = `${baseId}-value`;
  const typed = query.trim();
  const folded = touched ? foldText(typed) : '';

  const rows = useMemo(() => {
    const found = folded ? options.filter((o) => [o.value, o.label ?? '', o.hint ?? ''].some((text) => foldText(text).includes(folded))) : options;
    const exact = options.some((o) => foldText(o.value) === folded || foldText(labelOf(o)) === folded);
    return { found, free: allowFreeText && folded !== '' && !exact };
  }, [options, folded, allowFreeText]);
  const rowCount = rows.found.length + (rows.free ? 1 : 0);
  const activeIndex = Math.min(active, rowCount - 1);

  const current = options.find((o) => o.value === value);
  const shown = current ? labelOf(current) : value;

  const measure = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPlace(placePanel(rect, options.length + (loading ? 1 : 0), { width: window.innerWidth, height: window.innerHeight }, withFilter));
  }, [options.length, loading, withFilter]);

  /** The index a letter typed on a list without filter moves to, or -1 when no label starts so. */
  const typeTo = (key: string, from: number) => {
    const now = Date.now();
    const text = now - typeahead.current.at < TYPEAHEAD_MS ? typeahead.current.text + foldText(key) : foldText(key);
    typeahead.current = { text, at: now };
    return typeaheadIndex(options, text, from);
  };

  const openPanel = (seed?: string) => {
    if (disabled || open) return;
    if (!withFilter) {
      const at = options.findIndex((o) => o.value === value);
      const typedTo = seed !== undefined ? typeTo(seed, at) : -1;
      setQuery('');
      setTouched(false);
      setActive(typedTo >= 0 ? typedTo : at >= 0 ? at : 0);
      measure();
      setOpen(true);
      onOpen?.();
      return;
    }
    const typedFirst = seed !== undefined;
    setQuery(seed ?? (allowFreeText ? value : ''));
    setTouched(typedFirst);
    selectOnOpen.current = !typedFirst;
    const at = options.findIndex((o) => o.value === value);
    setActive(typedFirst ? 0 : at >= 0 ? at : allowFreeText ? -1 : 0);
    measure();
    setOpen(true);
    onOpen?.();
  };

  const emit = (next: string) => {
    if (next !== value) onChange(next);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  /** What leaving the panel does to free text: the same as leaving a text field, it stays. */
  const keepTyped = () => {
    if (!allowFreeText || !touched) return;
    const same = options.find((o) => foldText(o.value) === foldText(typed) || foldText(labelOf(o)) === foldText(typed));
    emit(same ? same.value : typed);
  };
  const keepTypedRef = useRef(keepTyped);
  keepTypedRef.current = keepTyped;

  const choose = (index: number) => {
    if (index >= 0 && index < rows.found.length) emit(rows.found[index]!.value);
    else if (index >= 0 && rows.free) emit(typed);
    else keepTyped();
    close(true);
  };

  useEscapeLayer(open, () => close(true));

  useLayoutEffect(() => {
    if (!open) return;
    if (!withFilter) {
      listRef.current?.focus({ preventScroll: true });
      return;
    }
    filterRef.current?.focus({ preventScroll: true });
    if (selectOnOpen.current) filterRef.current?.select();
  }, [open]);

  // Follow the field while something scrolls or resizes, and let go once it has left the screen.
  useEffect(() => {
    if (!open) return;
    measure();
    const onMove = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect && (rect.bottom < 0 || rect.top > window.innerHeight)) {
        keepTypedRef.current();
        setOpen(false);
        return;
      }
      measure();
    };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      // The field's own click toggles the panel closed.
      if (triggerRef.current?.contains(target)) return;
      keepTypedRef.current();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${baseId}-opt-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, baseId]);

  const onTriggerKeyDown = (e: ReactKeyboardEvent) => {
    if (open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openPanel();
    } else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // With a filter the letter starts the search; without one it jumps to the option, as type-ahead.
      e.preventDefault();
      openPanel(e.key);
    }
  };

  const onFilterKeyDown = (e: ReactKeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rowCount === 0) return;
      setActive(e.key === 'ArrowDown' ? (activeIndex + 1) % rowCount : activeIndex <= 0 ? rowCount - 1 : activeIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(activeIndex);
    } else if (e.key === 'Tab') {
      // The panel lives at the end of <body>: from the field, the browser's own Tab (or a modal's wrap,
      // which sees this same key next) moves on from where the person actually is on the page.
      keepTyped();
      close(true);
    }
  };

  /** The keys of the list itself when there is no filter: the ones a native select's open list takes. */
  const onListKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rowCount === 0) return;
      // A native list stops at the ends instead of wrapping.
      setActive(e.key === 'ArrowDown' ? Math.min(activeIndex + 1, rowCount - 1) : Math.max(activeIndex - 1, 0));
    } else if (e.key === 'Home' || e.key === 'PageUp') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' || e.key === 'PageDown') {
      e.preventDefault();
      setActive(rowCount - 1);
    } else if (e.key === 'Enter' || (e.key === ' ' && Date.now() - typeahead.current.at >= TYPEAHEAD_MS)) {
      e.preventDefault();
      choose(activeIndex);
    } else if (e.key === 'Tab') {
      close(true);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const to = typeTo(e.key, activeIndex);
      if (to >= 0) setActive(to);
    }
  };

  const onFilterChange = (next: string) => {
    setQuery(next);
    setTouched(true);
    setActive(next.trim() || !allowFreeText ? 0 : -1);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        // A <label> or an aria-label replaces the button's text as its name: the value still gets read.
        aria-describedby={id || ariaLabel ? valueId : undefined}
        className={`input flex items-center justify-between gap-2 text-left disabled:opacity-60 ${mono ? 'font-mono' : ''} ${className}`}
        onClick={() => (open ? close(false) : openPanel())}
        onKeyDown={onTriggerKeyDown}
      >
        <span id={valueId} className={`min-w-0 truncate ${current || value ? '' : 'text-fg-dim'}`}>
          {current || value ? shown : placeholder}
        </span>
        <span className="shrink-0 text-[10px] text-fg-dim" aria-hidden>
          ▼
        </span>
      </button>
      {open &&
        createPortal(
          <div ref={panelRef} style={place} className="fixed z-[60] flex flex-col rounded-md border border-line bg-bg-2 shadow-xl" data-testid={testId ? `${testId}-panel` : undefined}>
            {withFilter && (
            <input
              ref={filterRef}
              type="text"
              role="combobox"
              aria-expanded
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined}
              aria-label={ariaLabel ? t('Filtrar: {{field}}', { field: ariaLabel }) : t('Filtrar')}
              // No name and autocomplete off: nothing for the browser or a password manager to fill in over the list.
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              className={`w-full shrink-0 rounded-t-md border-b border-line bg-transparent px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:outline-none ${mono ? 'font-mono' : ''}`}
              placeholder={allowFreeText ? t('Filtrar ou digitar…') : t('Filtrar…')}
              value={query}
              onChange={(e) => onFilterChange(e.target.value)}
              onKeyDown={onFilterKeyDown}
            />
            )}
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              // Without a filter the list holds the focus, and points at the row the arrows are on.
              tabIndex={withFilter ? undefined : -1}
              aria-activedescendant={!withFilter && activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined}
              onKeyDown={withFilter ? undefined : onListKeyDown}
              className={`min-h-0 flex-1 overflow-y-auto py-1 text-sm focus:outline-none ${withFilter ? '' : 'rounded-md'}`}
            >
              {rows.found.map((o, i) => (
                <li
                  key={o.value}
                  id={`${baseId}-opt-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  className={`flex cursor-pointer items-baseline gap-2 px-3 py-1.5 ${i === activeIndex ? 'bg-bg-3' : ''} ${o.value === value ? 'text-accent' : 'text-fg'}`}
                  // Keeps focus on the filter, so the click is not read as leaving the field.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(i)}
                >
                  <span className={`min-w-0 truncate ${mono ? 'font-mono' : ''}`}>
                    <Highlighted text={labelOf(o)} query={folded} />
                  </span>
                  {o.hint && (
                    <span className="min-w-0 truncate text-xs text-fg-dim">
                      <Highlighted text={o.hint} query={folded} />
                    </span>
                  )}
                </li>
              ))}
              {rows.free && (
                <li
                  id={`${baseId}-opt-${rows.found.length}`}
                  role="option"
                  aria-selected={false}
                  className={`cursor-pointer truncate px-3 py-1.5 text-fg ${activeIndex === rows.found.length ? 'bg-bg-3' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(rows.found.length)}
                  onClick={() => choose(rows.found.length)}
                >
                  {t('Usar "{{value}}"', { value: typed })}
                </li>
              )}
              {loading && <li className="px-3 py-1.5 text-xs text-fg-dim">{t('Carregando…')}</li>}
              {!loading && rowCount === 0 && <li className="px-3 py-1.5 text-xs text-fg-dim">{t('Nada encontrado')}</li>}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
