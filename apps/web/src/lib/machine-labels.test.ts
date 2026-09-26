import { describe, expect, it } from 'vitest';
import { agentVersionBadge, machineLabel, machineTitle } from './machine-labels';
import type { Machine } from './types';

function agentMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 'm1',
    name: 'mini',
    host: null,
    ssh_user: null,
    ssh_port: 22,
    type: 'agent',
    os: 'macos',
    capabilities: ['tmux'],
    checked_at: null,
    agent_version: '0.1.0',
    agent_last_seen_at: new Date(Date.now() - 3 * 60_000).toISOString(),
    agent_auto_update: false,
    claude_auto_swap: false,
    is_local: false,
    owner_id: 'u1',
    owner_name: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('machineTitle', () => {
  it('says "visto há N min" once for an offline agent (relativeTime already carries the "há")', () => {
    const title = machineTitle(agentMachine(), 'offline');
    expect(title).toBe('agente · macos · tmux · visto há 3 min');
    expect(title).not.toContain('há há');
  });

  it('omits the last-seen part while the agent is online', () => {
    expect(machineTitle(agentMachine(), 'online')).toBe('agente · macos · tmux');
  });

  it('names the user\'s own computer', () => {
    expect(machineTitle(agentMachine({ is_local: true }), 'online')).toBe('este computador (agente) · macos · tmux');
  });

  it('describes ssh machines by user@host:port', () => {
    const m = agentMachine({ type: 'ssh', host: 'box', ssh_user: 'pedro', ssh_port: 2222, os: null, capabilities: [] });
    expect(machineTitle(m, 'online')).toBe('pedro@box:2222');
  });
});

describe('agentVersionBadge', () => {
  it('shows the version, and marks it when a newer agent is available', () => {
    expect(agentVersionBadge(agentMachine({ agent_version: '0.2.1' }))).toEqual({ text: 'v0.2.1', title: 'agente v0.2.1', outdated: false });
    expect(agentVersionBadge(agentMachine({ agent_version: '0.2.1', update_available: true }))).toEqual({ text: 'v0.2.1 ↑', title: 'Nova versão do agente disponível — abra a máquina para atualizar', outdated: true });
  });
  it('is null without a reported version or for non-agent machines', () => {
    expect(agentVersionBadge(agentMachine({ agent_version: null }))).toBeNull();
    expect(agentVersionBadge(agentMachine({ type: 'ssh', host: 'h' }))).toBeNull();
  });
});

describe('machineLabel', () => {
  it('reads "nome — subtítulo" when the machine has a subtitle, and the name alone otherwise', () => {
    expect(machineLabel({ name: 'mini', subtitle: 'MacBook do escritório' })).toBe('mini — MacBook do escritório');
    expect(machineLabel({ name: 'mini', subtitle: null })).toBe('mini');
    expect(machineLabel({ name: 'mini' })).toBe('mini');
  });
});
