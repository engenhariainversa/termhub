// The name a chat code block gets when it is saved as a file (TER-1084). The web has the same rules in
// `apps/web/src/lib/code-download.ts`; keep the two in step.

/** The extension per fence language; anything not listed (and no language at all) is a `.txt`. */
const EXTENSIONS: Record<string, string> = {
  text: 'txt',
  txt: 'txt',
  plain: 'txt',
  plaintext: 'txt',
  markdown: 'md',
  md: 'md',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  json: 'json',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  ts: 'ts',
  typescript: 'ts',
  js: 'js',
  javascript: 'js',
  py: 'py',
  python: 'py',
};

/** The language of a fence's info string (` ```bash title=x ` → `bash`), or null. */
export function fenceLanguage(info: string | null | undefined): string | null {
  const token = (info ?? '').trim().split(/\s+/)[0] ?? '';
  return /^[a-z0-9+#-]{1,20}$/i.test(token) ? token : null;
}

/** The file extension for a fence's language, without the dot. */
export function codeFileExtension(language: string | null): string {
  return (language && EXTENSIONS[language.toLowerCase()]) || 'txt';
}

/**
 * The MIME type Android's folder picker is told when it creates the file. Only types whose extension
 * the system already gives are named: for anything else Android would append its own (`x.sh` saved as
 * `text/plain` becomes `x.sh.txt`), and `application/octet-stream` keeps the name as it is.
 */
export function codeFileMime(ext: string): string {
  if (ext === 'txt') return 'text/plain';
  if (ext === 'json') return 'application/json';
  return 'application/octet-stream';
}

const SLUG_MAX = 40;

/** A short, filesystem-safe slug of `text`: no accents, lowercase, `[a-z0-9-]` only. Empty when nothing is left. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= SLUG_MAX) return slug;
  const cut = slug.slice(0, SLUG_MAX + 1);
  const dash = cut.lastIndexOf('-');
  return (dash > 0 ? cut.slice(0, dash) : slug.slice(0, SLUG_MAX)).replace(/-+$/, '');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-10-14-1630`, in the phone's local time. */
function stamp(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** `prompt-integracao-keycloak-2026-10-14-1630.txt`: a slug of the first non-empty line, the time, the extension. */
export function codeFileName(content: string, language: string | null, now: Date = new Date()): string {
  const firstLine = content.split('\n').find((line) => line.trim() !== '') ?? '';
  const slug = slugify(firstLine) || 'codigo';
  return `${slug}-${stamp(now)}.${codeFileExtension(language)}`;
}
