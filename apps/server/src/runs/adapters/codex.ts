import {
  clip,
  isRecord,
  looksLikeLimit,
  num,
  parseJsonLine,
  str,
  truncateInput,
  type Adapter,
  type AdapterOutcome,
  type RunEvent,
  type ToolName,
  type Usage,
} from '../events.js';

/**
 * Codex's `exec --json` output (JSONL of thread, turn and item events; fixture `fixtures/codex-read.jsonl`,
 * built from the documented format since no logged-in Codex was reachable when it was written) mapped to
 * normalized events:
 *
 * - `item.completed` `agent_message` → `text`.
 * - `command_execution` → `tool_use` `shell` when it starts, `tool_result` when it completes.
 * - `file_change` → `tool_use` `edit` + `tool_result`; `web_search` → `web`; `mcp_tool_call` →
 *   `other:<server>.<tool>` (runs load no MCP, but a user config might).
 * - `turn.completed` → a cumulative `usage` (Codex reports no cost).
 * - `turn.failed` → `error`.
 * - `thread.started`, `turn.started`, `reasoning`, `todo_list`, top-level `error` (retries) and anything
 *   unknown → nothing.
 */

export function codexAdapter(): Adapter {
  const usage = { input: 0, output: 0 };
  let sawUsage = false;
  let completed = false;
  let failed = false;
  let lastText: string | null = null;
  const announced = new Set<string>();

  function toolUse(id: string, name: ToolName, input: unknown): RunEvent[] {
    if (announced.has(id)) return [];
    announced.add(id);
    return [{ type: 'tool_use', id, name, input: truncateInput(input) }];
  }

  function onItem(item: Record<string, unknown>, finished: boolean): RunEvent[] {
    const id = str(item.id);
    if (!id) return [];
    switch (item.type) {
      case 'agent_message': {
        const text = str(item.text);
        if (!finished || !text) return [];
        lastText = text;
        return [{ type: 'text', text }];
      }
      case 'command_execution': {
        const out = toolUse(id, 'shell', { command: str(item.command) ?? '' });
        if (!finished) return out;
        const ok = item.exit_code === 0 && item.status !== 'failed' && item.status !== 'declined';
        return [...out, { type: 'tool_result', id, ok, summary: clip(str(item.aggregated_output) ?? '') }];
      }
      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
        const out = toolUse(id, 'edit', { changes: changes.map((c) => ({ path: str(c.path), kind: str(c.kind) })) });
        if (!finished) return out;
        const summary = changes.map((c) => `${str(c.kind) ?? 'update'} ${str(c.path) ?? ''}`.trim()).join('\n');
        return [...out, { type: 'tool_result', id, ok: item.status !== 'failed', summary: clip(summary) }];
      }
      case 'web_search': {
        const out = toolUse(id, 'web', { query: str(item.query) ?? '' });
        if (!finished) return out;
        return [...out, { type: 'tool_result', id, ok: true, summary: '' }];
      }
      case 'mcp_tool_call': {
        const raw = [str(item.server), str(item.tool)].filter(Boolean).join('.') || 'mcp';
        const out = toolUse(id, `other:${raw}`, item.arguments ?? {});
        if (!finished) return out;
        const error = isRecord(item.error) ? str(item.error.message) : null;
        return [...out, { type: 'tool_result', id, ok: item.status !== 'failed' && !error, summary: clip(error ?? '') }];
      }
      default:
        return [];
    }
  }

  return {
    parse(line) {
      const obj = parseJsonLine(line);
      if (!obj) return [];
      try {
        switch (obj.type) {
          case 'item.started':
          case 'item.updated':
            return isRecord(obj.item) ? onItem(obj.item, false) : [];
          case 'item.completed':
            return isRecord(obj.item) ? onItem(obj.item, true) : [];
          case 'turn.completed': {
            completed = true;
            const u = isRecord(obj.usage) ? obj.usage : null;
            if (!u) return [];
            sawUsage = true;
            // `cached_input_tokens` is a part of `input_tokens`, not an addition.
            usage.input += num(u.input_tokens);
            usage.output += num(u.output_tokens);
            return [{ type: 'usage', input_tokens: usage.input, output_tokens: usage.output }];
          }
          case 'turn.failed': {
            failed = true;
            const message = (isRecord(obj.error) ? str(obj.error.message) : null) ?? 'turn failed';
            return [{ type: 'error', code: looksLikeLimit(message) ? 'account_limited' : 'cli_failed', message: clip(message) }];
          }
          default:
            return [];
        }
      } catch {
        return [];
      }
    },
    finish(): AdapterOutcome {
      const u: Usage | null = sawUsage ? { input_tokens: usage.input, output_tokens: usage.output } : null;
      return { result: lastText, usage: u, ok: completed && !failed };
    },
  };
}
