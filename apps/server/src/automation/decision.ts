import { proseOf } from '../monitor/turn-end.js';

/*
 * TER-1043: automatic work decides by itself. The prompts tell the agent to follow its own recommendation
 * (or the person's precedent) and record the decision; this module is the server's safety net for a run
 * that still ends its turn on a question ("Decisão sua: A ou B? Recomendo A"). Pure: the agent's answer is
 * terminal content and is never logged or stored by anything here.
 */

/**
 * What the server types into an automatic tab that stopped on a question: look for the person's precedent,
 * else follow the recommendation, record the decision, and go on. An exception still stops the run.
 */
export const DECIDE_TEXT =
  'Trabalho automático: não espere a pessoa. Consulte search_memory (decisões e notas); se houver precedente da pessoa, siga-o; senão, siga a sua recomendação. Registre a decisão no PR, na seção "Decisões tomadas" (opções, escolha e motivo), e em report_card (decisions), e continue até o PR e o report_card. Se a decisão envolver uma exceção (credenciais, deploy/merge/publicação manual, lojas, dados de produção, escopo maior que o card), chame report_card com status blocked.';

/** At most this many DECIDE_TEXT nudges per run; past it, a stop goes back to the ordinary resumes and wake. */
export const DECIDE_NUDGES_MAX = 3;

/** Phrases that leave a decision to the person without a question mark, matched like `turn-end.ts`'s. */
const DECISION_ASK = new RegExp(
  `(?:^|[^a-z])(?:${[
    'decisao sua', 'sua decisao', 'voce decide', 'voce escolhe', 'qual (?:opcao|delas|caminho|voce prefere)', 'prefere', 'quer que',
    'your call', 'up to you', 'you decide', 'should i\\b', 'shall i\\b', 'want me to', 'which (?:option|one) do you',
  ].join('|')})`,
);

const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');

/** Longest question text kept for the exception check. */
const QUESTION_MAX = 2000;

/**
 * The part of an agent's last answer that asks the person something: the lines with a `?` outside code, or
 * that hand a decision over ("Decisão sua", "você decide"). Null when the answer asks nothing.
 */
export function questionOf(answer: string | null | undefined): string | null {
  const text = answer?.trim();
  if (!text) return null;
  const lines = proseOf(text)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.includes('?') || DECISION_ASK.test(` ${plain(l)} `));
  if (lines.length === 0) return null;
  return lines.join('\n').slice(0, QUESTION_MAX);
}

/**
 * The exceptions that still stop an automatic run (TER-1043 §2), matched on the question without accents:
 * credentials and `.env`, deploy/merge/publish by hand, the stores and EAS, `rm` outside the worktree,
 * docker and ssh, irreversible acts on production data, and a change of scope beyond the card. Crude on
 * purpose, like `memory/blocklist.ts`: a question that only mentions one of them escalates too, which is
 * the safe direction.
 */
const EXCEPTION = new RegExp(
  `(?:^|[^a-z0-9])(?:${[
    // credentials
    '\\.env', 'credencia', 'credential', 'secret', 'segredo', 'senha', 'password', 'api key', 'chave da api', 'tokens? de acesso', 'access token',
    // deploy, merge, publish by hand
    'deploy', 'merge', 'mesclar', 'mescla', 'publicar', 'publique', 'publico\\b', 'publicacao', 'publish', 'npm publish', 'force push', 'push --force', 'push -f\\b',
    // stores and EAS
    'eas\\b', 'app store', 'play store', 'testflight', 'lojas?\\b',
    // rm outside the worktree, docker, ssh
    'rm -r', 'fora da worktree', 'outside the worktree', 'docker', 'container', 'ssh\\b',
    // production data
    'producao', 'production', 'prod\\b', 'drop table', 'truncate', 'apagar dados', 'delete data',
    // scope
    'escopo', 'scope', 'fora do card', 'outside the card', 'outro card',
  ].join('|')})`,
);

export function decisionException(question: string): boolean {
  return EXCEPTION.test(` ${plain(question)} `);
}
