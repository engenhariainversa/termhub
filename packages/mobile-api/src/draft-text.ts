// A message the concierge wrote for the person to send to someone else (TER-1159): it comes in a
// ```draft fence, the chat shows it as a "Mensagem pronta" card, and its "Copiar" puts two versions on
// the clipboard — HTML, which Teams and Slack apply when pasted, and this plain text, in the Markdown
// Slack understands when typed (*bold*, _italic_, ~strike~, "•" bullets), for wherever HTML is not
// taken. Kept free of zod on purpose: the web imports this module alone
// (`@termhub/mobile-api/draft-text`), like `pasted-text`.

/** The fence's info string that marks a draft: ` ```draft `. */
export const DRAFT_FENCE = 'draft';

/** Whether a fence's info string (` ```draft `, ` ```Draft slack `) marks a draft. */
export function isDraftFence(info: string | null | undefined): boolean {
  return (info ?? '').trim().split(/\s+/)[0]?.toLowerCase() === DRAFT_FENCE;
}

const BOLD = '\u0001';

/** One line's inline Markdown, outside code spans, in Slack's typed form. */
function inline(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return (
        part
          // A link reads as its text and its address; Slack's `<url|text>` only works through its API.
          .replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) => (!label || label === url ? url : `${label} (${url})`))
          .replace(/\*\*(?=\S)(.+?)\*\*/g, `${BOLD}$1${BOLD}`)
          .replace(/__(?=\S)(.+?)__/g, `${BOLD}$1${BOLD}`)
          .replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?![*\w])/g, '$1_$2_')
          .replace(/~~(?=\S)(.+?)~~/g, '~$1~')
          .split(BOLD)
          .join('*')
      );
    })
    .join('');
}

/**
 * A draft's Markdown as plain text Slack formats when it is pasted into its box: headings become a bold
 * line, `-`/`*`/`+` bullets become "•" (nesting kept), numbered lists and code stay as they are, and a
 * link becomes "text (url)". Mentions (`@Fulano`) are left as text. Lines inside a code fence are kept
 * verbatim.
 */
export function draftPlainText(markdown: string): string {
  let fenced = false;
  return markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) return heading[1] ? `*${inline(heading[1]).replace(/^\*(.*)\*$/, '$1')}*` : '';
      // A rule (`---`, `* * *`) has no plain form: a blank line keeps the paragraphs apart.
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return '';
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      if (bullet) return `${bullet[1]}• ${inline(bullet[2])}`;
      return inline(line);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
