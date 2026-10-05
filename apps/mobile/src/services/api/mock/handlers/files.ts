// The mock's file previews (spec 2026-10-04 file preview): a few fixed files, a machine with an old agent
// and the refusals, so the screen can be walked through without a server. And the project's recent
// Markdown files (spec 2026-10-04 recent Markdown files): every group, two machines and one left out.
import { filePreviewQuery, fileRecentQuery, type TFileRecentResponse } from '../../contract';
import type { MockRouter } from '../router';
import { type MockState, verifyAuth, WireError } from '../state';

const MD = `# Relatório de 10 dias

Resumo do que os agentes fizeram.

| Projeto | PRs |
|---|---|
| termhub | 12 |

- Spec: [file preview](docs/superpowers/specs/2026-10-04-file-preview-design.md)
- Site: https://termhub.dev

![gráfico](https://exemplo.com/grafico.png)

\`\`\`bash
npm test
\`\`\`
`;

const FILES: Record<string, { content: string; rel: string | null }> = {
  '~/relatorio-termhub-10-dias.md': { content: MD, rel: null },
  'docs/superpowers/specs/2026-10-04-file-preview-design.md': { content: '# File preview\n\nO desenho.', rel: 'docs/superpowers/specs/2026-10-04-file-preview-design.md' },
  'notas.txt': { content: '# não é título\nlinha 2', rel: 'notas.txt' },
};
const REFUSED: Record<string, string> = { '~/.ssh/notas.md': 'hidden', '/etc/x.md': 'outside', '~/grande.md': 'too_large' };

const JARVIS = { id: 'm-jarvis', name: 'jarvis' };
const MAC = { id: 'm-mac', name: 'mac-mini' };
const HOUR = 3_600_000;

/** The `termhub` project's recent files, newest first; `ago` in hours before the request. */
const RECENT: { machine: { id: string; name: string }; rel: string | null; path: string; size: number; ago: number; group: string; cited?: boolean; tooLarge?: boolean }[] = [
  { machine: JARVIS, rel: null, path: '/home/pedro/relatorio-termhub-10-dias.md', size: MD.length, ago: 0.2, group: 'other', cited: true },
  { machine: JARVIS, rel: 'docs/superpowers/specs/2026-10-04-file-preview-design.md', path: '/home/pedro/termhub/docs/superpowers/specs/2026-10-04-file-preview-design.md', size: 12_400, ago: 3, group: 'specs', cited: true },
  { machine: JARVIS, rel: 'docs/superpowers/plans/2026-10-04-file-preview.md', path: '/home/pedro/termhub/docs/superpowers/plans/2026-10-04-file-preview.md', size: 31_200, ago: 5, group: 'plans' },
  { machine: MAC, rel: 'docs/lessons/2026-10-02-fifo-read-hangs.md', path: '/Users/pedro/termhub/docs/lessons/2026-10-02-fifo-read-hangs.md', size: 2_100, ago: 30, group: 'lessons' },
  { machine: JARVIS, rel: 'docs/legal/privacy.md', path: '/home/pedro/termhub/docs/legal/privacy.md', size: 8_900, ago: 80, group: 'legal' },
  { machine: MAC, rel: 'docs/superpowers/specs/2026-09-01-big-export.md', path: '/Users/pedro/termhub/docs/superpowers/specs/2026-09-01-big-export.md', size: 900_000, ago: 200, group: 'specs', tooLarge: true },
];

export function registerFileRoutes(router: MockRouter, state: MockState): void {
  router.route('GET', '/api/m/v1/file-recent', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const q = fileRecentQuery.parse(ctx.query);
    if (!state.projects.has(q.project_id)) throw new WireError(404, 'NOT_FOUND', 'Projeto não encontrado');
    const body: TFileRecentResponse =
      q.project_id === 'p-termhub'
        ? {
            items: RECENT.map((f) => ({
              machine: f.machine,
              path: f.path,
              rel_path: f.rel,
              name: f.path.split('/').pop() ?? f.path,
              size: f.size,
              mtime: new Date(ctx.now() - f.ago * HOUR).toISOString(),
              too_large: f.tooLarge ?? false,
              group: f.group as TFileRecentResponse['items'][number]['group'],
              cited: f.cited ?? false,
            })),
            skipped: [{ machine: { id: 'm-antigo', name: 'notebook-antigo' }, reason: 'outdated' }],
          }
        : { items: [], skipped: [] };
    return { status: 200, body };
  });

  router.route('GET', '/api/m/v1/file-preview', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const q = filePreviewQuery.parse(ctx.query);
    if (q.path.startsWith('~/antigo/')) throw new WireError(409, 'AGENT_OUTDATED', 'Atualize o agente desta máquina (npm i -g @termhub/agent, versão 0.16.0 ou mais nova) para ver arquivos');
    const machine = { id: 'm-jarvis', name: 'jarvis' };
    // Arquivos opens the cited report by its absolute path.
    const key = q.path.replace(/^\/home\/pedro\//, '~/');
    const refused = REFUSED[key];
    if (refused) return { status: 200, body: { status: refused, machine, ...(refused === 'too_large' ? { size: 900_000 } : {}) } };
    const file = FILES[key];
    if (!file) return { status: 200, body: { status: 'missing', machine } };
    const name = q.path.split('/').pop() ?? q.path;
    return {
      status: 200,
      body: {
        status: 'ok',
        machine,
        project_id: q.project_id ?? null,
        path: q.path.replace(/^~/, '/home/pedro'),
        rel_path: file.rel,
        name,
        size: file.content.length,
        mtime: new Date(ctx.now()).toISOString(),
        content: file.content,
        github_url: file.rel ? `https://github.com/engenhariainversa/termhub/blob/main/${file.rel}` : null,
      },
    };
  });
}
