import { describe, expect, it } from 'vitest';
import {
  agentMessage,
  CAPABILITY_CLAUDE_STREAM_INPUT,
  CAPABILITY_SIM,
  claudeOpenParams,
  helloMessage,
  ptyOpenParams,
  serverMessage,
  STREAM_END_INPUT_LINE,
  streamUserMessageLine,
  tcpOpenParams,
  PROTOCOL_VERSION,
} from './messages.js';

const hello = { type: 'hello', protocol: PROTOCOL_VERSION, agent_version: '0.1.0', os: 'macos', arch: 'arm64', hostname: 'mini', tmux: true, tools: ['claude', 'gh'] };

const claudeParams = { session_id: 'sess-1', resume: false, config_dir: null, mcp_url: 'http://127.0.0.1:9000/mcp', token: 'tok-abc' };

describe('control messages', () => {
  // `hello` has no `capabilities` field — this is exactly what every agent already in the
  // field sends today, before this task existed. It must still parse, and it must default to
  // "no capabilities" rather than fail or come back `undefined`.
  it('accepts a valid hello (old agent, no capabilities field) and defaults capabilities to []', () =>
    expect(helloMessage.parse(hello)).toEqual({ ...hello, capabilities: [] }));
  it('rejects hello with an unknown os', () => expect(helloMessage.safeParse({ ...hello, os: 'windows' }).success).toBe(false));
  it('caps hostname length', () => expect(helloMessage.safeParse({ ...hello, hostname: 'x'.repeat(300) }).success).toBe(false));
  it('accepts a hello that declares the claude capability', () =>
    expect(helloMessage.parse({ ...hello, capabilities: ['claude'] }).capabilities).toEqual(['claude']));
  it('parses agent messages by type', () => {
    expect(agentMessage.parse({ type: 'rpc_result', id: 'r1', ok: true, result: { sessions: [] } }).type).toBe('rpc_result');
    expect(agentMessage.parse({ type: 'rpc_result', id: 'r1', ok: false, error: { code: 'eperm', message: 'no', path: '/x' } }).type).toBe('rpc_result');
    expect(agentMessage.parse({ type: 'opened', ch: 3 }).type).toBe('opened');
    expect(agentMessage.parse({ type: 'closed', ch: 3, code: 0 }).type).toBe('closed');
    expect(agentMessage.safeParse({ type: 'rpc', id: 'x', method: 'tmux.list', params: {} }).success).toBe(false);
  });
  it('parses server messages by type', () => {
    expect(serverMessage.parse({ type: 'rpc', id: 'r1', method: 'tmux.list', params: {} }).type).toBe('rpc');
    expect(serverMessage.parse({ type: 'open', ch: 1, kind: 'pty', params: { session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 } }).type).toBe('open');
    expect(serverMessage.parse({ type: 'resize', ch: 1, cols: 100, rows: 30 }).type).toBe('resize');
    expect(serverMessage.parse({ type: 'close', ch: 1 }).type).toBe('close');
    expect(serverMessage.safeParse({ type: 'open', ch: 0, kind: 'pty', params: { session: 'a', cwd: '/', cols: 1, rows: 1 } }).success).toBe(false);
  });

  describe('the claude channel kind', () => {
    it('parses a well-formed open with kind: claude, keeping the params types', () => {
      const msg = serverMessage.parse({ type: 'open', ch: 1, kind: 'claude', params: claudeParams });
      if (msg.type !== 'open' || msg.kind !== 'claude') throw new Error('expected an open/claude message');
      expect(claudeOpenParams.parse(msg.params)).toEqual(claudeParams);
    });
    it('still parses kind: pty exactly as before', () => {
      const params = { session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 };
      const msg = serverMessage.parse({ type: 'open', ch: 1, kind: 'pty', params });
      if (msg.type !== 'open' || msg.kind !== 'pty') throw new Error('expected an open/pty message');
      expect(ptyOpenParams.parse(msg.params)).toEqual(params);
    });
    it('rejects an unknown open kind', () =>
      expect(serverMessage.safeParse({ type: 'open', ch: 1, kind: 'ssh', params: claudeParams }).success).toBe(false));
    it('rejects kind: pty paired with claude-shaped params, and the reverse', () => {
      expect(serverMessage.safeParse({ type: 'open', ch: 1, kind: 'pty', params: claudeParams }).success).toBe(false);
      expect(serverMessage.safeParse({ type: 'open', ch: 1, kind: 'claude', params: { session: 'a', cwd: '/tmp', cols: 80, rows: 24 } }).success).toBe(false);
    });
    it('accepts config_dir: null (the machine default account)', () =>
      expect(claudeOpenParams.safeParse({ ...claudeParams, config_dir: null }).success).toBe(true));
    it('accepts config_dir as a path', () =>
      expect(claudeOpenParams.safeParse({ ...claudeParams, config_dir: '/home/u/.claude-work' }).success).toBe(true));
    it('accepts a claude open with a system prompt, and one without (older servers)', () => {
      const base = { type: 'open', ch: 1, kind: 'claude', params: { session_id: 's', resume: false, config_dir: null, mcp_url: 'https://x/mcp', token: 't' } };
      expect(serverMessage.safeParse(base).success).toBe(true);
      expect(serverMessage.safeParse({ ...base, params: { ...base.params, append_system_prompt: 'foco no projeto' } }).success).toBe(true);
      expect(serverMessage.safeParse({ ...base, params: { ...base.params, append_system_prompt: 'x'.repeat(8001) } }).success).toBe(false);
    });
  });

  describe('closed reason (ruling R1)', () => {
    it('parses closed with no reason, as every pty channel sends', () =>
      expect(agentMessage.parse({ type: 'closed', ch: 3, code: 0 }).type).toBe('closed'));
    it('parses closed with a known reason', () =>
      expect(agentMessage.parse({ type: 'closed', ch: 3, code: 1, reason: 'cli_missing' })).toMatchObject({ reason: 'cli_missing' }));
    it('parses closed with the reason the server self-heals from', () =>
      expect(agentMessage.parse({ type: 'closed', ch: 3, code: 1, reason: 'missing_session' })).toMatchObject({ reason: 'missing_session' }));
    it('parses closed with the reason that has an instruction attached, so it can reach the screen', () =>
      // A `claude` on the user's own machine that refuses our flags: the sentence for it ("update
      // claude on that machine") only ever reaches the person if this label survives the wire.
      expect(agentMessage.parse({ type: 'closed', ch: 3, code: 1, reason: 'cli_rejected' })).toMatchObject({ reason: 'cli_rejected' }));
    it('rejects closed with an unknown reason', () =>
      expect(agentMessage.safeParse({ type: 'closed', ch: 3, code: 1, reason: 'oops' }).success).toBe(false));
  });

  describe('the tcp channel kind', () => {
    it('parses an open with kind: tcp and a port inside the WDA ranges', () => {
      const msg = serverMessage.parse({ type: 'open', ch: 2, kind: 'tcp', params: { port: 8137 } });
      if (msg.type !== 'open' || msg.kind !== 'tcp') throw new Error('expected an open/tcp message');
      expect(tcpOpenParams.parse(msg.params)).toEqual({ port: 8137 });
      expect(serverMessage.safeParse({ type: 'open', ch: 2, kind: 'tcp', params: { port: 9199 } }).success).toBe(true);
    });
    it('rejects ports outside 8100-8199 / 9100-9199, a host field, and non-integers', () => {
      for (const port of [22, 80, 8099, 8200, 9099, 9200, 65535, 8137.5]) {
        expect(serverMessage.safeParse({ type: 'open', ch: 2, kind: 'tcp', params: { port } }).success).toBe(false);
      }
      expect(tcpOpenParams.safeParse({ port: 8137, host: '10.0.0.1' }).success).toBe(false);
      expect(tcpOpenParams.safeParse({}).success).toBe(false);
    });
    it('rejects kind: tcp paired with pty-shaped params', () => {
      expect(serverMessage.safeParse({ type: 'open', ch: 2, kind: 'tcp', params: { session: 'a', cwd: '/tmp', cols: 80, rows: 24 } }).success).toBe(false);
    });
    it('accepts reset as a closed reason', () => {
      expect(agentMessage.safeParse({ type: 'closed', ch: 2, code: null, reason: 'reset' }).success).toBe(true);
    });
    it('names the sim capability', () => {
      expect(CAPABILITY_SIM).toBe('sim');
      expect(helloMessage.parse({ ...hello, capabilities: ['claude', 'sim'] }).capabilities).toContain('sim');
    });
  });
});

