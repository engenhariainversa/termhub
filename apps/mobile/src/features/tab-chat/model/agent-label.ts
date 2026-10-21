import { t } from '@/i18n';

// The AI CLI a tab runs, as the session screen names it (TER-1102). The server sends the CLI its hooks last
// reported from as a plain string; none yet (or an older server) reads as Claude Code, the conversation's
// first and default agent, the same way the server reads such a tab's transcript.

const NAME: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

/** The product name ("Codex"); a CLI this build does not know reads as itself. Product names are not translated. */
export function agentName(agent: string | null | undefined): string {
  if (!agent) return NAME.claude!;
  return Object.prototype.hasOwnProperty.call(NAME, agent) ? NAME[agent]! : agent;
}

/** Whether the tab runs Codex: its texts and menu differ from Claude Code's. */
export const isCodex = (agent: string | null | undefined): boolean => agent === 'codex';

const SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

/** The agent a session row names (TER-1106): the AI CLI its hooks last reported, or "Terminal" when none has. */
export function agentLabel(agent: string | null): string {
  if (!agent) return t('Terminal');
  return Object.prototype.hasOwnProperty.call(SHORT, agent) ? SHORT[agent]! : agent;
}
