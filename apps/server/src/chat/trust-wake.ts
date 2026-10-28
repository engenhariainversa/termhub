import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import { monitorBus, type TabStateChange } from '../monitor/bus.js';
import { failureLabel } from './service.js';
import { WATCH_LIMITS } from './watches/kinds.js';
import { publishWatches } from './watches/view.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/*
 * TER-1117: a tab waiting on its CLI's folder trust dialog (Claude Code, Codex, Cursor or Gemini, TER-1122) wakes the project's chat on its own. Before,
 * the concierge only learnt of it through a watch it had to remember, or when the person asked. Where the
 * server answers the dialog itself (the project's folder, monitor/folder-trust.ts) the tab never gets here.
 * The wake is a watch the server registers in the project's chat, already behind the event: the watch
 * engine fires it at once and delivers it like any other (both colours, once, rate-limited, after
 * restarts). A tab already watched for `trust_prompt` (start_agent's own watch) is left to that watch, and
 * an automatic run's tab to its follower.
 */

/** What the chat is told to do. */
export const TRUST_WAKE_NOTE =
  'A aba está parada no diálogo de confiança da pasta do CLI dela (Claude Code: "Is this a project you created or one you trust?"; Codex: "Trust this folder?"; Cursor: "Workspace Trust Required"; Gemini: "Do you trust the files in this folder?") e não segue sozinha. read_screen mostra qual. A opção de confiar (Claude "Yes, I trust this folder", Codex "Trust and continue", Cursor "Trust this workspace", Gemini "Trust folder") já vem marcada: com o aval da pessoa, ou de uma regra dela que cubra esta pasta, send_key Enter na aba confia e o agente continua. Se a opção marcada for outra, ou o Codex oferecer "work in this folder without asking for approval" (isso também desliga as aprovações), não responda: avise a pessoa (notify needs_you) dizendo a aba e que ela precisa confiar na pasta.';
/** How long the server's watch waits to be delivered. */
const WAKE_HOURS = 6;

/** Registers the wake for one change; true when a watch was created. Never throws. */
export async function wakeOnTrustPrompt(repos: Repositories, log: Log, change: TabStateChange, nudge: (tabId: string) => void): Promise<boolean> {
  const { tab, owner_id: ownerId } = change;
  if (tab.state !== 'trust_prompt' || !ownerId || !tab.state_at) return false;
  try {
    if (await repos.automationRuns.activeByTab(tab.id)) return false;
    const open = await repos.chatWatches.listAllOpen({ kind: 'tab', targetId: tab.id });
    if (open.some((w) => w.params.events.includes('trust_prompt'))) return false;
    const conversation = (await repos.chat.findLatestActiveForProject(tab.project_id, ownerId)) ?? (await repos.chat.getOrCreateForProject(ownerId, tab.project_id));
    if ((await repos.chatWatches.countOpen(ownerId, tab.project_id)) >= WATCH_LIMITS.openPerScope) return false;
    const now = new Date();
    // the cursor sits just before the trust_prompt event, so the engine's next look fires it
    const cursor = new Date(Date.parse(tab.state_at) - 1000).toISOString();
    const row = await repos.chatWatches.create(
      {
        user_id: ownerId,
        project_id: tab.project_id,
        conversation_id: conversation.id,
        kind: 'tab',
        target_id: tab.id,
        params: { events: ['trust_prompt'] },
        baseline: { cursor },
        label: tab.name,
        note: TRUST_WAKE_NOTE,
        recurring: false,
        expires_at: new Date(now.getTime() + WAKE_HOURS * 3600_000),
      },
      now,
    );
    log.info({ tabId: tab.id, watchId: row.id }, 'trust prompt: chat wake registered');
    await publishWatches(repos, ownerId, tab.project_id).catch(() => undefined);
    nudge(tab.id);
    return true;
  } catch (err) {
    log.warn({ tabId: tab.id, code: failureLabel(err) }, 'trust prompt: chat wake failed');
    return false;
  }
}

/** Subscribes to the tab states of this process. Returns the unsubscribe. */
export function startTrustWake(repos: Repositories, log: Log, nudge: (tabId: string) => void): () => void {
  // one registration at a time per tab: the same state may be published twice in a row
  const busy = new Set<string>();
  return monitorBus.subscribe((change) => {
    const id = change.tab.id;
    if (change.tab.state !== 'trust_prompt' || busy.has(id)) return;
    busy.add(id);
    void wakeOnTrustPrompt(repos, log, change, nudge).finally(() => busy.delete(id));
  });
}
