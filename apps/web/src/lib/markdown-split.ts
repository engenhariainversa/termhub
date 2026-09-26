/**
 * Splits a streaming Markdown body into the part that will not change any more and the part still
 * being written: the cut is the last blank line outside a code fence. Everything before it has ended a
 * block, so parsing it once and keeping the HTML is safe; only the tail is re-parsed on each delta.
 * `settled + tail === body` always.
 *
 * A fence is a line whose first non-space characters (at most three spaces) are ``` or ~~~; the
 * marker toggles, and a blank line inside an open fence is part of the code, never a cut.
 */
export function splitSettled(body: string): { settled: string; tail: string } {
  if (!body) return { settled: '', tail: '' };
  const lines = body.split('\n');
  let inFence = false;
  let lastBlank = -1;
  // The final line never counts: with no newline after it, it is still being written.
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i];
    if (/^ {0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.trim() === '') lastBlank = i;
  }
  if (lastBlank === -1) return { settled: '', tail: body };
  const settled = `${lines.slice(0, lastBlank + 1).join('\n')}\n`;
  return { settled, tail: body.slice(settled.length) };
}
