import type { AttachmentKind, ChatAttachment } from '@termhub/mobile-api';
import type { PrismaClient } from '../prisma.js';
import { Prisma, type ChatAttachment as PrismaAttachment } from '../../generated/prisma/client.js';

/** The whole row. `extracted_text` never leaves the server except through `read_attachment`. */
export interface AttachmentRow extends ChatAttachment {
  user_id: string;
  conversation_id: string;
  message_id: string | null;
  sha256: string;
  extracted_text: string | null;
}

export interface CreateAttachmentInput {
  id: string;
  user_id: string;
  conversation_id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  bytes: number;
  sha256: string;
  meta: Record<string, unknown> | null;
}

export interface ChatAttachmentsRepo {
  create(row: CreateAttachmentInput): Promise<AttachmentRow>;
  /** By id alone — for the extraction queue, which holds no user. Routes use `findForUser`. */
  findById(id: string): Promise<AttachmentRow | null>;
  findForUser(id: string, userId: string): Promise<AttachmentRow | null>;
  listForMessages(messageIds: string[]): Promise<AttachmentRow[]>;
  /** Binds the ids that are this user's, this conversation's, unsent and not an invalid file. Answers how many it bound. */
  attach(ids: string[], messageId: string, userId: string, conversationId: string): Promise<number>;
  /** Null when the row is gone (deleted while its file was being parsed). */
  setExtracted(id: string, text: string | null, meta: Record<string, unknown> | null): Promise<AttachmentRow | null>;
  setFailed(id: string, code: string): Promise<AttachmentRow | null>;
  deleteUnsent(id: string, userId: string): Promise<boolean>;
  usageBytes(userId: string): Promise<number>;
  listPending(): Promise<AttachmentRow[]>;
  listStaleUnsent(olderThan: Date): Promise<AttachmentRow[]>;
  existingIds(ids: string[]): Promise<Set<string>>;
}

export const mapAttachment = (a: PrismaAttachment): AttachmentRow => ({
  id: a.id,
  user_id: a.userId,
  conversation_id: a.conversationId,
  message_id: a.messageId,
  name: a.name,
  mime: a.mime,
  kind: a.kind as AttachmentKind,
  bytes: a.bytes,
  sha256: a.sha256,
  status: a.status as AttachmentRow['status'],
  error_code: a.errorCode,
  extracted_text: a.extractedText,
  meta: (a.meta as Record<string, unknown> | null) ?? null,
  created_at: a.createdAt.toISOString(),
});

/** What a client sees: never the owner, the hash or the extracted text. */
export function toPublicAttachment(row: AttachmentRow): ChatAttachment {
  return { id: row.id, name: row.name, mime: row.mime, kind: row.kind, bytes: row.bytes, status: row.status, error_code: row.error_code, meta: row.meta, created_at: row.created_at };
}

/** The rule `attach` enforces in SQL, for the service's read-only pre-check (spec 2026-09-26 §5.5). */
export function isAttachable(row: AttachmentRow, conversationId: string): boolean {
  return row.conversation_id === conversationId && row.message_id === null && !(row.status === 'failed' && row.error_code === 'ATTACHMENT_INVALID');
}

const json = (meta: Record<string, unknown> | null) => (meta === null ? Prisma.DbNull : (meta as Prisma.InputJsonValue));
const ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

export class ChatAttachmentsRepository implements ChatAttachmentsRepo {
  constructor(private db: PrismaClient) {}

  async create(row: CreateAttachmentInput): Promise<AttachmentRow> {
    return mapAttachment(
      await this.db.chatAttachment.create({
        data: { id: row.id, userId: row.user_id, conversationId: row.conversation_id, name: row.name, mime: row.mime, kind: row.kind, bytes: row.bytes, sha256: row.sha256, meta: json(row.meta) },
      }),
    );
  }

  async findById(id: string): Promise<AttachmentRow | null> {
    const a = await this.db.chatAttachment.findUnique({ where: { id } });
    return a ? mapAttachment(a) : null;
  }

  async findForUser(id: string, userId: string): Promise<AttachmentRow | null> {
    const a = await this.db.chatAttachment.findFirst({ where: { id, userId } });
    return a ? mapAttachment(a) : null;
  }

  async listForMessages(messageIds: string[]): Promise<AttachmentRow[]> {
    if (messageIds.length === 0) return [];
    return (await this.db.chatAttachment.findMany({ where: { messageId: { in: messageIds } }, orderBy: ORDER })).map(mapAttachment);
  }

  async attach(ids: string[], messageId: string, userId: string, conversationId: string): Promise<number> {
    const r = await this.db.chatAttachment.updateMany({
      where: { id: { in: ids }, userId, conversationId, messageId: null, OR: [{ status: { not: 'failed' } }, { errorCode: null }, { errorCode: { not: 'ATTACHMENT_INVALID' } }] },
      data: { messageId },
    });
    return r.count;
  }

  async setExtracted(id: string, text: string | null, meta: Record<string, unknown> | null): Promise<AttachmentRow | null> {
    const r = await this.db.chatAttachment.updateMany({ where: { id }, data: { status: 'ready', extractedText: text, errorCode: null, meta: json(meta) } });
    return r.count === 0 ? null : this.findById(id);
  }

  async setFailed(id: string, code: string): Promise<AttachmentRow | null> {
    const r = await this.db.chatAttachment.updateMany({ where: { id }, data: { status: 'failed', errorCode: code } });
    return r.count === 0 ? null : this.findById(id);
  }

  async deleteUnsent(id: string, userId: string): Promise<boolean> {
    const r = await this.db.chatAttachment.deleteMany({ where: { id, userId, messageId: null } });
    return r.count > 0;
  }

  async usageBytes(userId: string): Promise<number> {
    const r = await this.db.chatAttachment.aggregate({ where: { userId }, _sum: { bytes: true } });
    return r._sum.bytes ?? 0;
  }

  async listPending(): Promise<AttachmentRow[]> {
    return (await this.db.chatAttachment.findMany({ where: { status: 'pending' }, orderBy: ORDER })).map(mapAttachment);
  }

  async listStaleUnsent(olderThan: Date): Promise<AttachmentRow[]> {
    return (await this.db.chatAttachment.findMany({ where: { messageId: null, createdAt: { lt: olderThan } }, orderBy: ORDER })).map(mapAttachment);
  }

  async existingIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db.chatAttachment.findMany({ where: { id: { in: ids } }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }
}
