import { t } from '@/i18n';

const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

/** The agent a session row names (TER-1106): the AI CLI its hooks last reported, or "Terminal" when none has. */
export function agentLabel(tool: string | null): string {
  if (!tool) return t('Terminal');
  return NAMES[tool] ?? tool;
}
