import { cleanMemoryText } from '../memory/text.js';

/**
 * The line that hands the concierge the ref of a message the person typed (TER-1037), so it can pass
 * it to `send_input`'s `on_behalf_of` without searching for it: before this, a relayed order reached
 * the tab marked as the assistant's own words and the tab refused it. Only a typed message gets one
 * (`start`): a wake or a decision's re-injection is the server's text, not the person's. The ref names
 * the chat message; `verifyOnBehalfOf` resolves it through the memory item `indexMessage` writes, so a
 * message that indexes nothing (files alone) gets no line. English, like every text the model reads.
 */
export function messageRefLine(messageId: string, text: string): string | null {
  if (cleanMemoryText(text).length === 0) return null;
  const ref = `message:${messageId}`;
  return `[termhub] The person typed the message below; its ref is ${ref}. To relay what it asks to a tab, pass on_behalf_of: ["${ref}"] to send_input, or the tab reads the text as your own words; when a subagent will send it, put the ref in its prompt and tell it to pass it.`;
}

/** `runText` with the typed message's ref line first, or as it is when there is none. */
export function withMessageRef(runText: string, messageId: string, text: string, typed: boolean | undefined): string {
  const line = typed ? messageRefLine(messageId, text) : null;
  return line ? `${line}\n\n${runText}` : runText;
}
