import { DEFAULT_LOCALE, t, tk, type Locale } from '../i18n/index.js';

/*
 * The escalation reasons and their texts (spec §9.3), in a leaf module: the follower, the dispatcher and the
 * mobile push service read them without importing each other.
 */

/** `automation_runs.waiting_reason` of a run parked on something only a person can do in the tab. */
export const NEEDS_PERSON = 'needs_person';
/** The escalation reason of a run parked on the trust question. */
export const TRUST_PROMPT = 'trust_prompt';
/** TER-1005: the start watchdog found the tab back at its shell: the agent never came up (its launch line failed). */
export const AGENT_NOT_STARTED = 'agent_not_started';
/** TER-1005: the agent exited and the machine's agent has no hard-lock guard (before 0.19.0): it is not brought back without it. */
export const AGENT_OUTDATED = 'agent_outdated';
/** The escalation reason of a run whose tab asks a question nothing automatic could answer (spec D18 step 4). */
export const QUESTION_UNANSWERED = 'question_unanswered';
/** The escalation reason of a run whose question card closed without an answer while the tab still asks it. */
export const QUESTION_EXPIRED = 'question_expired';
/** The escalation reason of a run whose questions were answered automatically too often in the last hour. */
export const ANSWER_CAP = 'answer_cap';
/** TER-970 (R7): more than `AUTOMATION_ANSWERS_MAX_PER_RUN` automatic answers in one run. */
export const ANSWER_RUN_CAP = 'answer_run_cap';
/** TER-970 (R7): the same question was answered the same way `ANSWER_CYCLE_MAX` times in the last hour: the agent is going round in circles. */
export const ANSWER_CYCLE = 'answer_cycle';
/** A permission request the project's rules do not allow (spec §9.2): the person answers it on the card. */
export const PERMISSION_NEEDED = 'permission_needed';
/** The reason a run is handed over after `resume_max` resumes that did not move it (also the chat's own
 *  `escalate_automation_run`, which comes after that wake). */
export const RESUME_CAP = 'resume_cap';
/** A card whose start failed MAX_START_FAILURES times in a row: its tag was removed (dispatcher). */
export const START_FAILED = 'start_failed';
/** The agent exited again after its one restart: the run ends blocked. */
export const AGENT_EXITED = 'agent_exited';
/** TER-990: the agent exited and its account is exclusive to another project: it is not restarted there. */
export const ACCOUNT_EXCLUSIVE = 'account_exclusive';
/** A PR still in conflict after `fix_attempts` fixer runs (merge executor, spike R2): a person resolves it. */
export const CONFLICT_CAP = 'conflict_cap';
/** TER-1004: a green PR of an automatic card that also cites a person's card not yet done: a person merges it (or drops the citation). */
export const MERGE_PERSON_CARD = 'merge_person_card';
/** A PR whose CI is still red after `fix_attempts` fixes (spec D21, shared with the conflict fixes): a person looks at it. */
export const CI_CAP = 'ci_cap';
/** R8: the card's estimated cost passed `card_budget_usd`; the run is parked, not resumed. */
export const CARD_BUDGET = 'card_budget';
/** The agent itself said it is stuck (`report_card blocked`). */
export const REPORTED_BLOCKED = 'reported_blocked';

/**
 * TER-1025: the agent said it is stuck on a GitHub error (a 5xx push, `commit_refs`, `gh pr create`'s
 * "Something went wrong"): the run waits for GitHub and is resumed by itself; past `github_retries` the
 * person is told with this reason.
 */
export const GITHUB_TRANSIENT = 'github_transient';

/** The project's deploy workflow failed on a merge the automation made: automation of the project is paused (spec D22). */
export const DEPLOY_FAILED = 'deploy_failed';
/** Same, but the pause could not be applied (owner not found or the write failed): the text must not claim it. */
export const DEPLOY_FAILED_NOT_PAUSED = 'deploy_failed_not_paused';
/** A release workflow (npm, OTA…) failed after a merge: nothing is paused, a person looks at it. */
export const RELEASE_FAILED = 'release_failed';

