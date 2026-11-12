/**
 * TER-1168: whether a tab ran an agent CLI and whether that agent is gone. One reading for every place that
 * must not take a dead agent for a live one: `send_input` / `send_key` (control/terminals.ts), the watches
 * (chat/watches/evaluate.ts) and the health watcher (health/signals.ts).
 *
 * "Gone" is read from the monitor's own state, never from the screen: `idle` whose newest event is a session
 * end (Claude's `SessionEnd`, Cursor's `sessionEnd`) or termhub's sweep finding the pane back at its shell
 * (`AgentExited`, monitor/stale-working.ts). Other `idle` rows (Cursor's `sessionStart`, a CLI dialog closed with
 * no answer) are an agent still in front.
 */
import type { PaneForeground } from '@termhub/machine-ops';
import type { Tab, TabState } from '../db/repositories/types.js';

/** The tab events after which the agent is no longer in the tab. */
export const AGENT_GONE_EVENTS: ReadonlySet<string> = new Set(['SessionEnd', 'sessionEnd', 'AgentExited']);

/**
 * A tab where an agent CLI ran: its hooks reported (`state_tool`), or termhub started it (`ai_account_id`, a
 * session id). A shell tab from `open_tab` that never ran one is not: typing into its shell is the point.
 */
export const isAgentTab = (tab: Pick<Tab, 'state_tool' | 'ai_account_id' | 'agent_session_id'>): boolean =>
  !!(tab.state_tool || tab.ai_account_id || tab.agent_session_id);

/** The event name a tab event row carries in its meta, or null. */
export const eventNameOf = (meta: Record<string, unknown> | null | undefined): string | null => (typeof meta?.event === 'string' ? meta.event : null);

/** Whether a tab in `state`, whose newest event is named `lastEvent`, has its agent gone. */
export const agentGone = (state: TabState | null, lastEvent: string | null): boolean => state === 'idle' && lastEvent !== null && AGENT_GONE_EVENTS.has(lastEvent);

/** What the pane runs in front says about the agent: `shell` or `dead` = it left; `busy` or unknown = maybe there. */
export const paneLeft = (pane: PaneForeground | null): boolean => pane === 'shell' || pane === 'dead';
