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
 * Claude Code's `-p --output-format stream-json --verbose --include-partial-messages` output (one JSON
 * object per line; fixture `fixtures/claude-read.jsonl`, captured from Claude Code 2.1.322) mapped to
 * normalized events:
 *
 * - `stream_event` → `content_block_delta` / `text_delta` → `text_delta`; `message_delta` (the message's
 *   token totals) → a cumulative `usage`.
 * - `assistant` (one complete content block per line) → `text` for a text block, `tool_use` for a tool
 *   call. Thinking blocks are skipped.
 * - `user` → `tool_result` for each tool result block.
 * - `result` → the final `usage` (with `total_cost_usd`); an error result also yields an `error`.
 * - `system`, `rate_limit_event` and anything unknown → nothing.
 */

const TOOL_NAMES: Record<string, ToolName> = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  LS: 'search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'shell',
  WebFetch: 'web',
  WebSearch: 'web',
};

export function claudeToolName(raw: string): ToolName {
  return TOOL_NAMES[raw] ?? `other:${raw}`;
}

/** Input tokens of a usage block: the uncached ones plus those written to and read from the cache. */
function inputTokens(usage: Record<string, unknown>): number {
  return num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
}

/** A tool result's text: the string itself, or the text blocks of an array. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRecord(b) && b.type === 'text' ? (str(b.text) ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function claudeAdapter(): Adapter {
  // Token totals of the messages already finished, plus the one being streamed.
  const done = { input: 0, output: 0 };
  let current = { input: 0, output: 0 };
  let lastText: string | null = null;
  let final: { result: string | null; usage: Usage; ok: boolean } | null = null;

  function cumulative(): Usage {
    return { input_tokens: done.input + current.input, output_tokens: done.output + current.output };
  }

  function onStreamEvent(event: Record<string, unknown>): RunEvent[] {
    switch (event.type) {
      case 'message_start': {
        done.input += current.input;
        done.output += current.output;
        const message = isRecord(event.message) ? event.message : {};
        const usage = isRecord(message.usage) ? message.usage : {};
        current = { input: inputTokens(usage), output: num(usage.output_tokens) };
        return [];
      }
      case 'content_block_delta': {
        const delta = isRecord(event.delta) ? event.delta : {};
        const text = delta.type === 'text_delta' ? str(delta.text) : null;
        return text ? [{ type: 'text_delta', text }] : [];
      }
      case 'message_delta': {
        const usage = isRecord(event.usage) ? event.usage : null;
        if (!usage) return [];
        current = { input: inputTokens(usage) || current.input, output: num(usage.output_tokens) };
        return [{ type: 'usage', ...cumulative() }];
      }
      default:
        return [];
    }
  }

  function onAssistant(obj: Record<string, unknown>): RunEvent[] {
    const message = isRecord(obj.message) ? obj.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const out: RunEvent[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text') {
        const text = str(block.text);
        if (text) {
          lastText = text;
          out.push({ type: 'text', text });
        }
      } else if (block.type === 'tool_use') {
        const id = str(block.id);
        const name = str(block.name);
        if (id && name) out.push({ type: 'tool_use', id, name: claudeToolName(name), input: truncateInput(block.input) });
      }
    }
    return out;
  }

  function onUser(obj: Record<string, unknown>): RunEvent[] {
    const message = isRecord(obj.message) ? obj.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const out: RunEvent[] = [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id);
      if (!id) continue;
      out.push({ type: 'tool_result', id, ok: block.is_error !== true, summary: clip(resultText(block.content)) });
    }
    return out;
  }

  function onResult(obj: Record<string, unknown>): RunEvent[] {
    const raw = isRecord(obj.usage) ? obj.usage : null;
    const usage: Usage = raw ? { input_tokens: inputTokens(raw), output_tokens: num(raw.output_tokens) } : cumulative();
    if (typeof obj.total_cost_usd === 'number' && Number.isFinite(obj.total_cost_usd)) usage.cost_usd = obj.total_cost_usd;
    const isError = obj.is_error === true || (typeof obj.subtype === 'string' && obj.subtype !== 'success');
    const result = str(obj.result);
    final = { result: result ?? lastText, usage, ok: !isError };
    const out: RunEvent[] = [{ type: 'usage', ...usage }];
    if (isError) {
      const message = result || (typeof obj.subtype === 'string' ? obj.subtype : 'error');
      const limited = obj.api_error_status === 429 || looksLikeLimit(message);
      out.push({ type: 'error', code: limited ? 'account_limited' : 'cli_failed', message: clip(message) });
    }
    return out;
  }

  return {
    parse(line) {
      const obj = parseJsonLine(line);
      if (!obj) return [];
      try {
        switch (obj.type) {
          case 'stream_event':
            return isRecord(obj.event) ? onStreamEvent(obj.event) : [];
          case 'assistant':
            return onAssistant(obj);
          case 'user':
            return onUser(obj);
          case 'result':
            return onResult(obj);
          default:
            return [];
        }
      } catch {
        return [];
      }
    },
    finish(): AdapterOutcome {
      if (final) return { result: final.result, usage: final.usage, ok: final.ok };
      const usage = cumulative();
      const any = usage.input_tokens > 0 || usage.output_tokens > 0;
      return { result: lastText, usage: any ? usage : null, ok: false };
    },
  };
}