/** The text the feed, the chat line and the push show for each escalation reason (spec §9.3). */
export const ESCALATION_TEXT: Record<string, string> = {
  [TRUST_PROMPT]: tk('O agente parou na confirmação de confiança da pasta; confirme na aba para continuar.'),
  [AGENT_NOT_STARTED]: tk('O agente não chegou a iniciar: a aba voltou ao terminal. Confira o erro na tela e retome.'),
  [AGENT_OUTDATED]: tk('O agente saiu e esta máquina não tem a trava do automático; atualize o agente (0.19.0 ou mais nova) e retome.'),
  [QUESTION_UNANSWERED]: tk('O agente fez uma pergunta que o modo automático não soube responder; responda no card.'),
  [QUESTION_EXPIRED]: tk('O card da pergunta do agente fechou sem resposta; responda na aba para continuar.'),
  [ANSWER_CAP]: tk('O agente fez perguntas demais respondidas automaticamente na última hora; confira a aba e responda no card.'),
  [ANSWER_RUN_CAP]: tk('O agente já recebeu muitas respostas automáticas nesta execução; confira a aba e responda no card.'),
  [ANSWER_CYCLE]: tk('O agente repetiu a mesma pergunta e recebeu a mesma resposta automática várias vezes; confira a aba e responda no card.'),
  [PERMISSION_NEEDED]: tk('O agente pediu uma permissão que as regras do projeto não liberam; responda no card.'),
  [RESUME_CAP]: tk('O agente parou várias vezes sem terminar e o chat não soube continuar; confira a aba.'),
  [START_FAILED]: tk('O card não conseguiu começar depois de várias tentativas e saiu do automático; corrija a causa e marque o card de novo.'),
  [AGENT_EXITED]: tk('O agente saiu de novo depois de reiniciado; confira a aba.'),
  [ACCOUNT_EXCLUSIVE]: tk('O agente saiu e a conta dele é exclusiva de outro projeto; não foi reiniciado. Escolha outra conta e retome.'),
  [CARD_BUDGET]: tk('Orçamento do card estourado; o agente não foi retomado. Confira a aba e retome quando quiser.'),
  [REPORTED_BLOCKED]: tk('O agente disse que travou e precisa de você.'),
  [GITHUB_TRANSIENT]: tk('O GitHub continuou falhando no push ou no PR depois das novas tentativas automáticas; confira a aba e retome.'),
  [DEPLOY_FAILED]: tk('O deploy falhou depois do merge; o automático do projeto foi pausado. Confira o deploy e retome quando estiver resolvido.'),
  [DEPLOY_FAILED_NOT_PAUSED]: tk('O deploy falhou depois do merge e o automático do projeto não pôde ser pausado; pause o projeto e confira o deploy.'),
  [RELEASE_FAILED]: tk('Um workflow de publicação falhou depois do merge; confira a execução.'),
  [CI_CAP]: tk('O CI do PR continua falhando depois das tentativas de correção; confira o PR.'),
  [MERGE_PERSON_CARD]: tk('O PR está verde, mas cita um card manual que ainda não está em Feito, então o automático não mescla. Mescle à mão ou tire a citação do PR.'),
  [CONFLICT_CAP]: tk('O PR continua com conflito depois das tentativas de correção; resolva o conflito e o termhub mescla quando o CI ficar verde.'),
};

/** What a reason with no text of its own shows. */
export const ESCALATION_FALLBACK = tk('O trabalho automático parou e espera você.');

/** The escalation's text in the reader's language; null for a reason with no text of its own. */
export function escalationText(reason: string, locale: Locale = DEFAULT_LOCALE): string | null {
  const key = ESCALATION_TEXT[reason];
  return key ? t(locale, key) : null;
}

/** `escalationText`, or the generic text for a reason with none. */
export function escalationReasonText(reason: string, locale: Locale = DEFAULT_LOCALE): string {
  return escalationText(reason, locale) ?? t(locale, ESCALATION_FALLBACK);
}

/**
 * The `waiting_reason`s of a run parked for the person (an escalation, TER-888): such a run keeps its card
 * (it stays active) but frees its `max_parallel` slot, so the dispatcher may start another card. A run
 * waiting on its account's usage limit is not one of them: it goes on by itself once the limit resets.
 */
export const SLOT_FREE_REASONS: readonly string[] = [NEEDS_PERSON, TRUST_PROMPT, AGENT_NOT_STARTED, QUESTION_UNANSWERED, QUESTION_EXPIRED, ANSWER_CAP, ANSWER_CYCLE, ANSWER_RUN_CAP, PERMISSION_NEEDED, RESUME_CAP, CARD_BUDGET];

