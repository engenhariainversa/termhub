// What "Iniciar sessão" started a tab's agent with (TER-1104): kept in memory for the app's life, by tab,
// so the session screen of the tab the agent went to (this one, or a new one) says it. Never persisted.
import { t } from '@/i18n';

export interface StartedAgent {
  provider: string;
  account: string;
  /** null = the CLI's own default */
  model: string | null;
}

const started = new Map<string, StartedAgent>();

export function rememberStartedAgent(tabId: string, agent: StartedAgent): void {
  started.set(tabId, agent);
}

export function startedAgentOf(tabId: string): StartedAgent | null {
  return started.get(tabId) ?? null;
}

/** The CLI an account's agent runs: a provider this build does not know reads as itself. */
export const cliOf = (provider: string): string => (provider === 'claude' ? 'Claude Code' : provider === 'chatgpt' ? 'Codex' : provider);

/** The model as the person reads it: null is the CLI's own default. */
export const modelText = (model: string | null): string => model ?? t('padrão do CLI');

/** "Iniciado com Claude Code · conta Pessoal · modelo opus". */
export function startedAgentLine(agent: StartedAgent): string {
  return t('Iniciado com {{cli}} · conta {{account}} · modelo {{model}}', { cli: cliOf(agent.provider), account: agent.account, model: modelText(agent.model) });
}
