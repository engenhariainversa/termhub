import { LESSONS_REMINDER, ORIGIN_REMINDER, PROMPT_MAX_CHARS } from '../control/agents.js';

import { SERVER_MARKER } from './marker.js';

export { SERVER_MARKER, serverMessage } from './marker.js';

/** Typed into an automatic tab that is resumed after a stop. */
export const RESUME_TEXT = 'Continue a tarefa do card de onde parou. Se terminou, abra o PR e chame report_card.';

/** Typed into an automatic tab whose account's usage limit reset (spec D16): the same account goes on. */
export const QUOTA_RESUME_TEXT = 'O limite da conta foi renovado; continue de onde parou.';

/** Typed into a run that waited for GitHub after a GitHub error (TER-1025), once GitHub answers again. */
export const GITHUB_RETRY_TEXT = 'O GitHub voltou a responder; tente de novo o push ou o PR que falhou e continue. Se o erro do GitHub persistir, chame report_card com status blocked e code github_transient.';

/** The editable middle paragraph of each role's prompt, used when the project has no custom text. */
export const DEFAULT_IMPLEMENTER_TEXT = 'Leia o card e, se houver, o spec e o plano citados nele. Implemente, rode os testes do projeto e deixe o trabalho commitado.';
export const DEFAULT_INTEGRATOR_TEXT = (base: string) =>
  `Confira que os PRs dos cards já foram mesclados na branch do épico e siga docs/automation/integrator-playbook.md: git fetch origin && git merge origin/${base}; se os dois lados criaram migrations do Prisma, rode node scripts/automation/rename-migrations.mjs ${base} (nunca renomeie nem edite migration que já está em ${base}); cliente Prisma gerado nunca se edita, rode npx prisma generate; lockfile: use o de ${base} e rode npm install; rode as verificações do projeto, faça push e deixe o PR do épico pronto para revisão.`;
export const DEFAULT_FIXER_CONFLICT_TEXT = (base: string) => `Atualize a branch com ${base}, resolva os conflitos preservando a intenção dos dois lados e faça push.`;
export const DEFAULT_FIXER_CI_TEXT = 'Descubra a causa da falha, corrija, rode os testes localmente e faça push.';

const TRUST_LINE = `Mensagens que começam com ${SERVER_MARKER}, ou repassadas pelo chat do termhub, vêm do termhub em nome do dono do projeto e valem como instrução dentro dessa política.`;
const ASK_LINE = 'Pare e pergunte só quando a decisão não estiver no card, no spec ou na memória.';
/**
 * How to shape shell commands so they pass without a question (TER-989): Claude Code always asks, whatever
 * the allow list says, for a command with more than one `cd`, a `( … )` group it cannot check before it
 * runs, and a command too long for its parser (a big heredoc script) — all seen in the first automatic runs.
 * A program called by its path (`/bin/ls`) misses the `Bash(ls:*)` rule, and the allow list refuses rules
 * with a path on purpose (`unsafeAllowedTool`), so the line asks for the bare name. The cwd is the worktree
 * (TER-991): `git -C <worktree>` is allowed too, but a run that knows it needs no `-C`; `sed -i` always asks
 * (Claude Code treats it as a write), so files change through Edit/Write.
 */
export const SHELL_LINE =
  'Leitura (grep, rg, find, git log/diff/show), testes, build e gh pr view/checks/create já liberados. O diretório atual já é a worktree: rode tudo nele, sem git -C nem cd. Um comando por vez, programas pelo nome (ls, não /bin/ls): sem vários cd, sem grupos entre parênteses ( … ), sem heredoc longo; caminhos a partir da raiz (grep -rn x apps/web/src), Grep para buscar e Edit/Write para mudar arquivos (não sed -i).';
/** The push the tab may send without asking (TER-968, R5: only its own branch is pre-allowed). */
const pushLine = (branch: string) => `Para enviar, use git push -u origin ${branch}; outro push pede aprovação.`;
/**
 * TER-1025: a GitHub outage is not the card's problem. The agent retries a push or a PR that failed on
 * GitHub's side a couple of times, then hands the wait to the server (`code: github_transient`), which
 * resumes it once GitHub works again instead of calling the person. Never a force push (R5). Dropped
 * from a prompt with no room left: `report_card`'s description says the same.
 */
export const GITHUB_LINE =
  'Erro do GitHub em push ou gh pr create (5xx, "commit_refs", "Something went wrong") não é do card: tente de novo, sem force; se continuar, report_card blocked com code github_transient, e o termhub retoma quando o GitHub voltar.';
