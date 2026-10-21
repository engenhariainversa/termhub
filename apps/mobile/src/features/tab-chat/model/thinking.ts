// The "pensando…" line at the end of a session's conversation while its agent works (TER-1102), the
// tab chat's version of the chat's "pensando…" bubble. Claude Code writes a tool call to its transcript
// when it starts, so its running tool is a row of the timeline; Codex writes an item only once it ends,
// so for it the tool comes from the tab's activity, which its PreToolUse hook reports (and none at all
// while its hooks are not trusted: "pensando…" alone, from the tab's state). Pure: no React.
import { t } from '@/i18n';
import type { TTabSummary } from '@/services/api/contract';
import { activityLabel } from './activity-label';
import type { Row } from './timeline';

/** What the line says, or null when the agent is not at work: the turn ended, or it only waits on its background work. */
export function thinkingLine(tab: Pick<TTabSummary, 'state' | 'background' | 'activity'> | null, rows: Row[]): string | null {
  if (!tab || tab.state !== 'working' || tab.background) return null;
  const last = rows[rows.length - 1];
  const running = last?.kind === 'tools' ? last.tools.filter((x) => x.status === 'running').pop() : undefined;
  if (running) return t('executando {{tool}}…', { tool: running.summary ? `${running.name} · ${running.summary}` : running.name });
  const activity = activityLabel(tab.activity);
  return activity ? t('pensando… · {{activity}}', { activity }) : t('pensando…');
}
