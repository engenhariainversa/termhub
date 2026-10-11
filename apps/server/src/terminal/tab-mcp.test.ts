import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TAB_ID_RE as PROTOCOL_TAB_ID_RE } from '@termhub/agent-protocol';
import { buildTabMcpRemoveScript, buildTabMcpWriteScript, shellQuote, TAB_ID_RE as OPS_TAB_ID_RE } from '@termhub/machine-ops';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';

const { agentRpc, requireAgentVersion, runOnMachineWithInput, info } = vi.hoisted(() => ({
  agentRpc: vi.fn(),
  requireAgentVersion: vi.fn(),
  runOnMachineWithInput: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../agent/errors.js', async (orig) => ({ ...(await orig<typeof import('../agent/errors.js')>()), agentRpc, requireAgentVersion }));
vi.mock('../agent/registry.js', () => ({ agents: { info } }));
vi.mock('./machine-exec.js', async (orig) => ({ ...(await orig<typeof import('./machine-exec.js')>()), runOnMachineWithInput }));

const { guardSupported, installTabMcp, removeTabMcp, tabMcpSupported, GUARD_MIN_AGENT_VERSION, TAB_MCP_MIN_AGENT_VERSION } = await import('./tab-mcp.js');

const machine = (type: Machine['type'], agent_version: string | null = null): Machine =>
  ({ id: 'm1', name: 'jarvis', type, os: 'linux', capabilities: ['tmux'], owner_id: 'u1', agent_version }) as Machine;
const BODY = '{"mcpServers":{"termhub_tab":{"headers":{"Authorization":"Bearer thb_pat_SECRET"}}}}';

beforeEach(() => {
  vi.resetAllMocks();
  info.mockReturnValue(null);
});

describe('tab id regex parity', () => {
  it('agent-protocol and machine-ops validate tab ids the same way', () => {
    expect(PROTOCOL_TAB_ID_RE.source).toBe(OPS_TAB_ID_RE.source);
    expect(PROTOCOL_TAB_ID_RE.flags).toBe(OPS_TAB_ID_RE.flags);
  });
});

describe('tabMcpSupported', () => {
  it('always for ssh and local machines', () => {
    expect(tabMcpSupported(machine('ssh'))).toBe(true);
    expect(tabMcpSupported(machine('local'))).toBe(true);
  });

  it('for an agent only from 0.10.0, the connected version winning over the stored one', () => {
    expect(TAB_MCP_MIN_AGENT_VERSION).toBe('0.10.0');
    expect(tabMcpSupported(machine('agent', '0.9.0'))).toBe(false);
    expect(tabMcpSupported(machine('agent', '0.10.0'))).toBe(true);
    expect(tabMcpSupported(machine('agent', null))).toBe(false);
    info.mockReturnValue({ agent_version: '0.10.1' });
    expect(tabMcpSupported(machine('agent', '0.9.0'))).toBe(true);
    info.mockReturnValue({ agent_version: '0.9.9' });
    expect(tabMcpSupported(machine('agent', '0.10.0'))).toBe(false);
  });
});

describe('installTabMcp', () => {
  it('goes through tab.mcp.write on an agent, after the version check', async () => {
    agentRpc.mockResolvedValue({ ok: true });
    await installTabMcp(machine('agent', '0.10.0'), 'abc', 'mcp.json', BODY);
    expect(requireAgentVersion).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), '0.10.0');
    expect(agentRpc).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'tab.mcp.write', { tab_id: 'abc', file: 'mcp.json', body: BODY });
    expect(runOnMachineWithInput).not.toHaveBeenCalled();
  });

  it('lets an outdated agent fail before any rpc', async () => {
    requireAgentVersion.mockImplementation(() => {
      throw new HttpError(409, 'Atualize o agente', 'AGENT_OUTDATED');
    });
    await expect(installTabMcp(machine('agent'), 'abc', 'token', 'thb_pat_SECRET')).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(agentRpc).not.toHaveBeenCalled();
  });

  it('on ssh sends the body on stdin and only the script, run by sh whatever the login shell, as the remote command', async () => {
    runOnMachineWithInput.mockResolvedValue({ code: 0, stdout: 'ok\n', stderr: '', timedOut: false });
    await installTabMcp(machine('ssh'), 'abc', 'token', 'thb_pat_SECRET');
    const script = buildTabMcpWriteScript('abc', 'token');
    expect(runOnMachineWithInput).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), { file: 'sh', args: ['-c', script] }, `sh -c ${shellQuote(script)}`, Buffer.from('thb_pat_SECRET'), 10_000);
    const [, local, remote] = runOnMachineWithInput.mock.calls[0];
    expect(JSON.stringify(local) + remote).not.toContain('thb_pat_');
  });

  it('throws when the script did not print ok (and never echoes the body)', async () => {
    runOnMachineWithInput.mockResolvedValue({ code: 1, stdout: '', stderr: 'mkdir: permission denied', timedOut: false });
    const err = await installTabMcp(machine('local'), 'abc', 'token', 'thb_pat_SECRET').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain('thb_pat_');
  });

  it('refuses a tab id that is not one of ours before reaching the machine', async () => {
    await expect(installTabMcp(machine('ssh'), '../x', 'token', 'b')).rejects.toThrow();
    await expect(installTabMcp(machine('agent', '0.10.0'), '../x', 'token', 'b')).rejects.toThrow();
    expect(runOnMachineWithInput).not.toHaveBeenCalled();
    expect(agentRpc).not.toHaveBeenCalled();
  });
});