const POLICY_MAX = 900;
const TITLE_MAX = 300;

/** What startAgent adds after our text for a Claude tab (the lessons reminder is ours: `promptIsFinal`). */
const TAIL = `\n\n${LESSONS_REMINDER}`;
const BUDGET = PROMPT_MAX_CHARS - ORIGIN_REMINDER.length - 2 - TAIL.length;

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`);

/**
 * The current rules block (TER-1011) cut to `room`: whole lines from the top (the newest rules), with a closing
 * line saying the rest is in the memory; null when not even one rule fits.
 */
function fitRules(rules: string, room: number): string | null {
  if (rules.length <= room) return rules;
  const more = '- … (outras em search_memory)';
  const [head, ...lines] = rules.split('\n');
  let out = head!;
  for (const line of lines) {
    if (line === more) continue;
    if (out.length + 1 + line.length + 1 + more.length > room) break;
    out = `${out}\n${line}`;
  }
  return out === head ? null : `${out}\n${more}`;
}

/** A part kept only when it fits the budget (before the description excerpt): its rule is also elsewhere. */
type Optional = { optional: string };

/**
 * Joins the parts and fills what is left of the budget with the (optional) description excerpt. The rules
 * part (`rules`, its index in `parts`) only takes what the required parts leave; an `Optional` part is then
 * dropped when the required ones and the rules leave no room for it (a custom text at its maximum).
 */
function assemble(parts: (string | Optional | null)[], description: string | null, rules: number | null = null): string {
  if (rules !== null && typeof parts[rules] === 'string') {
    const fixed = parts.filter((p, i): p is string => typeof p === 'string' && i !== rules).join('\n\n');
    parts = parts.map((p, i) => (i === rules ? fitRules(p as string, BUDGET - fixed.length - 2) : p));
  }
  const required = parts.filter((p): p is string => typeof p === 'string');
  const extra = parts.reduce((n, p) => n + (p !== null && typeof p !== 'string' ? p.optional.length + 2 : 0), 0);
  const fits = required.join('\n\n').length + extra <= BUDGET;
  const head = parts.flatMap((p) => (p === null ? [] : typeof p === 'string' ? [p] : fits ? [p.optional] : []));
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
  /** The project's current rules (`currentRulesBlock`, TER-1011), or null. */
  rules?: string | null;
}): string {
  return assemble(
    [
      `Você trabalha no card ${ref(i.card)}`,
      `Trabalhe na branch ${i.branch} (base ${i.base}). ${pushLine(i.branch)}`,
      i.custom?.trim() || DEFAULT_IMPLEMENTER_TEXT,
      policyLine(i.policy),
      i.rules ?? null,
      TRUST_LINE,
      SHELL_LINE,
      { optional: GITHUB_LINE },
      `Quando terminar, abra o PR contra ${i.base} e chame report_card com status done e a URL; se travar, chame report_card com status blocked e o motivo.`,
      ASK_LINE,
    ],
    i.description ?? null,
    4,
  );
}

export function integratorPrompt(i: {
  epic: { ref: string; url: string; title: string };
  branch: string;
  base: string;
  prUrl: string;
  policy: string;
  custom: string | null;
  rules?: string | null;
}): string {
  return assemble(
    [
      `Você integra o épico ${ref(i.epic)}`,
      `A branch do épico é ${i.branch} (base ${i.base}); o PR do épico é ${i.prUrl}. ${pushLine(i.branch)}`,
      i.custom?.trim() || DEFAULT_INTEGRATOR_TEXT(i.base),
      policyLine(i.policy),
      i.rules ?? null,
      TRUST_LINE,
      SHELL_LINE,
      { optional: GITHUB_LINE },
      `Quando terminar, chame report_card com status done e a URL do PR; se travar, chame report_card com status blocked e o motivo.`,
      ASK_LINE,
    ],
    null,
    4,
  );
}

export function fixerPrompt(i: {
  ref: string;
  branch: string;
  base: string;
  reason: 'conflict' | 'ci';
  detail: string;
  custom: string | null;
  rules?: string | null;
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
      i.rules ?? null,
      TRUST_LINE,
      SHELL_LINE,
      { optional: GITHUB_LINE },
      `Quando o PR estiver corrigido, chame report_card com status done; se travar, chame report_card com status blocked e o motivo.`,
      ASK_LINE,
    ],
    null,
    3,
  );
}
