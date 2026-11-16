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
/** The exceptions that still stop a run (TER-1043 §2): the guard's fixed locks, production data and scope. */
const EXCEPTIONS = 'credenciais/.env, deploy/merge/publicação manual, lojas/EAS, rm fora da worktree, docker/ssh, dados de produção, escopo maior que o card';
/**
 * TER-1043: automatic work decides by itself ("era pra ir no automático, então as decisões deveriam já ter
 * sido tomadas"). The agent follows the person's precedent (search_memory) or else its own recommendation,
 * records the decision and goes on; only the exceptions stop it. The implementer writes the record in the
 * PR it opens; a fixer or an integrator works on a PR that already exists, so `report_card` carries it.
 * Replaces ASK_LINE unless the project chose to stop on decisions (`stop_on_decisions`).
 */
export const decideLine = (where: 'pr' | 'report') =>
  `Decisões de produto ou técnicas: siga o precedente da pessoa (search_memory) ou a sua recomendação; registre ${where === 'pr' ? 'no PR, seção "Decisões tomadas" (opções, escolha, motivo), e ' : ''}em report_card (decisions). Nunca termine o turno com uma pergunta. Só pare (report_card blocked) em ${EXCEPTIONS}.`;
const lastLine = (stopOnDecisions: boolean | undefined, where: 'pr' | 'report') => (stopOnDecisions ? ASK_LINE : decideLine(where));
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
/**
 * A workspace run's shell line (spec 2026-10-07 multi-repo R13, outline Task 12): the cwd is the workspace
 * root and each repository sits in `<key>/`. git takes `-C <key>` (the allow list has those forms, by exact
 * path); any other command runs after a `cd <key>` sent alone, since the guard refuses a push in a command that
 * also has a `cd` to a relative folder, and Claude Code asks for several `cd` in one command.
 */
export const SHELL_LINE_MULTI =
  'Leitura (grep, rg, find, git log/diff/show), testes, build e gh pr view/checks/create já liberados. O diretório atual é a raiz do workspace, com cada repositório na pasta <key>/: git com git -C <key> …; o resto, cd <key> sozinho numa chamada e o comando na seguinte. Um comando por vez, programas pelo nome (ls, não /bin/ls), sem grupos ( … ) nem heredoc longo; Grep para buscar e Edit/Write para mudar arquivos (não sed -i).';
/** The push the tab may send without asking (TER-968, R5: only its own branch is pre-allowed). */
const pushLine = (branch: string) => `Para enviar, use git push -u origin ${branch}; outro push pede aprovação.`;
/**
 * A workspace run's push (R13): the exact `git -C <root>/<key>` form the guard and the allow list take, or a
 * plain push after a `cd <key>` sent alone (the guard refuses a push in a command that also has a relative
 * `cd`). Without the root (a prompt built before the run has a place), only the second.
 */
const pushLineMulti = (branch: string, workspace: string | null | undefined) => {
  const root = workspace?.replace(/\/+$/, '');
  const how = root ? `use git -C ${root}/<key> push -u origin ${branch}` : `rode cd <key> sozinho numa chamada e, na seguinte, git push -u origin ${branch}`;
  return `Para enviar cada repositório, ${how}; outro push pede aprovação.`;
};

/** A repository of a workspace run, as the prompt names it. */
export interface PromptRepo {
  key: string;
  full_name: string;
  base: string;
}
/** At most this much of the prompt names the repositories (they still take the description's room first). */
export const REPOS_MAX = 500;
/** Only a run in two or more repositories is a workspace run: one repository keeps today's prompt. */
const workspaceOf = (repos: readonly PromptRepo[] | null | undefined): readonly PromptRepo[] | null => (repos && repos.length > 1 ? repos : null);
const REPOS_HEAD = 'Repositórios do card (cada um na pasta <key>/, mesma branch em todos; abra um PR por repositório com mudança, nenhum nos outros)';
/**
 * One line per repository, under `REPOS_MAX`: the folder, owner/repo and the base its PR goes to. When the rest
 * of the prompt leaves no room for it (everything at its maximum), the keys alone (`compact`): `get_card` and
 * `list_project_repos` say the rest.
 */
function reposBlock(repos: readonly PromptRepo[], failing?: string | null): Elastic {
  const lines = repos.map((r) => `- ${r.key}: ${clip(r.full_name, 120)} (base ${clip(r.base, 80)})${failing && r.key === failing ? ' ← o PR com problema' : ''}`);
  return { elastic: clip([`${REPOS_HEAD}:`, ...lines].join('\n'), REPOS_MAX), compact: `${REPOS_HEAD}: ${repos.map((r) => r.key).join(', ')}.` };
}
/** The branch line, with the project's naming rule after it (`namingRule`, TER-1110) when there is one. */
const namingOf = (naming: string | null | undefined) => (naming?.trim() ? clip(naming.trim(), NAMING_MAX) : null);
const branchLine = (head: string, branch: string, naming: string | null | undefined) => [`${head} ${pushLine(branch)}`, namingOf(naming)].filter(Boolean).join(' ');
/**
 * TER-1025: a GitHub outage is not the card's problem. The agent retries a push or a PR that failed on
 * GitHub's side a couple of times, then hands the wait to the server (`code: github_transient`), which
 * resumes it once GitHub works again instead of calling the person. Never a force push (R5). Dropped
 * from a prompt with no room left: `report_card`'s description says the same.
 */