describe('removeTabMcp', () => {
  it('goes through tab.mcp.remove on an agent of 0.10.0+', async () => {
    agentRpc.mockResolvedValue({ ok: true });
    await removeTabMcp(machine('agent', '0.10.0'), 'abc');
    expect(agentRpc).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'tab.mcp.remove', { tab_id: 'abc' });
  });

  it('skips an agent older than 0.10.0 without calling it', async () => {
    await removeTabMcp(machine('agent', '0.9.0'), 'abc');
    expect(agentRpc).not.toHaveBeenCalled();
  });

  it('runs the remove script on ssh', async () => {
    runOnMachineWithInput.mockResolvedValue({ code: 0, stdout: 'ok\n', stderr: '', timedOut: false });
    await removeTabMcp(machine('ssh'), 'abc');
    const script = buildTabMcpRemoveScript('abc');
    expect(runOnMachineWithInput).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), { file: 'sh', args: ['-c', script] }, `sh -c ${shellQuote(script)}`, Buffer.alloc(0), 10_000);
  });

  it('swallows every failure', async () => {
    agentRpc.mockRejectedValue(new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE'));
    await expect(removeTabMcp(machine('agent', '0.10.0'), 'abc')).resolves.toBeUndefined();
    runOnMachineWithInput.mockRejectedValue(new Error('ssh down'));
    await expect(removeTabMcp(machine('ssh'), 'abc')).resolves.toBeUndefined();
    await expect(removeTabMcp(machine('ssh'), '../x')).resolves.toBeUndefined();
  });
});

describe('guardSupported (TER-993)', () => {
  it('never for ssh or local (they do not run automatic work), for an agent only from 0.19.0', () => {
    expect(GUARD_MIN_AGENT_VERSION).toBe('0.19.0');
    expect(guardSupported(machine('ssh'))).toBe(false);
    expect(guardSupported(machine('local'))).toBe(false);
    expect(guardSupported(machine('agent', '0.18.0'))).toBe(false);
    expect(guardSupported(machine('agent', '0.19.0'))).toBe(true);
    expect(guardSupported(machine('agent', null))).toBe(false);
    info.mockReturnValue({ agent_version: '0.19.0' });
    expect(guardSupported(machine('agent', '0.18.0'))).toBe(true);
    info.mockReturnValue({ agent_version: '0.18.9' });
    expect(guardSupported(machine('agent', '0.19.0'))).toBe(false);
  });
});
