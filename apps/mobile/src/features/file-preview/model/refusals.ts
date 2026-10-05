/** Why a file has no preview, as the screen says it (the web's `REFUSAL_TEXT`, spec 2026-10-04 D8). */
const REFUSAL_TEXT: Record<string, string> = {
  missing: 'Arquivo não encontrado nesta máquina.',
  outside: 'Este arquivo está fora das pastas que o agente pode ler (o projeto, a sua pasta pessoal e /tmp).',
  hidden: 'Arquivos em pastas ocultas (como ~/.ssh ou .git) não são abertos.',
  type: 'Só arquivos .md, .markdown e .txt podem ser abertos aqui.',
  not_file: 'Este caminho não é um arquivo.',
  too_large: 'O arquivo passa de 512 KB, o limite da prévia.',
  binary: 'O arquivo não é texto (UTF-8).',
  eperm: 'O agente não tem permissão para ler este arquivo.',
};

/** A reason a newer server adds reads as the generic line. */
export const refusalText = (status: string): string => REFUSAL_TEXT[status] ?? 'Não foi possível abrir este arquivo.';

/** The folder of the path as asked, so relative links inside the file resolve from there. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Where a link inside a previewed file goes: another preview (a relative Markdown path), the browser
 *  (http/https), or nowhere. Same rules as the web's `fileLinkTarget`. */
export function fileLinkTarget(href: string, dir: string): { kind: 'file'; path: string } | { kind: 'web'; url: string } | null {
  if (/^https?:\/\//i.test(href)) return { kind: 'web', url: href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return null;
  const clean = href.split(/[?#]/)[0] ?? '';
  if (!/\.(?:md|markdown|txt)$/i.test(clean)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return null;
  }
  if (decoded.startsWith('/') || decoded.startsWith('~/')) return { kind: 'file', path: decoded };
  const out: string[] = [];
  for (const p of (dir ? dir.split('/') : []).concat(decoded.split('/'))) {
    if (p === '' && out.length > 0) continue;
    if (p === '.') continue;
    const last = out[out.length - 1];
    if (p === '..' && out.length > 0 && last !== '..' && last !== '' && last !== '~') out.pop();
    else out.push(p);
  }
  return { kind: 'file', path: out.join('/') };
}
