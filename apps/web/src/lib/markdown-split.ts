/**
 * Splits a streaming Markdown body into the part that will not change any more and the part still
 * being written. Everything before the cut has ended a block, so parsing it once and keeping the HTML
 * is safe; only the tail is re-parsed on each delta. `settled + tail === body` always.
 *
 * The cut is a blank line outside a code fence — but only one that really ends a block. A blank line
 * inside a container that spans it is not a boundary: `1. a\n\n2. b` is one loose list, and
 * `- a\n\n  cont` is one item with a second paragraph. Cutting there would render two tight lists
 * while streaming and one loose list once the text is stored — a reflow on the final swap, the one
 * thing the split must never cause. So a blank line counts only when the next non-blank line neither
 * starts with whitespace (a continuation or an indented code block) nor with a list marker, and when
 * that next line has arrived at all: a body that ends in a blank line has not shown what follows it.
 *
 * A fence opens on a line whose first non-space characters (at most three spaces) are three or more
 * backticks or tildes, and closes only on a same-character marker at least as long — so a ``` inside a
 * ```` or ~~~ fence is code, not a closer. A blank line inside an open fence is code, never a cut.
 */
export function splitSettled(body: string): { settled: string; tail: string } {
  if (!body) return { settled: '', tail: '' };
  const lines = body.split('\n');
  const last = lines.length - 1;
  let fence: { char: string; len: number } | null = null;
  // The blank line waiting for the line after it to say whether it ended a block.
  let candidate = -1;
  let lastBlank = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      continue;
    }
    if (line.trim() === '') {
      // The final line never counts as blank: with no newline after it, it is still being written.
      if (i < last) candidate = i;
      continue;
    }
    if (candidate !== -1 && startsBlock(line, i === last)) lastBlank = candidate;
    candidate = -1;
    const open = FENCE_OPEN.exec(line);
    if (open) fence = { char: open[1][0], len: open[1].length };
  }
  if (lastBlank === -1) return { settled: '', tail: body };
  const settled = `${lines.slice(0, lastBlank + 1).join('\n')}\n`;
  return { settled, tail: body.slice(settled.length) };
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/;
/** A line that may still grow into a list marker (`2` on its way to `2. b`). */
const LIST_MARKER_PREFIX = /^ {0,3}(?:[-*+]|\d{1,9}[.)]?)?$/;

/**
 * Whether the non-blank line after a blank one starts a new block — which is what makes that blank
 * line the end of the previous one. A line still being written (`partial`) is trusted only when
 * nothing it could still grow into would make it a list marker: a settled prefix must not be taken
 * back on the next delta.
 */
function startsBlock(line: string, partial: boolean): boolean {
  if (/^\s/.test(line) || LIST_MARKER.test(line)) return false;
  return !(partial && LIST_MARKER_PREFIX.test(line));
}
