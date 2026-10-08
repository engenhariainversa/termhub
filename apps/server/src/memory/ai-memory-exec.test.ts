import { buildAiMemoryRulesScript, shellQuote } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../db/repositories/types.js';

const { agentRpc, runOnMachineWithInput, isOnline, info } = vi.hoisted(() => ({
  agentRpc: vi.fn(),
  runOnMachineWithInput: vi.fn(),
  isOnline: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../agent/errors.js', async (orig) => ({ ...(await orig<typeof import('../agent/errors.js')>()), agentRpc }));
vi.mock('../agent/registry.js', () => ({ agents: { isOnline, info } }));
vi.mock('../terminal/machine-exec.js', async (orig) => ({ ...(await orig<typeof import('../terminal/machine-exec.js')>()), runOnMachineWithInput }));

const { machineAiMemoryExec, AI_MEMORY_MIN_AGENT_VERSION } = await import('./ai-memory-sync.js');

const machine = (type: Machine['type'], agent_version: string | null = null): Machine => ({ id: `m-${type}`, type, host: 'h', ssh_user: null, ssh_port: 22, agent_version }) as Machine;
const input = { cwd: '/srv/repo', server_url: 'http://127.0.0.1:49374', writes: [{ path: '_rules/termhub-a-a1.md', title: "it's", body: 'b' }], deletes: [] };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('machineAiMemoryExec', () => {
  it('reach: ssh/local always; an agent only online and at or above the minimum version', () => {
    expect(machineAiMemoryExec.reach(machine('ssh'))).toBe('ok');
    isOnline.mockReturnValue(false);
    expect(machineAiMemoryExec.reach(machine('agent', '0.27.0'))).toBe('AGENT_OFFLINE');
    isOnline.mockReturnValue(true);
    info.mockReturnValue({ agent_version: '0.26.0' });
    expect(machineAiMemoryExec.reach(machine('agent'))).toBe('AGENT_OUTDATED');
    info.mockReturnValue({ agent_version: AI_MEMORY_MIN_AGENT_VERSION });
    expect(machineAiMemoryExec.reach(machine('agent'))).toBe('ok');
  });

  it('an agent machine goes through the ai_memory.rules.sync RPC', async () => {
    agentRpc.mockResolvedValue({ stdout: 'skip no_marker\n' });
    await expect(machineAiMemoryExec.sync(machine('agent'), input)).resolves.toBe('skip no_marker\n');
    expect(agentRpc).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent' }), 'ai_memory.rules.sync', input);
  });

  it('an ssh machine runs the script through sh -c, quoted', async () => {
    runOnMachineWithInput.mockResolvedValue({ code: 0, stdout: 'ok briefing\n', stderr: '', timedOut: false });
    await expect(machineAiMemoryExec.sync(machine('ssh'), input)).resolves.toBe('ok briefing\n');
    const script = buildAiMemoryRulesScript(input);
    expect(runOnMachineWithInput).toHaveBeenCalledWith(expect.anything(), { file: 'sh', args: ['-c', script] }, `sh -c ${shellQuote(script)}`, expect.any(Buffer), expect.any(Number));
  });

  it('an unreachable ssh machine or a timeout throws with a code', async () => {
    runOnMachineWithInput.mockResolvedValue({ code: 255, stdout: '', stderr: '', timedOut: false });
    await expect(machineAiMemoryExec.sync(machine('ssh'), input)).rejects.toMatchObject({ code: 'MACHINE_UNREACHABLE' });
    runOnMachineWithInput.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(machineAiMemoryExec.sync(machine('ssh'), input)).rejects.toMatchObject({ code: 'MACHINE_TIMEOUT' });
  });
});
