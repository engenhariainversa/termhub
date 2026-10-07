import type { FastifyBaseLogger } from 'fastify';
import { isClaudeSessionId } from '@termhub/machine-ops';
import { swapPreferences } from '../control/account-swap.js';
import { continueLine, installRunGuard, resumeLine, type AgentPermission } from '../control/agents.js';
import type { Repositories } from '../db/repositories/index.js';
import { guardAccount, loginOf } from '../ai/exclusive.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import { followerWillRestart } from '../automation/restart.js';
import { runPermission } from '../automation/permission.js';
import { failureLabel } from './service.js';
import type { SuggestionPayload } from './tab-question-payload.js';
import { closeTabQuestions, publishTabQuestions } from './tab-questions.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/** The tab's `state_text` once its agent is found gone (TER-643): what the monitor and `list_tabs` show. */
export const AGENT_EXITED_TEXT = 'Agente encerrado sem terminar o turno';

/** What a resumed Claude session is told first. */
export const EXITED_RESUME_PROMPT = 'O processo anterior desta sessão foi encerrado no meio do trabalho. Continue a tarefa de onde parou.';

/**
 * The line that brings the tab's agent back, under the account it ran with: a Claude session whose id the
 * hooks reported resumes by id (with the tab's memory MCP while its token lives, and the project's model);
 * otherwise the CLI's own "last session" (`claude --continue`, `codex resume --last`).
 * `auto`: the tab runs automatic work (preflight F-12) — the line keeps the run's permission profile and the
 * tab's MCP, and starts with the given message (the server's marked one) instead of EXITED_RESUME_PROMPT.
 */
export async function resumeCommandFor(repos: Repositories, tab: Tab, machine: Machine, auto?: { permission: AgentPermission; prompt: string } | null): Promise<string> {
  const codex = tab.state_tool === 'codex';
  const owned = await repos.aiAccounts.list(machine.owner_id);
  const account = tab.ai_account_id ? owned.find((a) => a.id === tab.ai_account_id && a.machine_id === machine.id) : undefined;
  const configDir = account?.config_dir ?? null;
  // TER-990: the login the line resumes on (the tab's account, else the machine's default one) must be
  // usable in the tab's project — an exclusive account is never brought back elsewhere.
  const login = account ?? loginOf(owned, machine.id, codex ? 'chatgpt' : 'claude', null);
  if (login) await guardAccount(repos, undefined, login, { project_id: tab.project_id, path: 'restart', machine_id: machine.id, tab_id: tab.id });
  const sessionId = !codex && tab.agent_session_id && isClaudeSessionId(tab.agent_session_id) ? tab.agent_session_id : null;
  if (codex || (!sessionId && !auto)) return continueLine(codex ? 'chatgpt' : 'claude', configDir);
  const [hasTabMcp, prefs] = await Promise.all([repos.apiTokens.hasLiveForTab(tab.id).catch(() => false), swapPreferences(repos, tab, machine).catch(() => ({ model: undefined }))]);
  const mcpTabId = hasTabMcp ? tab.id : null;
  // an automatic tab comes back with its hard-lock guard, written again first (TER-1005); throws without it
  const guardTabId = await installRunGuard(machine, tab.id, auto?.permission);
  if (sessionId) return resumeLine(configDir, sessionId, auto?.prompt ?? EXITED_RESUME_PROMPT, mcpTabId, prefs.model, auto?.permission, guardTabId);
  return continueLine('claude', configDir, auto ? { ...auto, mcpTabId, guardTabId } : null);
}

/**
 * The tab's agent exited without a hook (TER-643): the sweeper found the pane back at its shell and set
 * the tab `idle`. A card in the project owner's most recently active conversation says so and offers the
 * line that resumes it (a suggestion card: editable, Enviar / Dispensar); opening it expires whatever the
 * dead process had left open. `lastAt` is the tab's last state change before the exit. A project nobody
 * chats in gets no card, and neither does a tab whose automatic run's follower restarts it.
 * Never throws; logs ids only.
 */
export async function notifyAgentExited(repos: Repositories, log: Log, tab: Tab, machine: Machine, lastAt: string | null): Promise<void> {
  try {
    // A tab running automatic work is restarted by the run's follower when it can (spec D15): then no card.
    // What the dead process left open still expires. Otherwise (paused, automation off, card untagged, run
    // parked or out of restarts) the person gets the card, with a line that keeps the run's profile (F-12).
    const run = await repos.automationRuns.activeByTab(tab.id);
    if (run && (await followerWillRestart(repos, run))) {
      await closeTabQuestions(repos, tab.id, 'expired');
      log.info({ tabId: tab.id, machineId: machine.id, runId: run.id }, 'agent exited in an automatic run: the follower restarts it');
      return;
    }
    const auto = run ? { permission: await runPermission(repos, run), prompt: EXITED_RESUME_PROMPT } : null;
    const owner = (await repos.projects.findById(tab.project_id))?.owner_id;
    const conversation = owner ? await repos.chat.findLatestActiveForProject(tab.project_id, owner) : undefined;
    if (!conversation) {
      await closeTabQuestions(repos, tab.id, 'expired');
      return;
    }
    const payload: SuggestionPayload = { text: await resumeCommandFor(repos, tab, machine, auto), context: null, exited: true, last_at: lastAt, ...(tab.state_tool === 'codex' ? { agent: 'codex' as const } : {}) };
    const { question, closed } = await repos.tabQuestions.open({ tab_id: tab.id, project_id: tab.project_id, conversation_id: conversation.id, kind: 'suggestion', payload, tool_use_id: null, agent_id: null });
    await publishTabQuestions(repos, 'tab_question_closed', closed);
    if (question) await publishTabQuestions(repos, 'tab_question', [question]);
    log.info({ tabId: tab.id, machineId: machine.id, tabQuestionId: question?.id ?? null, closed: closed.length }, 'agent exited card opened');
  } catch (err) {
    log.warn({ tabId: tab.id, code: failureLabel(err) }, 'agent exited card failed');
  }
}
