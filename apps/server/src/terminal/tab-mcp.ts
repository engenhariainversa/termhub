import { buildTabMcpRemoveScript, buildTabMcpWriteScript, shellQuote, type TabMcpFile } from '@termhub/machine-ops';
import { agentRpc, requireAgentVersion, versionAtLeast } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import type { Machine } from '../db/repositories/types.js';
import { runOnMachineWithInput } from './machine-exec.js';

/**
 * The per-tab MCP config on the machine (spec 2026-09-27 agent tab MCP D7, D12): `~/.termhub/tabs/<tab_id>/`,
 * written by the `@termhub/machine-ops` scripts — through the `tab.mcp.*` RPCs on an agent machine, through
 * `sh -c` on ssh/local. The body (it holds the tab token) travels on stdin only, never in an argv or a log.
 */

/** First agent release that answers `tab.mcp.write` / `tab.mcp.remove`. */
export const TAB_MCP_MIN_AGENT_VERSION = '0.10.0';
/** The MCP server's name as the tab's CLI sees it (tools become `mcp__termhub_tab__<tool>`), distinct from a
 *  `termhub` server the person may have configured with a personal token (D8). */
export const TAB_MCP_SERVER = 'termhub_tab';

const SCRIPT_TIMEOUT_MS = 10_000;

/** Whether the machine can take a tab's config: ssh/local always; an agent from 0.10.0 on (the connected
 *  agent's own version when it is online, else the one last recorded). */
export function tabMcpSupported(machine: Machine): boolean {
  if (machine.type !== 'agent') return true;
  const version = agents.info(machine.id)?.agent_version ?? machine.agent_version;
  return !!version && versionAtLeast(version, TAB_MCP_MIN_AGENT_VERSION);
}

/** First agent release that ships the hard-lock guard script (TER-993); the server only points
 *  `--settings` at it on a machine new enough to have it, so an older agent gets no dangling hook. */
export const GUARD_MIN_AGENT_VERSION = '0.19.0';

/** Whether the machine has the guard script `~/.termhub/bin/termhub-guard` (agent 0.19.0+). ssh/local
 *  machines never run automatic work, so they are not a case here; an agent's live version wins. */
export function guardSupported(machine: Machine): boolean {
  if (machine.type !== 'agent') return false;
  const version = agents.info(machine.id)?.agent_version ?? machine.agent_version;
  return !!version && versionAtLeast(version, GUARD_MIN_AGENT_VERSION);
}

async function runScript(machine: Machine, script: string, input: Buffer): Promise<void> {
  // Over ssh the remote command goes to the user's login shell, which may not be POSIX (fish): `sh -c` there too.
  const r = await runOnMachineWithInput(machine, { file: 'sh', args: ['-c', script] }, `sh -c ${shellQuote(script)}`, input, SCRIPT_TIMEOUT_MS);
  // Only the outcome: stderr may name paths, never the body, but there is no reason to carry it along.
  if (r.code !== 0 || !/^ok$/m.test(r.stdout)) throw new Error(r.timedOut ? 'a máquina demorou para responder' : 'a máquina recusou a gravação');
}

/** Writes one file of the tab's config (0700 dir, 0600 file). Throws on any failure, the body never in the error. */
export async function installTabMcp(machine: Machine, tabId: string, file: TabMcpFile, body: string): Promise<void> {
  const script = buildTabMcpWriteScript(tabId, file); // throws on a tab id that is not ours, before anything runs
  if (machine.type === 'agent') {
    requireAgentVersion(machine, TAB_MCP_MIN_AGENT_VERSION);
    await agentRpc(machine, 'tab.mcp.write', { tab_id: tabId, file, body });
    return;
  }
  await runScript(machine, script, Buffer.from(body));
}

/** Deletes the tab's config dir. Best effort, never throws: the token is already revoked with the tab (D12).
 *  An agent older than 0.10.0 never had the dir and is not asked (it would drop the unknown frame). */
export async function removeTabMcp(machine: Machine, tabId: string): Promise<void> {
  try {
    const script = buildTabMcpRemoveScript(tabId);
    if (machine.type === 'agent') {
      if (!tabMcpSupported(machine)) return;
      await agentRpc(machine, 'tab.mcp.remove', { tab_id: tabId });
      return;
    }
    await runScript(machine, script, Buffer.alloc(0));
  } catch {
    // hygiene only
  }
}