export const GITHUB_LINE =
  'Erro do GitHub em push ou gh pr create (5xx, "commit_refs", "Something went wrong") não é do card: tente de novo, sem force; se continuar, report_card blocked com code github_transient, e o termhub retoma quando o GitHub voltar.';
// 660 and 200 (TER-1043): room for the decision line under PROMPT_MAX_CHARS; the whole policy is in get_automation_policy
const POLICY_MAX = 660;
/** The naming rule's longest form (two ticket keys and a ref) fits well under it. */
const NAMING_MAX = 300;
const TITLE_MAX = 200;

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
/** A required part with a shorter form, used when the other required parts leave no room for the long one. */
type Elastic = { elastic: string; compact: string };

/**
 * Joins the parts and fills what is left of the budget with the (optional) description excerpt. The rules
 * part (`rules`, its index in `parts`) only takes what the required parts leave; an `Optional` part is then
 * dropped when the required ones and the rules leave no room for it (a custom text at its maximum).
 */
function assemble(input: (string | Optional | Elastic | null)[], description: string | null, rules: number | null = null): string {
  // an elastic part takes its long form when the other required parts (the rules aside) leave room for it
  const others = input.filter((p, i): p is string => typeof p === 'string' && i !== rules).join('\n\n');
  let parts: (string | Optional | null)[] = input.map((p) => {
    if (p === null || typeof p === 'string' || !('elastic' in p)) return p;
    const room = BUDGET - others.length - 2;
    return p.elastic.length <= room ? p.elastic : clip(p.compact, Math.max(1, room));
  });
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

const policyLine = (policy: string, max = POLICY_MAX) => `Política do projeto (consulte também get_automation_policy):\n${clip(policy, max)}`;
/** What the naming rule takes from another part, so the prompt stays under the cap (TER-1110). */
const namingRoom = (naming: string | null | undefined) => (namingOf(naming)?.length ?? -1) + 1;
/** What naming the repository in the branch line takes from the policy excerpt (multi-repo Task 11). */
const repoRoom = (repo: string | null | undefined) => (repo ? ` no repositório ${repo}, na`.length : 0);
/**
 * What a workspace run's prompt takes over a single-repo one from the policy excerpt (Task 12): the repository
 * block, the longer push, report and shell lines. At most `POLICY_MAX - 220`, so the level line always stays;
 * past that the repository block gives way (its compact form).
 */
const multiRoom = (block: Elastic, workspace: string | null | undefined, branch: string) =>
  Math.min(POLICY_MAX - 220, block.elastic.length + 2 + (pushLineMulti(branch, workspace).length - pushLine(branch).length) + MULTI_WORDING + (SHELL_LINE_MULTI.length - SHELL_LINE.length));
/** The longer wording of a workspace run's branch and report lines. */
const MULTI_WORDING = 90;
const ref = (c: { ref: string; url: string; title: string }) => `${c.ref} ${clip(c.title, TITLE_MAX)}\n${c.url}`;

export function implementerPrompt(i: {
  card: { ref: string; url: string; title: string };
  branch: string;
  base: string;
  /** The project's naming rule for this card (`namingRule`, TER-1110): the ticket to cite, the ref never to use. */
  naming?: string | null;
  /** `owner/repo` of the card's repository, in a multi-repo project only (outline Task 11); null = not named. */
  repo?: string | null;
  /** A workspace run's repositories (outline Task 12): two or more; `repo` is then not used. */
  repos?: readonly PromptRepo[] | null;
  /** A workspace run's root on the machine (the tab's cwd), for the push form. */
  workspace?: string | null;
  policy: string;
  custom: string | null;
  description?: string | null;
  /** The project's current rules (`currentRulesBlock`, TER-1011), or null. */
  rules?: string | null;
  /** the project's "Parar em decisões de produto" (`stop_on_decisions`): off by default */
  stopOnDecisions?: boolean;
}): string {
  const ws = workspaceOf(i.repos);
  if (ws) {
    const block = reposBlock(ws);
    return assemble(
      [
        `Você trabalha no card ${ref(i.card)}`,
        [`Trabalhe na branch ${i.branch} em todos os repositórios do card. ${pushLineMulti(i.branch, i.workspace)}`, namingOf(i.naming)].filter(Boolean).join(' '),
        block,
        i.custom?.trim() || DEFAULT_IMPLEMENTER_TEXT,
        // the policy lists the card's repositories too: its excerpt gives up what the block and the longer push take
        policyLine(i.policy, POLICY_MAX - namingRoom(i.naming) - multiRoom(block, i.workspace, i.branch)),
        i.rules ?? null,
        TRUST_LINE,
        SHELL_LINE_MULTI,
        { optional: GITHUB_LINE },
        `Quando terminar, abra os PRs (cada um contra a base do seu repositório) e chame report_card com status done e as URLs; se travar, chame report_card com status blocked e o motivo.`,
        lastLine(i.stopOnDecisions, 'pr'),
      ],
      i.description ?? null,
      5,
    );
  }
  return assemble(
    [
      `Você trabalha no card ${ref(i.card)}`,
      branchLine(i.repo ? `Trabalhe no repositório ${i.repo}, na branch ${i.branch} (base ${i.base}).` : `Trabalhe na branch ${i.branch} (base ${i.base}).`, i.branch, i.naming),
      i.custom?.trim() || DEFAULT_IMPLEMENTER_TEXT,
      // the whole policy is in get_automation_policy: its excerpt gives up the room the naming rule takes
      // …and the repository's name too (the policy already lists the card's repository in a multi-repo project)
      policyLine(i.policy, POLICY_MAX - namingRoom(i.naming) - repoRoom(i.repo)),
      i.rules ?? null,
      TRUST_LINE,
      SHELL_LINE,
      { optional: GITHUB_LINE },
      `Quando terminar, abra o PR contra ${i.base} e chame report_card com status done e a URL; se travar, chame report_card com status blocked e o motivo.`,
      lastLine(i.stopOnDecisions, 'pr'),
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
  stopOnDecisions?: boolean;
  /** The epic's repositories when it has its branch in two or more (outline Task 15 wires it; Task 12 shapes it). */
  repos?: readonly PromptRepo[] | null;
  workspace?: string | null;
}): string {
  const ws = workspaceOf(i.repos);
  if (ws) {
    const block = reposBlock(ws);
    return assemble(
      [
        `Você integra o épico ${ref(i.epic)}`,
        `A branch do épico é ${i.branch} em todos os repositórios abaixo; o PR do épico é ${i.prUrl}. ${pushLineMulti(i.branch, i.workspace)}`,
        block,
        i.custom?.trim() || DEFAULT_INTEGRATOR_TEXT('<base do repositório>'),
        policyLine(i.policy, POLICY_MAX - multiRoom(block, i.workspace, i.branch)),
        i.rules ?? null,
        TRUST_LINE,
        SHELL_LINE_MULTI,
        { optional: GITHUB_LINE },
        `Quando terminar, chame report_card com status done e as URLs dos PRs; se travar, chame report_card com status blocked e o motivo.`,
        lastLine(i.stopOnDecisions, 'report'),
      ],
      null,
      5,
    );
  }
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
      lastLine(i.stopOnDecisions, 'report'),
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
  naming?: string | null;
  custom: string | null;
  rules?: string | null;
  stopOnDecisions?: boolean;
  /** A workspace card's repositories (Task 12) and the key of the one whose PR the fixer works on. */
  repos?: readonly PromptRepo[] | null;
  repoKey?: string | null;
  workspace?: string | null;
}): string {
  const what = i.reason === 'conflict' ? `O PR do card ${i.ref} tem conflito com ${i.base}.` : `O CI do PR do card ${i.ref} falhou.`;
  const ws = workspaceOf(i.repos);
  if (ws) {
    const where = i.repoKey ? ` O PR é do repositório da pasta ${i.repoKey}/.` : '';
    const block = reposBlock(ws, i.repoKey);
    return assemble(
      [
        [`${what}${where} Trabalhe na branch ${i.branch}. ${pushLineMulti(i.branch, i.workspace)}`, namingOf(i.naming)].filter(Boolean).join(' '),
        block,
        // 900 less what the repository block and the longer lines take (the detail names the PR anyway)
        `Detalhe:\n${clip(i.detail, 900 - namingRoom(i.naming) - multiRoom(block, i.workspace, i.branch) - where.length)}`,
        i.custom?.trim() || (i.reason === 'conflict' ? DEFAULT_FIXER_CONFLICT_TEXT(i.base) : DEFAULT_FIXER_CI_TEXT),
        i.rules ?? null,
        TRUST_LINE,
        SHELL_LINE_MULTI,
        { optional: GITHUB_LINE },
        `Quando o PR estiver corrigido, chame report_card com status done; se travar, chame report_card com status blocked e o motivo.`,
        lastLine(i.stopOnDecisions, 'report'),
      ],
      null,
      4,
    );
  }
  return assemble(
    [
      branchLine(`${what} Trabalhe na branch ${i.branch}.`, i.branch, i.naming),
      // 900: room for the decision line (TER-1043) under PROMPT_MAX_CHARS with the longest custom text, less
      // what the naming rule takes (TER-1110)
      `Detalhe:\n${clip(i.detail, 900 - namingRoom(i.naming))}`,
      i.custom?.trim() ||
        (i.reason === 'conflict'
          ? DEFAULT_FIXER_CONFLICT_TEXT(i.base)
          : DEFAULT_FIXER_CI_TEXT),
      i.rules ?? null,
      TRUST_LINE,
      SHELL_LINE,
      { optional: GITHUB_LINE },
      `Quando o PR estiver corrigido, chame report_card com status done; se travar, chame report_card com status blocked e o motivo.`,
      lastLine(i.stopOnDecisions, 'report'),
    ],
    null,
    3,
  );
}
