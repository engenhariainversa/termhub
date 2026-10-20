import type { ReplyRef } from '@/features/chat/model/reply';

/**
 * What a reply typed in a session sends (TER-1090). A terminal tab has no message ids to point at, so the
 * quote rides in the text itself, as a Markdown quote line above what was written — the way Claude Code
 * reads a quoted message anywhere else.
 */
export function quotedText(reply: ReplyRef | null, text: string): string {
  if (!reply || !reply.excerpt) return text;
  return text ? `> ${reply.excerpt}\n\n${text}` : `> ${reply.excerpt}`;
}
