import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapMachine, type Machine, type MachineType } from './types.js';

export interface MachineInput {
  name: string;
  subtitle?: string | null;
  type: MachineType;
  host?: string | null;
  ssh_user?: string | null;
  ssh_port?: number;
  is_local?: boolean;
  owner_id?: string | null;
  agent_auto_update?: boolean;
  claude_auto_swap?: boolean;
}

/** Visibility filter: a user id, or null for everything (admin "all" view). */
export type OwnerScope = string | null;
const ownerWhere = (owner: OwnerScope) => (owner === null ? {} : { ownerId: owner });
const withOwner = { owner: { select: { name: true } } } as const;

export class MachinesRepository {
  constructor(private db: PrismaClient) {}

  async list(owner: OwnerScope = null): Promise<Machine[]> {
    return (await this.db.machine.findMany({ where: ownerWhere(owner), include: withOwner, orderBy: { createdAt: 'asc' } })).map(mapMachine);
  }

  async findById(id: string): Promise<Machine | undefined> {
    const m = await this.db.machine.findUnique({ where: { id }, include: withOwner });
    return m ? mapMachine(m) : undefined;
  }

  /**
   * Batched by id, one query regardless of how many ids are asked for, filtered to one owner's
   * machines — never "no filter": a caller that resolves names for one person's screen (e.g. the
   * chat action trail) must not be able to pass `null` and see everyone's. Another owner's machine
   * id, or an orphan's, is simply absent from the result, exactly like a row that does not exist.
   */
  async findByIdsForOwner(ids: string[], ownerId: string): Promise<Machine[]> {
    if (ids.length === 0) return [];
    return (await this.db.machine.findMany({ where: { id: { in: ids }, ownerId }, include: withOwner })).map(mapMachine);
  }

  async findByType(type: MachineType): Promise<Machine[]> {
    return (await this.db.machine.findMany({ where: { type } })).map(mapMachine);
  }

  async findByAgentTokenHash(hash: string): Promise<Machine | undefined> {
    const m = await this.db.machine.findUnique({ where: { agentTokenHash: hash }, include: withOwner });
    return m && m.type === 'agent' ? mapMachine(m) : undefined;
  }

  async rotateAgentToken(id: string, hash: string): Promise<void> {
    await this.db.machine.updateMany({ where: { id, type: 'agent' }, data: { agentTokenHash: hash, agentTokenCreatedAt: new Date() } });
  }

  /** Written on hello and once a minute while connected. */
  async touchAgent(id: string, patch: { version?: string; os?: string | null; capabilities?: string[]; lastSeenAt: Date }): Promise<void> {
    await this.db.machine.updateMany({
      where: { id },
      data: {
        agentLastSeenAt: patch.lastSeenAt,
        ...(patch.version !== undefined ? { agentVersion: patch.version } : {}),
        ...(patch.os !== undefined ? { os: patch.os, checkedAt: patch.lastSeenAt } : {}),
        ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
      },
    });
  }

  async create(input: MachineInput): Promise<Machine> {
    const isAgent = input.type === 'agent';
    const m = await this.db.machine.create({
      data: {
        id: newId(),
        name: input.name,
        subtitle: input.subtitle ?? null,
        type: input.type,
        host: isAgent ? null : (input.host ?? null),
        sshUser: isAgent ? null : (input.ssh_user ?? null),
        sshPort: input.ssh_port ?? 22,
        isLocal: input.is_local ?? false,
        ownerId: input.owner_id ?? null,
      },
      include: withOwner,
    });
    return mapMachine(m);
  }

  async update(id: string, patch: Partial<MachineInput>): Promise<Machine | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    const m = await this.db.machine.update({
      where: { id },
      data: {
        name: next.name,
        subtitle: next.subtitle ?? null,
        type: next.type,
        host: next.host ?? null,
        sshUser: next.ssh_user ?? null,
        sshPort: next.ssh_port ?? 22,
        isLocal: next.is_local,
        agentAutoUpdate: next.agent_auto_update ?? false,
        claudeAutoSwap: next.claude_auto_swap ?? false,
        ...(patch.owner_id !== undefined ? { ownerId: patch.owner_id } : {}),
      },
      include: withOwner,
    });
    return mapMachine(m);
  }

  /** Agent machines that opted into automatic updates (the scheduler checks online/idle itself). */
  async listAutoUpdate(): Promise<Machine[]> {
    const rows = await this.db.machine.findMany({ where: { type: 'agent', agentAutoUpdate: true }, include: withOwner });
    return rows.map(mapMachine);
  }

  /** Resultado da detecção feita no status (SO e ferramentas disponíveis). */
  async setDetected(id: string, os: string | null, capabilities: string[]): Promise<void> {
    await this.db.machine.updateMany({ where: { id }, data: { os, capabilities, checkedAt: new Date() } });
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.db.machine.deleteMany({ where: { id } });
    return r.count > 0;
  }
}
