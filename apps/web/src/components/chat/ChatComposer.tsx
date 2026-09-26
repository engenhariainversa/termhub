import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { sendsMessage } from '../../lib/chat-scroll';
import { useDictation, type Dictation } from '../../lib/use-dictation';

export interface ChatComposerProps {
  /**
   * Sends what is in the box, with the ids of the uploaded attachments (none until the attachment
   * chips land). The box is emptied the moment this is called — a box that keeps the sent text until
   * the server answers reads as a chat that swallowed the message — and the text comes back when this
   * resolves `false` (or throws), unless something new was typed meanwhile. Several sends may be in
   * flight at once: an answer being written never locks the box (spec 2026-09-26, concierge always free).
   */
  onSend: (text: string, attachmentIds: string[]) => Promise<boolean>;
  /**
   * Why nothing can be sent right now — the chat's host cannot run it (no machine, none chosen, one
   * that is asleep, an agent too old). The button refuses and this is the reason it shows: a box that
   * goes grey with no explanation is the one thing this screen must never do. The text itself stays
   * editable, so a message can be typed while the machine is being woken up.
   */
  blockedReason?: string | null;
  /** The last send or decision error (pt-BR), shown in the status line in the danger colour. */
  status?: string | null;
}

const MIN_ROWS = 1;
const MAX_ROWS = 8;
/** What a line is taken to measure when the box has no computed line height (jsdom). */
const FALLBACK_LINE_PX = 24;

/**
 * Appends a transcription to whatever is already in the box.
 *
 * Whisper returns its own leading/trailing spaces, so the clip is trimmed and a single space is
 * inserted, except when the box is empty (no leading space) or already ends in whitespace, where the
 * separator the person typed is kept exactly: a newline they wrote stays a newline. A clip that trims
 * away to nothing (silence, a stray tap) leaves the box untouched.
 *
 * In this product a transcription can only ever arrive into an empty or whitespace-only box: with text
 * in it the single button is the send arrow, so there is no microphone left to press. The joining
 * branch is the guard for a future where the mic survives typed text, not a path anyone walks today.
 */
function appendDictated(current: string, text: string): string {
  const clip = text.trim();
  if (!clip) return current;
  if (!current) return clip;
  return /\s$/.test(current) ? current + clip : `${current} ${clip}`;
}

/** Whole seconds as `m:ss` — 65 reads as `1:05`, the way a stopwatch is read. */
function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** What the single circular button does right now. Exactly one of these, in every state. */
type PrimaryRole = 'dictate' | 'send' | 'stop';

const PRIMARY_LABEL: Record<PrimaryRole, string> = {
  dictate: 'Ditar',
  send: 'Enviar',
  stop: 'Parar',
};

/**
 * The message box and its one action button. Owns its text, its height and its dictation — the panel
 * only learns of the text when it is sent, so a keystroke re-renders this box and nothing else.
 *
 * Grows with the content up to `MAX_ROWS` and then scrolls: no library and no hidden mirror element.
 * The height is measured in a layout effect (`height: auto`, then the box's own `scrollHeight` capped
 * at eight lines), so it is set before paint — the box never shows at the old height for a frame, and
 * there is no `rows` round trip. jsdom lays nothing out (`scrollHeight` is 0 and no line height is
 * computed), so the measurement floors at one line of a fallback height.
 *
 * Enter sends on a fine pointer (a mouse) and writes a newline on a coarse one (a touch keyboard,
 * where Enter is how every other line got started); Shift+Enter is always a newline, on either. Either
 * way it can only send what the button itself would send.
 */
