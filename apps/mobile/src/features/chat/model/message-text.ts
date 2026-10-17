import type { ChatMessage } from './types';

/** The part of a markdown-it token this file reads (`MarkdownIt().parse`'s output). */
export type MdToken = {
  type: string;
  content: string;
  hidden?: boolean;
  attrs?: [string, string][] | null;
  children?: MdToken[] | null;
};

/** Parses Markdown into markdown-it tokens: the renderer's own parser, handed in by the view. */
export type MdParse = (markdown: string) => MdToken[];

const attr = (token: MdToken, name: string): string | undefined => token.attrs?.find(([key]) => key === name)?.[1];

/** One inline run as text: a link keeps its address after its words, unless the words are the address. */
function inlineText(tokens: readonly MdToken[]): string {
  let out = '';
  let link: { href: string; from: number } | null = null;
  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'code_inline' || token.type === 'html_inline') out += token.content;
    else if (token.type === 'softbreak' || token.type === 'hardbreak') out += '\n';
    else if (token.type === 'image') out += token.content;
    else if (token.type === 'link_open') link = { href: attr(token, 'href') ?? '', from: out.length };
    else if (token.type === 'link_close' && link) {
      const words = out.slice(link.from).trim();
      if (link.href && words !== link.href) out += ` (${link.href})`;
      link = null;
    }
  }
  return out;
}

/**
 * What an answer reads as once rendered, in plain text (TER-1090's "Copiar"): no `**`, `#` or fences,
 * a paragraph per blank line, a bullet as "• ", a numbered item with its number, a table cell after a
 * tab, and every link with its address (`termhub (https://termhub.dev)`).
 */
export function plainTextOfMarkdown(markdown: string, parse: MdParse): string {
  const lists: { ordered: boolean; next: number }[] = [];
  let out = '';
  for (const token of parse(markdown)) {
    switch (token.type) {
      case 'inline':
        out += inlineText(token.children ?? []);
        break;
      case 'paragraph_close':
        out += token.hidden ? '\n' : '\n\n';
        break;
      case 'heading_close':
      case 'blockquote_close':
        out += '\n\n';
        break;
      case 'fence':
      case 'code_block':
        out += token.content.replace(/\n?$/, '\n\n');
        break;
      case 'hr':
        out += '\n';
        break;
      case 'bullet_list_open':
        lists.push({ ordered: false, next: 0 });
        break;
      case 'ordered_list_open':
        lists.push({ ordered: true, next: Number(attr(token, 'start') ?? 1) });
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        lists.pop();
        if (lists.length === 0) out += '\n';
        break;
      case 'list_item_open': {
        const list = lists[lists.length - 1];
        const indent = '  '.repeat(Math.max(0, lists.length - 1));
        if (!out.endsWith('\n') && out.length > 0) out += '\n';
        out += list?.ordered ? `${indent}${list.next++}. ` : `${indent}• `;
        break;
      }
      case 'th_close':
      case 'td_close':
        out += '\t';
        break;
      case 'tr_close':
        out = out.replace(/\t$/, '') + '\n';
        break;
      case 'table_close':
        out += '\n';
        break;
    }
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * What "Copiar" puts on the clipboard for a row: the person's words as typed (they are never parsed as
 * Markdown), the answer as it reads, and an audio attachment's transcript when there is one. Empty when
 * there is nothing to copy (a picture alone): the menu then offers no "Copiar".
 */
export function messageCopyText(message: Pick<ChatMessage, 'role' | 'text' | 'attachments'>, parse: MdParse): string {
  const text = message.role === 'user' ? message.text.trim() : plainTextOfMarkdown(message.text, parse);
  const transcripts = (message.attachments ?? []).map((a) => a.transcript?.trim() ?? '').filter(Boolean);
  return [text, ...transcripts].filter(Boolean).join('\n\n');
}

/** The first web address in a text, without the punctuation that closes the sentence around it. */
export function firstLink(text: string): string | null {
  const match = /\bhttps?:\/\/[^\s<>"'`]+/i.exec(text);
  if (!match) return null;
  let url = match[0].replace(/[.,;:!?]+$/, '');
  // A `)` belongs to the address only when the address opened one (`…/Foo_(bar)`); else it closes the
  // parenthesis the link sat in, as `plainTextOfMarkdown` writes it.
  while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
  return url;
}
