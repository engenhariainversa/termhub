import { describe, expect, it } from 'vitest';
import { buildCodexExecArgs, buildHeadlessArgs, classifyHeadlessFailure, EMPTY_MCP_CONFIG } from './index.js';

describe('buildHeadlessArgs', () => {
  it('headless claude: closed tool list, no MCP, no session', () => {
    expect(buildHeadlessArgs({ tools: ['Read', 'Grep', 'Glob'], model: 'sonnet', settingsPath: null, mcpConfigPath: '/t/mcp.json' })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence',
      '--mcp-config', '/t/mcp.json', '--strict-mcp-config',
      '--tools', 'Read,Grep,Glob', '--allowed-tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk',
      '--model', 'sonnet',
    ]);
  });

  it('adds the guard settings when given, and no --model without one', () => {
    expect(buildHeadlessArgs({ tools: ['Read', 'Edit'], model: null, settingsPath: '/t/guard.json', mcpConfigPath: '/t/mcp.json' })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence',
      '--mcp-config', '/t/mcp.json', '--strict-mcp-config',
      '--tools', 'Read,Edit', '--allowed-tools', 'Read,Edit', '--permission-mode', 'dontAsk',
      '--settings', '/t/guard.json',
    ]);
  });

  it('keeps an empty tool list as an explicit empty --tools, never dropping the flag', () => {
    const args = buildHeadlessArgs({ tools: [], model: null, settingsPath: null, mcpConfigPath: '/t/mcp.json' });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
  });

  it('the empty MCP config names no server', () => {
    expect(JSON.parse(EMPTY_MCP_CONFIG)).toEqual({ mcpServers: {} });
  });
});

describe('buildCodexExecArgs', () => {
  it('codex exec: prompt from stdin, sandbox, ephemeral', () => {
    expect(buildCodexExecArgs({ cwd: '/w', sandbox: 'read-only', model: null })).toEqual(
      ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-C', '/w', '-s', 'read-only', '-']);
  });

  it('passes the model before the stdin marker', () => {
    expect(buildCodexExecArgs({ cwd: '/w', sandbox: 'workspace-write', model: 'gpt-5.5' })).toEqual(
      ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-C', '/w', '-s', 'workspace-write', '-m', 'gpt-5.5', '-']);
  });
});

describe('classifyHeadlessFailure', () => {
  it.each([
    "Claude AI usage limit reached|1760000000",
    "You've hit your limit · resets 3pm",
    'stream error: unexpected status 429 Too Many Requests',
    'ERROR: You have exceeded your quota',
    'rate_limit_error',
  ])('reads %j as the account limit', (stderr) => expect(classifyHeadlessFailure(stderr)).toBe('usage_limit'));

  it('anything else is a plain failure', () => {
    expect(classifyHeadlessFailure('Error: something broke')).toBe('run_failed');
    expect(classifyHeadlessFailure('')).toBe('run_failed');
  });
});