export function ChatComposer({ onSend, blockedReason, status }: ChatComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');

  // The hook keeps the latest callback; the functional update reads the box as it is when the clip lands.
  const dictation = useDictation((clip) => {
    setText((current) => appendDictated(current, clip));
    // The button the person just pressed is disabled by now and about to change role, so a browser
    // has already dropped focus to `body` — a keyboard user would lose their place at the exact
    // moment the text appears. The box is also where they want to be: what anyone does with a
    // transcription is read it and fix it.
    ref.current?.focus();
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Collapsing the box to measure it also collapses how far it can be scrolled, and the browser
    // clamps `scrollTop` to that while it is collapsed — restoring the height does not bring the
    // scroll position back. Without this, a message past `MAX_ROWS` jumped to its first line on
    // every keystroke.
    const scrollTop = el.scrollTop;
    // `auto` first, so deleting a line shrinks the box back down too, not just growth.
    el.style.height = 'auto';
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || FALLBACK_LINE_PX;
    const vPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const min = lineHeight * MIN_ROWS + vPadding;
    const max = lineHeight * MAX_ROWS + vPadding;
    el.style.height = `${Math.min(max, Math.max(min, el.scrollHeight))}px`;
    el.scrollTop = scrollTop;
  }, [text]);

  const hasText = text.trim().length > 0;
  /** The clip is on its way to the server: nothing else can be done with the box's content yet. */
  const busy = dictation.state === 'uploading' || dictation.state === 'transcribing';
  // Recording outranks the text: a box that is listening stops, it never sends mid-sentence. With
  // nothing typed the button dictates — unless dictation is off, where the empty box keeps the
  // ordinary (disabled) send button and nothing explains the missing microphone, because a browser
  // that cannot record is not a fault the person can fix from this screen. While the hook is still
  // `checking` the button is already the microphone, just disabled: dictation is what an empty box is
  // about to offer, and showing a send arrow for that instant only to swap it is a flicker. `starting`
  // is the same microphone, also disabled: the browser's permission sheet is up, nothing is listening
  // yet, and a button that looks pressable there does nothing when it is pressed.
  // A blocked host makes the button the (disabled) send arrow: dictating more text into a box that
  // cannot send it is an invitation to lose it. A recording already under way still stops, so nothing
  // is left listening.
  const blocked = Boolean(blockedReason);
  const role: PrimaryRole = dictation.state === 'recording' ? 'stop' : hasText || blocked || dictation.state === 'off' ? 'send' : 'dictate';
  const notReadyToDictate = busy || dictation.state === 'checking' || dictation.state === 'starting';
  const disabled = role === 'stop' ? false : role === 'send' ? blocked || !hasText || busy : blocked || notReadyToDictate;
  /** The one condition sending obeys, so the keyboard can never send what the button would refuse. */
  const canSend = role === 'send' && !disabled;

  // Never refused for a send still in flight: the box empties at once, so a second click has nothing to
  // send, and a message typed meanwhile goes to the concierge at once (spec 2026-09-26).
  const send = useCallback(async () => {
    const value = text.trim();
    if (!value) return;
    // Cleared before the request, not after (see `onSend`). On failure the text comes back below.
    setText('');
    let ok = false;
    try {
      ok = await onSend(value, []);
    } catch {
      ok = false;
    }
    // Give the text back so nothing is lost — unless something new was typed meanwhile.
    if (!ok) setText((current) => current || value);
  }, [text, onSend]);

  // One line, fixed height, always mounted: what appears here moves nothing. The host's own reason
  // outranks everything (it is the one that is not going to resolve on its own); a clip being
  // transcribed comes next (its text is about to land in this very box); then the last send or
  // decision error. An answer being written never locks the box, so nothing here says to wait for it.
  const line = blockedReason
    ? { text: blockedReason, danger: false }
    : busy
      ? { text: 'transcrevendo…', danger: false }
      : status
        ? { text: status, danger: true }
        : { text: '', danger: false };

  return (
    // `env(safe-area-inset-bottom)` resolves to 0px in every browser today, because the app-wide
    // viewport meta in `index.html` has no `viewport-fit=cover` — this padding is not protecting
    // anything yet, it is what becomes correct the day that meta changes (a change that touches the
    // terminal pages too, so it is not made here). The soft keyboard is a separate follow-up.
    <div className="mb-4 pb-[env(safe-area-inset-bottom)]">
      {/* One rounded box on the page background: the text on top, the action row beneath it (the
          attachment chips go above the text when they land). The box, not the textarea, shows the
          focus — the textarea's own outline would draw inside the rounded border, so it is dropped
          and the border lights up instead; a keyboard user must still see where they are. */}
      <div className="min-w-0 rounded-2xl border border-line bg-bg px-3 py-2 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
        {/* 16px, not the 14px the rest of the chat uses: iOS Safari zooms the page into any field
            whose font is under 16px the moment it takes focus, and a zoomed page is wider than the
            screen — which is what "the side blows out when I tap the box" was. The zoom is silent,
            irreversible without a pinch, and it also lets the whole page pan vertically afterwards. */}
        <textarea
          ref={ref}
          className="block w-full resize-none overflow-y-auto overscroll-contain border-0 bg-transparent px-0 py-1 text-base text-fg placeholder:text-fg-dim focus:outline-none"
          rows={MIN_ROWS}
          value={text}
          placeholder="Pergunte ou peça algo às suas máquinas"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // `canSend`, not just the key rule: while the box is recording the button reads "Parar",
            // and an Enter that still sent put a half-typed line in front of an agent that acts on the
            // person's real machines — with the transcription then landing in the box that send had
            // just emptied. Nothing is swallowed when it cannot send: the Enter stays the newline the
            // textarea would have written anyway.
            if (sendsMessage(e) && canSend) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          {/* The left slot of the row: the attachment button ("Anexar arquivo") mounts here when the
              chips land; until then it only keeps the right-hand group where the thumb expects it. */}
          <div className="flex items-center gap-1" />
          <div className="flex min-w-0 items-center gap-2">
            {dictation.state === 'recording' && <RecordingStatus dictation={dictation} />}
            {/* Mounted at all times: a live region a browser inserts together with its text is not
                reliably announced — the region has to be in the accessibility tree before the text
                changes. Fixed height (`h-4`), so a line appearing here shifts nothing. Deliberately not
                on the clock next door: a live region that ticks every second is worse than one that
                says nothing. */}
            <span role="status" title={line.text || undefined} className={`h-4 min-w-0 truncate text-xs leading-4 ${line.danger ? 'text-danger' : 'text-fg-muted'}`}>
              {line.text}
            </span>
            <button
              type="button"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={PRIMARY_LABEL[role]}
              title={PRIMARY_LABEL[role]}
              disabled={disabled}
              onClick={role === 'stop' ? dictation.stop : role === 'send' ? () => void send() : dictation.start}
            >
              {role === 'stop' ? <StopIcon /> : role === 'send' ? <ArrowUpIcon /> : <MicIcon />}
            </button>
          </div>
        </div>
      </div>
      {/* Both mounted at all times, for the same reason as the status above, and told apart by colour
          rather than by wording: an error is a failure (`danger`), a notice is not (`fg-muted`) — a
          clip too short to hold speech, or one with no words in it, is nobody's fault. `empty:mt-0`
          keeps an empty one from holding a line of space open. */}
      <p role="status" className="mt-1 px-1 text-xs text-danger empty:mt-0">
        {dictation.error ?? ''}
      </p>
      <p role="status" className="mt-1 px-1 text-xs text-fg-muted empty:mt-0">
        {dictation.notice ?? ''}
      </p>
    </div>
  );
}

/**
 * Next to the status while the mic is open: it is listening, for this long, and it can be dropped.
 * Only while `recording` — once the clip is uploading, the hook's `cancel()` can no longer stop
 * anything, so a cancel button there would be a promise the product cannot keep.
 */
function RecordingStatus({ dictation }: { dictation: Dictation }) {
  return (
    <>
      <span className="h-2 w-2 animate-pulse rounded-full bg-attention" aria-hidden="true" />
      <span className="font-mono text-xs text-fg">{formatClock(dictation.seconds)}</span>
      <button type="button" className="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-bg-3 hover:text-fg" onClick={dictation.cancel}>
        cancelar
      </button>
    </>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4M8 21h8" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20V4" />
      <path d="M5 11l7-7 7 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  );
}
