// Downloading a chat code block as a file (TER-1084): the name and extension the file gets, and the
// download itself. The mobile app has the same naming rules in
// `apps/mobile/src/features/chat/model/code-file.ts`; keep the two in step.

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

/** The file extension for a fence's language (as `codeLanguage` read it), without the dot. */
export function codeFileExtension(language: string | null): string {
  return (language && EXTENSIONS[language.toLowerCase()]) || 'txt';
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
  // Cut at the last word boundary that fits, so the name does not end mid-word.
  const cut = slug.slice(0, SLUG_MAX + 1);
  const dash = cut.lastIndexOf('-');
  return (dash > 0 ? cut.slice(0, dash) : slug.slice(0, SLUG_MAX)).replace(/-+$/, '');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-10-14-1630`, in the reader's local time: when the file was saved, as part of its name. */
function stamp(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * The name a downloaded block gets: a slug of its first non-empty line (a shell prompt's `$` or a
 * comment's `#`/`//` falls out with the other punctuation), the date and time, and the language's
 * extension — `prompt-integracao-keycloak-2026-10-14-1630.txt`. A block with nothing sluggable is `codigo-…`.
 */
export function codeFileName(content: string, language: string | null, now: Date = new Date()): string {
  const firstLine = content.split('\n').find((line) => line.trim() !== '') ?? '';
  const slug = slugify(firstLine) || 'codigo';
  return `${slug}-${stamp(now)}.${codeFileExtension(language)}`;
}

/**
 * Saves `content` as `name` through an `<a download>` on a Blob URL: UTF-8, line breaks and emojis as
 * they are. Chrome, Firefox and Safari (desktop and iOS) all honour `download` on a same-origin Blob
 * URL. Returns whether the download was started; never throws.
 */
export function downloadText(name: string, content: string): boolean {
  try {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoked a moment later, not right away: Safari reads the URL after the click handler returns.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}
