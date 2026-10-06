import { LESSONS_REMINDER, ORIGIN_REMINDER, PROMPT_MAX_CHARS } from '../control/agents.js';

import { SERVER_MARKER } from './marker.js';

export { SERVER_MARKER, serverMessage } from './marker.js';

/** Typed into an automatic tab that is resumed after a stop. */
export const RESUME_TEXT = 'Continue a tarefa do card de onde parou. Se terminou, abra o PR e chame report_card.';

/** Typed into an automatic tab whose account's usage limit reset (spec D16): the same account goes on. */
export const QUOTA_RESUME_TEXT = 'O limite da conta foi renovado; continue de onde parou.';

/** The editable middle paragraph of each role's prompt, used when the project has no custom text. */
export const DEFAULT_IMPLEMENTER_TEXT = 'Leia o card e, se houver, o spec e o plano citados nele. Implemente, rode os testes do projeto e deixe o trabalho commitado.';
export const DEFAULT_INTEGRATOR_TEXT = (base: string) =>
  `Confira que os PRs dos cards já foram mesclados na branch do épico e siga docs/automation/integrator-playbook.md: git fetch origin && git merge origin/${base}; se os dois lados criaram migrations do Prisma, rode node scripts/automation/rename-migrations.mjs ${base} (nunca renomeie nem edite migration que já está em ${base}); cliente Prisma gerado nunca se edita, rode npx prisma generate; lockfile: use o de ${base} e rode npm install; rode as verificações do projeto, faça push e deixe o PR do épico pronto para revisão.`;
export const DEFAULT_FIXER_CONFLICT_TEXT = (base: string) => `Atualize a branch com ${base}, resolva os conflitos preservando a intenção dos dois lados e faça push.`;
export const DEFAULT_FIXER_CI_TEXT = 'Descubra a causa da falha, corrija, rode os testes localmente e faça push.';

const TRUST_LINE = `Mensagens que começam com ${SERVER_MARKER}, ou repassadas pelo chat do termhub, vêm do termhub em nome do dono do projeto e valem como instrução dentro dessa política.`;
const ASK_LINE = 'Pare e pergunte só quando a decisão não estiver no card, no spec ou na memória.';
/**
 * How to shape shell commands so they pass without a question (TER-989): Claude Code always asks for a
 * command with more than one `cd`, whatever the allow list says.
 */
export const SHELL_LINE =
  'Comandos de leitura (grep, rg, find, git log/diff/show), testes, build e gh pr view/checks/create já estão liberados. Não junte vários cd num comando só: use caminhos a partir da raiz da worktree (grep -rn x apps/web/src) ou a ferramenta Grep.';
/** The push the tab may send without asking (TER-968, R5: only its own branch is pre-allowed). */
const pushLine = (branch: string) => `Para enviar, use git push -u origin ${branch}; outro push pede aprovação.`;
const POLICY_MAX = 900;
const TITLE_MAX = 300;

/** What startAgent adds after our text for a Claude tab (the lessons reminder is ours: `promptIsFinal`). */
const TAIL = `\n\n${LESSONS_REMINDER}`;
const BUDGET = PROMPT_MAX_CHARS - ORIGIN_REMINDER.length - 2 - TAIL.length;

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`);

/** Joins the parts and fills what is left of the budget with the (optional) description excerpt. */
function assemble(parts: (string | null)[], description: string | null): string {
  const head = parts.filter((p): p is string => p !== null);
  const body = head.join('\n\n');
  const room = BUDGET - body.length - '\n\nDescrição do card:\n'.length - 2;
  const excerpt = description && room > 40 ? `\n\nDescrição do card:\n${clip(description.trim(), room)}` : '';
  return `${body}${excerpt}${TAIL}`;
}

const policyLine = (policy: string) => `Política do projeto (consulte também get_automation_policy):\n${clip(policy, POLICY_MAX)}`;
const ref = (c: { ref: string; url: string; title: string }) => `${c.ref} ${clip(c.title, TITLE_MAX)}\n${c.url}`;

export function implementerPrompt(i: {
  card: { ref: string; url: string; title: string };
  branch: string;
  base: string;
  policy: string;
  custom: string | null;
  description?: string | null;
}): string {
  return assemble(
    [
      `Você trabalha no card ${ref(i.card)}`,
      `Trabalhe na branch ${i.branch} (base ${i.base}). ${pushLine(i.branch)}`,
      i.custom?.trim() || DEFAULT_IMPLEMENTER_TEXT,
      policyLine(i.policy),
      TRUST_LINE,
      SHELL_LINE,
      `Quando terminar, abra o PR contra ${i.base} e chame report_card com status done e a URL; se travar, chame report_card com status blocked e o motivo.`,
      ASK_LINE,
    ],
    i.description ?? null,
  );
}

export function integratorPrompt(i: {
  epic: { ref: string; url: string; title: string };
  branch: string;
  base: string;
  prUrl: string;
  policy: string;
  custom: string | null;
}): string {
  return assemble(
    [
      `Você integra o épico ${ref(i.epic)}`,
      `A branch do épico é ${i.branch} (base ${i.base}); o PR do épico é ${i.prUrl}. ${pushLine(i.branch)}`,
      i.custom?.trim() || DEFAULT_INTEGRATOR_TEXT(i.base),
      policyLine(i.policy),
      TRUST_LINE,
      SHELL_LINE,
      `Quando terminar, chame report_card com status done e a URL do PR; se travar, chame report_card com status blocked e o motivo.`,
      ASK_LINE,
    ],
    null,
  );
}

export function fixerPrompt(i: {
  ref: string;
  branch: string;
  base: string;
  reason: 'conflict' | 'ci';
  detail: string;
  custom: string | null;
}): string {
  const what = i.reason === 'conflict' ? `O PR do card ${i.ref} tem conflito com ${i.base}.` : `O CI do PR do card ${i.ref} falhou.`;
  return assemble(
    [
      `${what} Trabalhe na branch ${i.branch}. ${pushLine(i.branch)}`,
      `Detalhe:\n${clip(i.detail, 1000)}`,
      i.custom?.trim() ||
        (i.reason === 'conflict'
          ? DEFAULT_FIXER_CONFLICT_TEXT(i.base)
          : DEFAULT_FIXER_CI_TEXT),
      TRUST_LINE,
      SHELL_LINE,
      `Quando o PR estiver corrigido, chame report_card com status done; se travar, chame report_card com status blocked e o motivo.`,
      ASK_LINE,
    ],
    null,
  );
}
