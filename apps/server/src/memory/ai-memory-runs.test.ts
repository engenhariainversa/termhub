import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({ config: {} }));
import { aiMemoryForRun, aiMemoryMcpConfig, aiMemoryMcpUrl, withAiMemoryServer } from './ai-memory-runs.js';

const on = { publish_rules: false, use_in_runs: true };
const off = { publish_rules: true, use_in_runs: false };
const machine = (over: { ai_memory_enabled?: boolean; ai_memory_url?: string | null } = {}) => ({ ai_memory_enabled: true, ai_memory_url: null, ...over });

describe('aiMemoryForRun (TER-1020)', () => {
  it('needs both the project and the machine to opt in', () => {
    expect(aiMemoryForRun(on, machine(), 'claude')).toEqual({ mcpUrl: 'http://127.0.0.1:49374/mcp', serverUrl: 'http://127.0.0.1:49374' });
    expect(aiMemoryForRun(off, machine(), 'claude')).toBeNull();
    expect(aiMemoryForRun(on, machine({ ai_memory_enabled: false }), 'claude')).toBeNull();
  });

  it('wires only Claude Code and Codex: Antigravity and Gemini CLI are left alone', () => {
    expect(aiMemoryForRun(on, machine(), 'chatgpt')).not.toBeNull();
    expect(aiMemoryForRun(on, machine(), 'gemini')).toBeNull();
    expect(aiMemoryForRun(on, machine(), 'antigravity')).toBeNull();
  });
});

describe('aiMemoryMcpUrl', () => {
  it("is the machine's server URL plus /mcp", () => {
    expect(aiMemoryMcpUrl(machine())).toBe('http://127.0.0.1:49374/mcp');
    expect(aiMemoryMcpUrl(machine({ ai_memory_url: 'http://10.0.0.2:7000/' }))).toBe('http://10.0.0.2:7000/mcp');
  });
});

describe('the Claude MCP config', () => {
  it('holds the ai-memory server alone, or added to the tab config with its token kept', () => {
    expect(JSON.parse(aiMemoryMcpConfig('http://127.0.0.1:1/mcp'))).toEqual({ mcpServers: { ai_memory: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } });
    const tab = JSON.stringify({ mcpServers: { termhub_tab: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } } } });
    expect(JSON.parse(withAiMemoryServer(tab, 'http://127.0.0.1:1/mcp')).mcpServers).toEqual({
      termhub_tab: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } },
      ai_memory: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
    });
  });
});
