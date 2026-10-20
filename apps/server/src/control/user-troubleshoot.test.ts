import { describe, expect, it, vi } from 'vitest';

vi.mock('../agent/registry.js', () => ({
  agents: { isOnline: (id: string) => id !== 'm-off', info: (id: string) => (id === 'm-on' ? { agent_version: '0.30.1' } : undefined) },
}));

import type { HooksStatus } from '@termhub/machine-ops';
import type { Repositories } from '../db/repositories/index.js';
import type { SecurityEventInput } from '../db/repositories/security-events.js';
import type { ControlContext } from './context.js';
import { invalidatePermissionCache } from '../auth/permissions.js';
import { troubleshoot, troubleshootTool, troubleshootWindow } from './user-troubleshoot.js';

const machine = (id: string, type: 'agent' | 'ssh') => ({ id, name: `Máquina ${id}`, type, os: 'macos', host: 'host.interno', agent_version: '0.29.0', agent_last_seen_at: null, agent_auto_update: true });

const STATUS: HooksStatus = {
  script: { installed: true, version: 'abc', expected_version: 'abc', outdated: false },
  claude: { present: true, state: 'current', dirs: [{ dir: '/Users/humberto/.claude', state: 'current' }] },
  codex: { present: true, state: 'missing', notify: false, trusted: null },
  cursor: { present: false, state: 'missing' },
};

function reposWith(recorded: SecurityEventInput[], adminRole = true) {
  return {
    roles: { findById: async (id: string) => ({ id, is_admin: adminRole }), permissionsOf: async () => [] },
    support: { findUser: async (id: string) => (id === 'u1' ? { id, name: 'Humberto' } : undefined), searchUsers: async () => [] },
    securityEvents: { record: async (e: SecurityEventInput) => void recorded.push(e) },
    machines: { list: async () => [machine('m-on', 'agent'), machine('m-off', 'agent'), machine('m-ssh', 'ssh'), machine('m-slow', 'agent')] },
    machineHooks: { installedAtByMachine: async () => ({ 'm-on': '2026-10-01T00:00:00.000Z' }) },
  } as unknown as Repositories;
}

describe('troubleshootWindow', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  it('defaults to the last 12 hours and accepts up to 7 days', () => {
    expect(troubleshootWindow({}, now)).toEqual({ from: new Date('2026-10-20T00:00:00Z'), to: now });
    expect(troubleshootWindow({ from: new Date('2026-10-13T12:00:00Z') }, now).from).toEqual(new Date('2026-10-13T12:00:00Z'));
  });
  it('refuses a longer or reversed window', () => {
    expect(() => troubleshootWindow({ from: new Date('2026-10-13T11:59:59Z') }, now)).toThrow(expect.objectContaining({ code: 'WINDOW_TOO_LONG' }));
    expect(() => troubleshootWindow({ from: now, to: now })).toThrow(expect.objectContaining({ code: 'INVALID_WINDOW' }));
  });
});

describe('machines view', () => {
  it('reads the hooks live from online agents only, without config dirs, and survives one that does not answer', async () => {
    const recorded: SecurityEventInput[] = [];
    const readHooks = vi.fn(async (m: { id: string }) => {
      if (m.id === 'm-slow') throw Object.assign(new Error('x'), { code: 'AGENT_OUTDATED' });
      return STATUS;
    });
    const out = (await troubleshoot({ repos: reposWith(recorded), readHooks: readHooks as never }, { id: 'adm', email: 'a@x.dev', ip: null, via: 'api' }, { endpoint: 'machines', user_id: 'u1', reason: 'TER-1091' })) as {
      machines: Array<{ machine_id: string; online: boolean | null; agent_version: string | null; hooks: Record<string, unknown> }>;
    };
    expect(readHooks.mock.calls.map(([m]) => m.id)).toEqual(['m-on', 'm-slow']);
    const byId = Object.fromEntries(out.machines.map((m) => [m.machine_id, m]));
    expect(byId['m-on']).toMatchObject({ online: true, agent_version: '0.30.1', hooks: { read: 'live', installed_at: '2026-10-01T00:00:00.000Z', claude: { present: true, state: 'current' } } });
    expect(byId['m-off']).toMatchObject({ online: false, agent_version: '0.29.0', hooks: { read: 'offline' } });
    expect(byId['m-ssh']).toMatchObject({ online: null, hooks: { read: 'not_agent' } });
    expect(byId['m-slow']!.hooks).toMatchObject({ read: 'unanswered', error_code: 'AGENT_OUTDATED' });
    const body = JSON.stringify(out);
    expect(body).not.toContain('/Users/humberto');
    expect(body).not.toContain('host.interno');
    expect(recorded).toHaveLength(1);
  });
});

describe('troubleshootTool (MCP)', () => {
  const ctxOf = (repos: Repositories, roleId: string) => ({ repos, scope: { user: { id: 'adm', email: 'a@x.dev', role_id: roleId } } }) as unknown as ControlContext;

  it('audits the call as coming from the MCP', async () => {
    invalidatePermissionCache();
    const recorded: SecurityEventInput[] = [];
    await troubleshootTool(ctxOf(reposWith(recorded), 'r-adm-tool'), { endpoint: 'search', query: 'hum', reason: 'TER-1091' });
    expect(recorded).toEqual([expect.objectContaining({ action: 'support.troubleshoot', actor_id: 'adm', meta: { endpoint: 'search', reason: 'TER-1091', via: 'mcp', found: [] } })]);
  });

  it('refuses a non-admin even if the tool were called, and writes nothing', async () => {
    invalidatePermissionCache();
    const recorded: SecurityEventInput[] = [];
    await expect(troubleshootTool(ctxOf(reposWith(recorded, false), 'r-mem-tool'), { endpoint: 'search', query: 'hum', reason: 'TER-1091' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(recorded).toEqual([]);
  });

  it('asks for a user_id on a user endpoint', async () => {
    invalidatePermissionCache();
    await expect(troubleshootTool(ctxOf(reposWith([]), 'r-adm-tool2'), { endpoint: 'tabs', reason: 'TER-1091' })).rejects.toMatchObject({ code: 'USER_REQUIRED' });
  });
});
