import { i18n } from '../i18n';
import { draftPlainText, isDraftFence } from '@termhub/mobile-api/draft-text';
import { copyText, copyWithExecCommand } from './clipboard';
import { renderMarkdown } from './markdown';
// A message the concierge wrote for the person to send to someone else (TER-1159) comes in a ```draft
// fence. This turns that fence, in the sanitised HTML `renderMarkdown` returns, into a "Mensagem pronta"
// card: the draft rendered as Markdown (through the same sanitiser, `markdownOnly`) under a header with
// a "Copiar" that puts both HTML and Slack-flavoured plain text on the clipboard (`copyDraft`).
//
// Runs before `decorateCodeBlocks`, which then never sees the draft's `<pre>` (it is gone) but still
// decorates a fence written inside the draft. Everything here is built through DOM APIs; the draft's
// own HTML is `renderMarkdown`'s output, re-parsed under the same no-foreign-content guarantee
// `code-blocks.ts` documents. The draft's Markdown source rides on the card as `data-draft-source`
// (an attribute set with `setAttribute`, so it is escaped text) for the copy to work from.

const DRAFT_ATTR = 'data-draft-block';
export const DRAFT_SOURCE_ATTR = 'data-draft-source';

/** Whether a fence's `<code class="language-…">` marks a draft. */
function isDraftCode(code: Element): boolean {
  const match = /(?:^|\s)language-(\S+)/.exec(code.getAttribute('class') ?? '');
  return !!match && isDraftFence(match[1]);
}

/** Replaces each ```draft fence with its card. Input must already be sanitised. Idempotent. */
export function decorateDraftBlocks(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const pre of Array.from(doc.body.querySelectorAll('pre'))) {
    if (pre.closest(`[${DRAFT_ATTR}]`)) continue;
    const code = pre.querySelector('code');
    if (!code || !isDraftCode(code)) continue;
    // The fence's own trailing newline is not part of the message (see `handleCopyClick`).
    const source = (code.textContent ?? '').replace(/\n$/, '');

    const figure = doc.createElement('figure');
    figure.setAttribute(DRAFT_ATTR, '');
    figure.setAttribute(DRAFT_SOURCE_ATTR, source);
    figure.className = 'draft-card';

    const header = doc.createElement('div');
    header.className = 'draft-card__header';

    const title = doc.createElement('span');
    title.className = 'draft-card__title';
    title.textContent = i18n.t('Mensagem pronta');

    const button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute('data-draft-copy', '');
    button.setAttribute('aria-label', i18n.t('Copiar mensagem'));
    button.className = 'draft-card__copy';
    const label = doc.createElement('span');
    label.setAttribute('data-copy-label', '');
    label.textContent = i18n.t('Copiar');
    button.appendChild(label);

    // Mounted with the card, like a code block's: a region inserted together with its text is not
    // reliably announced.
    const live = doc.createElement('span');
    live.setAttribute('data-copy-live', '');
    live.setAttribute('role', 'status');
    live.className = 'sr-only';

    const body = doc.createElement('div');
    body.className = 'draft-card__body';
    body.innerHTML = renderMarkdown(source, { markdownOnly: true });

    header.appendChild(title);
    header.appendChild(button);
    header.appendChild(live);
    figure.appendChild(header);
    figure.appendChild(body);
    pre.replaceWith(figure);
  }
  return doc.body.innerHTML;
}

/** The two versions a draft goes to the clipboard as: HTML Teams and Slack apply, and plain text. */
export function draftClipboard(source: string): { html: string; plain: string } {
  return { html: renderMarkdown(source, { markdownOnly: true }), plain: draftPlainText(source) };
}

/** The `execCommand` fallback with both versions: the copy event is where a page sets them. */
function copyRichWithExecCommand(html: string, plain: string): boolean {
  if (typeof document === 'undefined') return false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData('text/html', html);
    event.clipboardData.setData('text/plain', plain);
    event.preventDefault();
  };
  document.addEventListener('copy', onCopy, true);
  try {
    return copyWithExecCommand(plain);
  } finally {
    document.removeEventListener('copy', onCopy, true);
  }
}

/**
 * Puts a draft on the clipboard as HTML and plain text: `navigator.clipboard.write` with a
 * `ClipboardItem` where there is one, else `execCommand('copy')` with both set in the copy event, and
 * plain text alone (`copyText`) as the last resort. Resolves to whether anything was copied.
 */
export function copyDraft(source: string): Promise<boolean> {
  const { html, plain } = draftClipboard(source);
  let clipboard: Clipboard | undefined;
  try {
    clipboard = navigator.clipboard;
  } catch {
    clipboard = undefined;
  }
  const fallback = () => copyRichWithExecCommand(html, plain) || copyText(plain);
  if (!clipboard || typeof clipboard.write !== 'function' || typeof ClipboardItem === 'undefined') return Promise.resolve(fallback());
  try {
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' }),
    });
    return Promise.resolve(clipboard.write([item])).then(() => true, fallback);
  } catch {
    return Promise.resolve(fallback());
  }
}
