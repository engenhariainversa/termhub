// What "Copiar" on a chat message puts on the clipboard (TER-1090): the message as it reads, in plain
// text. The app has its own port over markdown-it tokens (apps/mobile/src/features/chat/model/message-text.ts);
// both write lists, tables and links the same way.
import { renderMarkdown } from './markdown';
import type { ChatMessage } from './types';

const BLOCK = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE']);
/** Containers whose whitespace-only text is the serialiser's line breaks between blocks, not content. */
const STRUCTURE = new Set(['BODY', 'UL', 'OL', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'LI']);

function walk(node: Node, out: string[], depth: number): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    if (!text.trim() && STRUCTURE.has(node.parentElement?.tagName ?? 'BODY')) return;
    out.push(text.replace(/\s+/g, ' '));
    return;
  }
  if (!(node instanceof Element)) return;
  const tag = node.tagName;
  const children = () => node.childNodes.forEach((child) => walk(child, out, depth));
  if (tag === 'BR') out.push('\n');
  else if (tag === 'PRE') out.push((node.textContent ?? '').replace(/\n?$/, '\n\n'));
  else if (tag === 'HR') out.push('\n');
  else if (tag === 'UL' || tag === 'OL') {
    let n = Number(node.getAttribute('start') ?? 1);
    for (const item of Array.from(node.children)) {
      if (item.tagName !== 'LI') continue;
      const last = out.at(-1) ?? '';
      if (out.length > 0 && !last.endsWith('\n')) out.push('\n');
      out.push(`${'  '.repeat(depth)}${tag === 'OL' ? `${n++}. ` : '• '}`);
      item.childNodes.forEach((child) => {
        if (child instanceof Element && child.tagName === 'P') {
          child.childNodes.forEach((c) => walk(c, out, depth + 1));
          out.push('\n');
        } else walk(child, out, depth + 1);
      });
    }
    out.push('\n');
  } else if (tag === 'A') {
    const from = out.length;
    children();
    const words = out.slice(from).join('').trim();
    const href = node.getAttribute('href') ?? '';
    if (href && words !== href) out.push(` (${href})`);
  } else if (tag === 'TD' || tag === 'TH') {
    children();
    out.push('\t');
  } else if (tag === 'TR') {
    children();
    if (out.at(-1) === '\t') out.pop();
    out.push('\n');
  } else if (tag === 'TABLE') {
    children();
    out.push('\n');
  } else if (BLOCK.has(tag)) {
    children();
    out.push('\n\n');
  } else children();
}

/** Rendered Markdown (the chat's own HTML) as the plain text it reads as: a link keeps its address. */
export function plainTextOfHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  walk(doc.body, out, 0);
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * What "Copiar" copies of a row: the person's words as typed (never parsed as Markdown), the answer as
 * it reads, and an audio attachment's transcript when there is one. Empty when there is nothing to copy.
 */
export function messageCopyText(message: Pick<ChatMessage, 'role' | 'text' | 'attachments'>): string {
  const text = message.role === 'user' ? message.text.trim() : message.text ? plainTextOfHtml(renderMarkdown(message.text, { markdownOnly: true })) : '';
  const transcripts = (message.attachments ?? []).map((a) => a.transcript?.trim() ?? '').filter(Boolean);
  return [text, ...transcripts].filter(Boolean).join('\n\n');
}

/** The first web address in a text, without the punctuation that closes the sentence around it. */
export function firstLink(text: string): string | null {
  const match = /\bhttps?:\/\/[^\s<>"'`]+/i.exec(text);
  if (!match) return null;
  let url = match[0].replace(/[.,;:!?]+$/, '');
  // A `)` belongs to the address only when the address opened one (`…/Foo_(bar)`).
  while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
  return url;
}
