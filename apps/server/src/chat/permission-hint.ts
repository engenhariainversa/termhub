/**
 * Permission hints (TER-614): what a Claude Code permission card approves, as a short excerpt of the
 * tool's input — the start of a command, or the file a tool writes. Only for machines that opted in
 * (`machines.permission_hint`; the hook script sends the prompt whole only there), and only what this
 * module keeps is stored, shown or compared: the rest of the payload is dropped on arrival.
 *
 * The excerpt can hold a secret (`export TOKEN=…`, a `curl -H 'Authorization: …'`), so it is filtered
 * before anything else sees it: known token shapes and the values of credential-looking names, flags,
 * headers and URL passwords become `REDACTED`. The filter is best effort — any text can be a secret —
 * which is why the whole feature is opt-in. Rules that came out of the design review (2026-09-30):
 * only the first non-blank line of a command is read (a heredoc's body never travels further), accents
 * are kept (the text is NFC-normalised, never reduced to ASCII), and a file is named relative to the
 * session's directory, as Claude Code's dialog names it, with the live check reading its last segment
 * only (an absolute path on the card would never match the relative one on screen).
 */
import { CONTROL_CHARS_RE, FORMAT_CHARS_RE, globalOf } from './tab-question-payload.js';

/** How much of the command or path a card shows, in code points. */
export const HINT_MAX = 60;
/** What a secret is replaced with. Never a letter or a digit: the live check splits the hint on it. */
export const REDACTED = '•••';
/** Marks a cut: the hint goes on past what is shown (a longer line, more lines, a path's head). */
export const ELLIPSIS = '…';

/** The tools whose input is a file to write, and the key of that file in their input. */
const FILE_TOOLS: Readonly<Record<string, string>> = { Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' };

const CONTROL_G = globalOf(CONTROL_CHARS_RE);
const FORMAT_G = globalOf(FORMAT_CHARS_RE);

/** NFC, with no format characters (bidi, zero-width) and every control character or run of blanks as one space. */
const clean = (text: string): string => text.normalize('NFC').replace(FORMAT_G, '').replace(CONTROL_G, ' ').replace(/\s+/g, ' ').trim();

/** The first `max` code points of `text` (an emoji or an accented letter is never cut in half). */
const head = (text: string, max: number): string => Array.from(text).slice(0, max).join('');

/**
 * What makes a name a credential's: an env var, a JSON or YAML key, a query parameter. `PWD` alone is the
 * shell's working directory (`"$PWD:/w"`), so only a suffixed one counts (`MYSQL_PWD`).
 */
const SENSITIVE = String.raw`(?:token|secret|pass|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|cookie|signature|[_-]pwd)`;

/** A value as a shell, JSON or query string writes it: quoted (closed or not, on this line), or a bare word. */
const VALUE = String.raw`(?:"[^"]*"?|'[^']*'?|[^\s"',;&|)}]+)`;

/** Rules applied in order; each replaces what it matched, leaving the surrounding text as it was. */
const RULES: readonly ((text: string) => string)[] = [
  // a PEM block's header: whatever follows on the line is key material
  (t) => t.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*/g, REDACTED),
  // https://user:password@host — the user stays, the password goes
  (t) => t.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, `$1:${REDACTED}@`),
  // header values: -H 'Authorization: Bearer …', Cookie: …, X-Api-Key: …
  (t) => t.replace(/\b((?:proxy-)?authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|private-token)(\s*:\s*)[^'"]+/gi, `$1$2${REDACTED}`),
  (t) => t.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`),
  // credentials passed as a flag's argument: curl -u user:pass, sshpass -p x, mysql -px
  (t) => t.replace(/(\s(?:-u|--user)(?:\s+|=))([^\s:'"]+):[^\s'"]+/g, `$1$2:${REDACTED}`),
  (t) => t.replace(/(\bsshpass\s+-p\s*)\S+/g, `$1${REDACTED}`),
  (t) => t.replace(/(\bmysql(?:dump|admin)?\b[^|;&]*?\s-p)(?=\S)[^\s]+/g, `$1${REDACTED}`),
  // --token x, --password=x, --api-key "x", --client-secret x
  (t) =>
    t.replace(new RegExp(String.raw`(--?[A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|passphrase|api-?key|access-?key|private-?key|auth|credential|cookie)[A-Za-z0-9_-]*)(=|\s+)${VALUE}`, 'gi'), `$1$2${REDACTED}`),
  // NAME=value, "name": "value", name: value, ?api_key=value — when the name is a credential's
  // (only a credential's name matches, so a URL's "https:" never swallows the query string after it;
  // "$NAME" is an expansion, not an assignment, and a value already redacted is left as it is)
  (t) => t.replace(new RegExp(String.raw`(^|[^A-Za-z0-9_.$-])(["']?)([A-Za-z0-9_.-]*${SENSITIVE}[A-Za-z0-9_.-]*)\2(\s*[:=]\s*)(?!${REDACTED})${VALUE}`, 'gi'), `$1$2$3$2$4${REDACTED}`),
  // token shapes known anywhere: GitHub, GitLab, Slack, OpenAI/Anthropic-style, Stripe, AWS, Google, npm, termhub, JWT
  (t) =>
    t.replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}|thb_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})/g,
      REDACTED,
    ),
  // anything long and random-looking: 32+ characters of a token alphabet with letters and digits mixed
  (t) => t.replace(/[A-Za-z0-9+_=-]{32,}/g, (word) => ((word.match(/\d/g)?.length ?? 0) >= 4 && (word.match(/[A-Za-z]/g)?.length ?? 0) >= 4 ? REDACTED : word)),
];

