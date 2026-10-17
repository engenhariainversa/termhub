import type { PrismaClient } from '../prisma.js';
import type { ChatFileGrant as PrismaRow } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

/** "Permitir sempre nesta pasta" (TER-1086): `share_file` from one folder of one machine, until revoked. */
export interface ChatFileGrant {
  id: string;
  user_id: string;
  machine_id: string;
  /** Lexical, as the card showed it (`~` kept). */
  folder: string;
  conversation_id: string | null;
  source_action_id: string | null;
  created_at: string;
  revoked_at: string | null;
}

/** What the screens show: the grant and its machine's name. */
export interface ChatFileGrantView extends ChatFileGrant {
  machine_name: string;
}

const map = (g: PrismaRow): ChatFileGrant => ({
  id: g.id,
  user_id: g.userId,
  machine_id: g.machineId,
  folder: g.folder,
  conversation_id: g.conversationId,
  source_action_id: g.sourceActionId,
  created_at: g.createdAt.toISOString(),
  revoked_at: g.revokedAt?.toISOString() ?? null,
});

/** Every method is keyed by `user_id` (server-derived, never a client value). */
export class ChatFileGrantsRepository {
  constructor(private db: PrismaClient) {}

  /** Trusts a folder of a machine; the previous active row for the same folder is revoked in the same transaction. */
  async grant(input: { user_id: string; machine_id: string; folder: string; conversation_id?: string | null; source_action_id?: string | null }, now = new Date()): Promise<ChatFileGrant> {
    const row = await this.db.$transaction(async (tx) => {
      await tx.chatFileGrant.updateMany({ where: { userId: input.user_id, machineId: input.machine_id, folder: input.folder, revokedAt: null }, data: { revokedAt: now, revokedBy: input.user_id } });
      return tx.chatFileGrant.create({ data: { id: newId(), userId: input.user_id, machineId: input.machine_id, folder: input.folder, conversationId: input.conversation_id ?? null, sourceActionId: input.source_action_id ?? null, createdAt: now } });
    });
    return map(row);
  }

  async listActiveForMachine(userId: string, machineId: string): Promise<ChatFileGrant[]> {
    return (await this.db.chatFileGrant.findMany({ where: { userId, machineId, revokedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(map);
  }

  /** Every active grant of the user, with its machine's name, newest first. */
  async listActive(userId: string): Promise<ChatFileGrantView[]> {
    const rows = await this.db.chatFileGrant.findMany({ where: { userId, revokedAt: null }, include: { machine: { select: { name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.map((r) => ({ ...map(r), machine_name: r.machine.name }));
  }

  /** "Revogar". Undefined when it matched nothing: wrong id, another user's, or already revoked. */
  async revoke(id: string, userId: string, now = new Date()): Promise<ChatFileGrant | undefined> {
    const { count } = await this.db.chatFileGrant.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: now, revokedBy: userId } });
    if (count === 0) return undefined;
    const r = await this.db.chatFileGrant.findUnique({ where: { id } });
    return r ? map(r) : undefined;
  }
}
