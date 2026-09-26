import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeLinkScript } from '@termhub/machine-ops';

const { rpc, info, runOnMachine } = vi.hoisted(() => ({ rpc: vi.fn(), info: vi.fn(), runOnMachine: vi.fn() }));
vi.mock('../agent/registry.js', () => ({ agents: { rpc, info }, AgentOfflineError: class extends Error {} }));
vi.mock('../terminal/machine-exec.js', () => ({ runOnMachine }));

import type { Machine } from '../db/repositories/types.js';
import { ControlError } from '../control/context.js';
import { CLAUDE_LINK_MIN_AGENT_VERSION, linkClaudeSession } from './claude-session.js';

const SID = '6d127d73-4bd0-42d6-b4a6-d96899507e62';
const PATH = `/home/p/.claude/projects/-src-app/${SID}.jsonl`;
const machine = (type: Machine['type']) => ({ id: 'm1', name: 'jarvis', type, capabilities: ['tmux', 'claude'], owner_id: 'u1' }) as unknown as Machine;
const input = { transcriptPath: PATH, sessionId: SID, configDir: '~/.claude_b' };

beforeEach(() => {
  vi.clearAllMocks();
  info.mockReturnValue({ agent_version: '0.7.0' });
});

describe('linkClaudeSession', () => {
  it('needs agent 0.7.0', () => {
    expect(CLAUDE_LINK_MIN_AGENT_VERSION).toBe('0.7.0');
  });

  it('asks the agent through claude.linkSession and returns its status', async () => {
    rpc.mockResolvedValue({ status: 'linked' });
    await expect(linkClaudeSession(machine('agent'), input)).resolves.toBe('linked');
    expect(rpc).toHaveBeenCalledWith('m1', 'claude.linkSession', { transcript_path: PATH, session_id: SID, config_dir: '~/.claude_b' });
    expect(runOnMachine).not.toHaveBeenCalled();
  });

  it('refuses an agent older than 0.7.0 without calling it', async () => {
    info.mockReturnValue({ agent_version: '0.5.2' });
    await expect(linkClaudeSession(machine('agent'), input)).rejects.toMatchObject({ statusCode: 409, code: 'AGENT_OUTDATED' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('runs the link script over ssh and parses its answer', async () => {
    runOnMachine.mockResolvedValue({ code: 0, stdout: 'linked\n', stderr: '', timedOut: false });
    const m = machine('ssh');
    await expect(linkClaudeSession(m, { ...input, configDir: null })).resolves.toBe('linked');
    const script = claudeLinkScript(PATH, SID, null);
    expect(runOnMachine).toHaveBeenCalledWith(m, { file: '/bin/sh', args: ['-c', script] }, script, 10000);
  });

  it('LINK_FAILED when the machine timed out or answered something else', async () => {
    runOnMachine.mockResolvedValueOnce({ code: null, stdout: 'linked\n', stderr: '', timedOut: true });
    await expect(linkClaudeSession(machine('ssh'), input)).rejects.toMatchObject({ code: 'LINK_FAILED' });
    runOnMachine.mockResolvedValueOnce({ code: 0, stdout: 'sh: not found\n', stderr: '', timedOut: false });
    const err = await linkClaudeSession(machine('ssh'), input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlError);
    expect(err).toMatchObject({ code: 'LINK_FAILED' });
  });
});