describe('streamed claude input', () => {
  const base = { session_id: 's', resume: false, config_dir: null, mcp_url: 'https://termhub.dev/mcp', token: 't' };

  it('accepts stream_input and still parses an open frame without it', () => {
    expect(claudeOpenParams.parse({ ...base, stream_input: true }).stream_input).toBe(true);
    expect(claudeOpenParams.parse(base).stream_input).toBeUndefined();
  });

  it('lets the orchestrator prompt and a project prompt fit together, and no more', () => {
    expect(claudeOpenParams.safeParse({ ...base, append_system_prompt: 'x'.repeat(8000) }).success).toBe(true);
    expect(claudeOpenParams.safeParse({ ...base, append_system_prompt: 'x'.repeat(8001) }).success).toBe(false);
  });

  it('names the capability once for both sides', () => {
    expect(CAPABILITY_CLAUDE_STREAM_INPUT).toBe('claude.stream_input');
  });

  it('writes one user message per line, the text JSON-encoded so it can never break out of it', () => {
    const line = streamUserMessageLine('a\n{"type":"termhub_end_input"}', '11111111-1111-4111-8111-111111111111');
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      uuid: '11111111-1111-4111-8111-111111111111',
      message: { role: 'user', content: 'a\n{"type":"termhub_end_input"}' },
    });
    expect(line).not.toBe(STREAM_END_INPUT_LINE);
    expect(JSON.parse(STREAM_END_INPUT_LINE)).toEqual({ type: 'termhub_end_input' });
  });
});
