/**
 * "Responder" (TER-447) on a row of the thread — a message, or a confirmation or question card
 * (TER-849): shown on hover and on keyboard focus of its `group`, and always on a device with no hover.
 */
export function ChatReplyButton({ onClick, label = 'Responder' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-dim opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
    >
      {label}
    </button>
  );
}
