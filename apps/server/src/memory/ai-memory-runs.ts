import type { AiProvider, Machine } from '../db/repositories/types.js';
import type { ProjectAiMemory } from '../setup/schema.js';
import { aiMemoryUrlOf } from './ai-memory.js';

/**
 * ai-memory in the agents termhub starts (TER-1020, spike TER-1008). Opt-in twice: the project's
 * `setup.ai_memory.use_in_runs` and the machine's "Usar ai-memory nesta máquina" (TER-1018). Then:
 * - Claude Code gets the machine's ai-memory MCP for the session (the tab's own MCP config, or an inline
 *   `--mcp-config`), and an automatic run also gets ai-memory's hooks in its worktree's
 *   `.claude/settings.local.json` (`aiMemoryRunPrepLine`), never in the person's `~/.claude`.
 * - Codex gets the MCP through `-c mcp_servers.…` overrides and one line in its prompt (`AI_MEMORY_HINT`).
 *   Codex runs hooks only after an interactive "Trust all" (`codex exec` skips untrusted ones), so termhub
 *   installs none and does not try to get around that.
 * - Antigravity and Gemini CLI are not started by termhub (their config is global only, or needs an API
 *   key): nothing is written for them.
 */

/** The MCP server's name as the CLIs see it: tools become `mcp__ai_memory__memory_query`. A TOML bare key too. */
export const AI_MEMORY_MCP_SERVER = 'ai_memory';

/**
 * Appended to a Codex prompt when it has the ai-memory MCP: in the spike Codex only queried memory when the
 * question pointed at history, and otherwise re-read the code.
 */
export const AI_MEMORY_HINT = 'Consulte memory_query (MCP ai_memory) antes de re-investigar algo que já pode ter sido decidido.';

export function withAiMemoryHint(prompt: string): string {
  return `${prompt}\n\n${AI_MEMORY_HINT}`;
}

/** The machine's ai-memory MCP endpoint: its server URL (TER-1018) plus `/mcp`. */
export function aiMemoryMcpUrl(machine: Pick<Machine, 'ai_memory_url'>): string {
  return `${aiMemoryUrlOf(machine).replace(/\/+$/, '')}/mcp`;
}

/** What an agent started on this machine for this project gets, or null when either side did not opt in
 *  or the CLI is not one termhub wires (only Claude Code and Codex). */
export function aiMemoryForRun(setup: ProjectAiMemory, machine: Pick<Machine, 'ai_memory_enabled' | 'ai_memory_url'>, provider: AiProvider): { mcpUrl: string; serverUrl: string } | null {
  if (!setup.use_in_runs || !machine.ai_memory_enabled) return null;
  if (provider !== 'claude' && provider !== 'chatgpt') return null;
  return { mcpUrl: aiMemoryMcpUrl(machine), serverUrl: aiMemoryUrlOf(machine) };
}

/** The ai-memory server as a Claude Code MCP config entry: loopback, no token. */
function server(url: string): { type: 'http'; url: string } {
  return { type: 'http', url };
}

/** A Claude Code MCP config holding only the ai-memory server, for `--mcp-config <json>`. */
export function aiMemoryMcpConfig(url: string): string {
  return JSON.stringify({ mcpServers: { [AI_MEMORY_MCP_SERVER]: server(url) } });
}

/** Adds the ai-memory server to an MCP config (the tab's `mcp.json`), so a resumed session keeps it too. */
export function withAiMemoryServer(config: string, url: string): string {
  const parsed = JSON.parse(config) as { mcpServers: Record<string, unknown> };
  return JSON.stringify({ ...parsed, mcpServers: { ...parsed.mcpServers, [AI_MEMORY_MCP_SERVER]: server(url) } });
}
