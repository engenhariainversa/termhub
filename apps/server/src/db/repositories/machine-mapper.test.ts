import { describe, expect, it } from 'vitest';
import type { Machine as PrismaMachine } from '../../generated/prisma/client.js';
import { mapMachine } from './types.js';

const row = (over: Partial<PrismaMachine> = {}): PrismaMachine =>
  ({
    id: 'm1', name: 'mac', subtitle: null, host: null, sshUser: null, sshPort: 22, type: 'agent', os: null, capabilities: [], checkedAt: null,
    agentTokenHash: null, agentTokenCreatedAt: null, agentPairingHash: null, agentPairingExpiresAt: null, agentPublicKey: null, agentPairedAt: null, agentVersion: null, agentLastSeenAt: null, agentAutoUpdate: false, claudeAutoSwap: true, aiUsageQuery: true, automationAllowed: true, isLocal: false,
    ownerId: 'u1', createdAt: new Date('2026-09-24T00:00:00.000Z'), ...over,
  }) as PrismaMachine;

describe('mapMachine', () => {
  it('carries the subtitle, or null when there is none', () => {
    expect(mapMachine(row({ subtitle: 'MacBook do escritório' })).subtitle).toBe('MacBook do escritório');
    expect(mapMachine(row()).subtitle).toBeNull();
  });

  // city-by-project §2.3: nothing on the street is a machine any more, so a machine has no public id
  it('carries no public id', () => {
    expect('public_id' in mapMachine(row())).toBe(false);
  });

  // TER-1017: which credential the agent proves itself with, never the key or hash themselves
  it('says which credential the agent uses without carrying it', () => {
    expect(mapMachine(row({ agentPublicKey: 'MCowBQ…' })).agent_credential).toBe('key');
    expect(mapMachine(row({ agentTokenHash: 'abc' })).agent_credential).toBe('bearer');
    expect(mapMachine(row({ agentPairingHash: 'abc' })).agent_credential).toBeNull();
    const json = JSON.stringify(mapMachine(row({ agentPublicKey: 'MCowBQ-key', agentTokenHash: 'hash-x' })));
    expect(json).not.toContain('MCowBQ-key');
    expect(json).not.toContain('hash-x');
  });
});
