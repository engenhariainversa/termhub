// Copying text from a click, with a fallback for where the Clipboard API is not there or refuses: an
// insecure context (http on a LAN address), a WebView, an older browser, Firefox without the permission.
// The fallback is the old one — select the text in an off-screen textarea and `execCommand('copy')` —
// which still works in those places as long as it runs inside the user's gesture.

/** Copies `text` the old way: an off-screen textarea, selected, and `execCommand('copy')`. Never throws. */
export function copyWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const area = document.createElement('textarea');
  area.value = text;
  // Read-only so a phone does not pop its keyboard; off-screen and fixed so the page does not scroll.
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  area.style.opacity = '0';
  const focused = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    // Hand the focus back to whatever had it (the copy button), so the keyboard user stays where they were.
    focused?.focus?.();
  }
}

/**
 * Puts `text` on the clipboard: `navigator.clipboard.writeText` when it exists and succeeds, else the
 * `execCommand` fallback. Resolves to whether either worked; never rejects.
 *
 * The fallback runs synchronously when there is no Clipboard API at all, so it is still inside the
 * click's user activation. After a rejected `writeText` it runs a microtask later, which browsers still
 * count as part of the same gesture.
 */
export function copyText(text: string): Promise<boolean> {
  let clipboard: Clipboard | undefined;
  try {
    clipboard = navigator.clipboard;
  } catch {
    clipboard = undefined;
  }
  if (!clipboard || typeof clipboard.writeText !== 'function') return Promise.resolve(copyWithExecCommand(text));
  try {
    // `Promise.resolve` so a `writeText` that returns undefined (or anything else) counts as done
    // instead of throwing on `.then`.
    return Promise.resolve(clipboard.writeText(text)).then(
      () => true,
      () => copyWithExecCommand(text),
    );
  } catch {
    // `writeText` threw synchronously.
    return Promise.resolve(copyWithExecCommand(text));
  }
}