/** `text` with every secret the rules recognise replaced by `REDACTED`. */
export function redactSecrets(text: string): string {
  return RULES.reduce((t, rule) => rule(t), text);
}

/**
 * The card's excerpt of a command: its first non-blank line, cleaned, filtered, then cut at `HINT_MAX`.
 * The filter runs on the whole line before the cut, so a secret straddling the cut is still recognised.
 * Ends with `ELLIPSIS` when there was more (a longer line, or more lines: a heredoc, a script).
 */
export function commandHint(command: string): string | null {
  const lines = command.split(/\r\n|\r|\n/);
  const at = lines.findIndex((l) => clean(l) !== '');
  if (at < 0) return null;
  const line = redactSecrets(clean(lines[at]!));
  const more = lines.slice(at + 1).some((l) => clean(l) !== '');
  const cut = head(line, HINT_MAX);
  return cut.length < line.length || more ? `${cut}${ELLIPSIS}` : cut;
}

/**
 * The card's name for a file: relative to the session's directory when it is inside it (Claude Code's
 * dialog names it that way), else as given. A long one keeps its tail, where the file's name is.
 */
export function fileHint(filePath: string, cwd: string | null): string | null {
  const path = clean(filePath);
  if (!path) return null;
  const base = cwd ? clean(cwd).replace(/\/+$/, '') : '';
  const shown = base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
  const points = Array.from(shown);
  return points.length > HINT_MAX ? `${ELLIPSIS}${points.slice(-(HINT_MAX - 1)).join('')}` : shown;
}

/**
 * The hint for a Claude permission prompt sent whole, or null: the tool is not one with a hint, or its
 * input has no command or file. `cwd` is the event's own (the session's directory).
 */
export function permissionHint(tool: string, toolInput: unknown, cwd: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;
  const input = toolInput as Record<string, unknown>;
  if (tool === 'Bash') return typeof input.command === 'string' ? commandHint(input.command) : null;
  const key = FILE_TOOLS[tool];
  if (!key || typeof input[key] !== 'string') return null;
  return fileHint(input[key], typeof cwd === 'string' ? cwd : null);
}

/**
 * What the live check looks for on screen for a hint: for a file, its last path segment (the dialog may
 * name it relative or absolute); for a command, each run of the hint between redactions and cuts, in
 * order (what was redacted or cut is on the screen, not in the hint). Raw text: the caller reduces it.
 */
export function hintMarkers(tool: string, hint: string): string[] {
  if (FILE_TOOLS[tool]) {
    const name = hint.split('/').pop() ?? '';
    return [name.replace(ELLIPSIS, '')];
  }
  return hint.split(new RegExp(`${REDACTED}|${ELLIPSIS}`)).filter((part) => part.trim() !== '');
}
