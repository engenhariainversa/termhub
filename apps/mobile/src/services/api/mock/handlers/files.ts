// The mock's file previews (spec 2026-10-04 file preview): a few fixed files, a machine with an old agent
// and the refusals, so the screen can be walked through without a server.
import { filePreviewQuery } from '../../contract';
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

export function registerFileRoutes(router: MockRouter, state: MockState): void {
  router.route('GET', '/api/m/v1/file-preview', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const q = filePreviewQuery.parse(ctx.query);
    if (q.path.startsWith('~/antigo/')) throw new WireError(409, 'AGENT_OUTDATED', 'Atualize o agente desta máquina (npm i -g @termhub/agent, versão 0.16.0 ou mais nova) para ver arquivos');
    const machine = { id: 'm-jarvis', name: 'jarvis' };
    const refused = REFUSED[q.path];
    if (refused) return { status: 200, body: { status: refused, machine, ...(refused === 'too_large' ? { size: 900_000 } : {}) } };
    const file = FILES[q.path];
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
