import type { PrismaClient } from '../prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import type { RuleCandidate, RuleKind, RulePolicy, RuleStatus } from '../../memory/rules.js';

/** A `memory_rules` row (TER-1010), with the project name joined in for display. */
export interface MemoryRule {
  id: string;
  owner_id: string;
  project_id: string | null;
  project_name: string | null;
  kind: RuleKind;
  status: RuleStatus;
  text: string;
  policy: RulePolicy | null;
  source_refs: string[];
  fingerprint: string;
  note_id: string | null;
  decided_at: string | null;
  decided_by: string | null;
  created_at: string;
}

/** A current concierge note or a remembered decision, as consolidation reads it (raw, before the
 *  statement is built). Notes are chunk 0 of `kind: note`; never another owner's rows. */
export interface RuleSourceRow {
  ref: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  /** A note's stored text, or a decision's question. */
  text: string;
  /** A decision's answer; null for a note. */
  answer: unknown;
  created_at: string;
}

type Row = Prisma.MemoryRuleGetPayload<{ include: { project: { select: { name: true } } } }>;

const toRule = (r: Row): MemoryRule => ({
  id: r.id,
  owner_id: r.ownerId,
  project_id: r.projectId,
  project_name: r.project?.name ?? null,
  kind: r.kind as RuleKind,
  status: r.status as RuleStatus,
  text: r.text,
  policy: (r.policy as RulePolicy | null) ?? null,
  source_refs: Array.isArray(r.sourceRefs) ? (r.sourceRefs as string[]) : [],
  fingerprint: r.fingerprint,
  note_id: r.noteId,
  decided_at: r.decidedAt?.toISOString() ?? null,
  decided_by: r.decidedBy,
  created_at: r.createdAt.toISOString(),
});

const include = { project: { select: { name: true } } } as const;
const jsonOrNull = (v: unknown) => (v === null ? Prisma.JsonNull : (v as Prisma.InputJsonValue));

export class MemoryRulesRepository {
  constructor(private db: PrismaClient) {}

  /** Every rule and proposal of the owner, newest first. */
  async listForOwner(ownerId: string): Promise<MemoryRule[]> {
    const rows = await this.db.memoryRule.findMany({ where: { ownerId }, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.map(toRule);
  }

  async findForOwner(id: string, ownerId: string): Promise<MemoryRule | null> {
    const row = await this.db.memoryRule.findFirst({ where: { id, ownerId }, include });
    return row ? toRule(row) : null;
  }

  /** The current concierge notes and remembered decisions of the owner. */
  async listSources(ownerId: string): Promise<RuleSourceRow[]> {
    const rows = await this.db.$queryRaw<(Omit<RuleSourceRow, 'created_at'> & { created_at: Date })[]>`
      SELECT 'note:' || m.id AS ref, m.project_id, p.name AS project_name, m.title, m.text, NULL::jsonb AS answer, m.created_at
      FROM "memory_items" m LEFT JOIN "projects" p ON p.id = m.project_id
      WHERE m.owner_id = ${ownerId} AND m.kind = 'note' AND m.chunk_index = 0
      UNION ALL
      SELECT 'decision:' || d.id, d.project_id, p.name, d.header, d.question, d.answer, d.created_at
      FROM "chat_decisions" d LEFT JOIN "projects" p ON p.id = d.project_id
      WHERE d.user_id = ${ownerId}`;
    return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
  }

  /**
   * Pairs of the owner's sources whose embeddings are at least `threshold` alike (cosine): notes with
   * notes, and decisions with decisions that got the same answer — a decision's embedding is of its
   * question alone, so it is never compared with a note's. Same `embed_model` only. An exact scan, like
   * `nearest`: one owner's notes and decisions are few.
   */
  async similarPairs(ownerId: string, threshold: number): Promise<[string, string][]> {
    const rows = await this.db.$queryRaw<{ a: string; b: string }[]>`
      SELECT 'note:' || a.id AS a, 'note:' || b.id AS b
      FROM "memory_items" a JOIN "memory_items" b
        ON b.owner_id = a.owner_id AND b.kind = 'note' AND b.chunk_index = 0 AND a.id < b.id AND b.embed_model = a.embed_model
      WHERE a.owner_id = ${ownerId} AND a.kind = 'note' AND a.chunk_index = 0
        AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND 1 - (a.embedding <=> b.embedding) >= ${threshold}
      UNION ALL
      SELECT 'decision:' || a.id, 'decision:' || b.id
      FROM "chat_decisions" a JOIN "chat_decisions" b
        ON b.user_id = a.user_id AND a.id < b.id AND b.embed_model = a.embed_model AND b.answer = a.answer
      WHERE a.user_id = ${ownerId} AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND 1 - (a.embedding <=> b.embedding) >= ${threshold}`;
    return rows.map((r) => [r.a, r.b]);
  }

  /**
   * Stores the proposals consolidation just made, by fingerprint: a new one is inserted `proposed`, one
   * still `proposed` gets its text refreshed, and a `rejected` one whose 180 days are over (consolidation
   * already left out the ones still inside them) is proposed again. An `approved` or
   * `awaiting_confirmation` row is never touched. Every `proposed` row of the owner no longer among the
   * candidates (its sources were forgotten, or approved into another rule) is removed.
   */
  async syncProposals(ownerId: string, candidates: RuleCandidate[]): Promise<void> {
    await this.db.$transaction(async (tx) => {
      for (const c of candidates) {
        const existing = await tx.memoryRule.findUnique({ where: { ownerId_fingerprint: { ownerId, fingerprint: c.fingerprint } } });
        const data = { kind: c.kind, projectId: c.project_id, text: c.text, policy: jsonOrNull(c.policy), sourceRefs: c.source_refs };
        if (!existing) {
          await tx.memoryRule.create({ data: { id: newId(), ownerId, fingerprint: c.fingerprint, status: 'proposed', ...data } });
        } else if (existing.status === 'proposed' || existing.status === 'rejected') {
          await tx.memoryRule.update({ where: { id: existing.id }, data: { ...data, status: 'proposed', decidedAt: null, decidedBy: null } });
        }
      }
      await tx.memoryRule.deleteMany({ where: { ownerId, status: 'proposed', fingerprint: { notIn: candidates.map((c) => c.fingerprint) } } });
    });
  }

  /**
   * Moves a row from one of `from` to `to`, only when it is still in `from` (two screens deciding the same
   * proposal: the second gets null). `decided_*` are stamped with the move.
   */
  async decide(
    id: string,
    ownerId: string,
    from: RuleStatus[],
    to: RuleStatus,
    by: string | null,
    extra: { text?: string; note_id?: string | null; policy?: RulePolicy } = {},
  ): Promise<MemoryRule | null> {
    const { count } = await this.db.memoryRule.updateMany({
      where: { id, ownerId, status: { in: from } },
      data: {
        status: to,
        decidedAt: new Date(),
        decidedBy: by,
        ...(extra.text !== undefined ? { text: extra.text } : {}),
        ...(extra.note_id !== undefined ? { noteId: extra.note_id } : {}),
        ...(extra.policy !== undefined ? { policy: extra.policy as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    return count > 0 ? this.findForOwner(id, ownerId) : null;
  }

  /** Records a policy row's projects whose card was applied. */
  async setPolicy(id: string, policy: RulePolicy): Promise<void> {
    await this.db.memoryRule.update({ where: { id }, data: { policy: policy as unknown as Prisma.InputJsonValue } });
  }

  async findById(id: string): Promise<MemoryRule | null> {
    const row = await this.db.memoryRule.findUnique({ where: { id }, include });
    return row ? toRule(row) : null;
  }

  /** "Remover regra": an approved rule goes away and its sources are current again. */
  async deleteApproved(id: string, ownerId: string): Promise<MemoryRule | null> {
    const rule = await this.findForOwner(id, ownerId);
    if (!rule || rule.status !== 'approved') return null;
    await this.db.memoryRule.deleteMany({ where: { id, ownerId, status: 'approved' } });
    return rule;
  }

  /** The refs approved rules supersede: `search_memory` leaves them out and returns the rule's note. */
  async supersededRefs(ownerId: string): Promise<Set<string>> {
    const rows = await this.db.memoryRule.findMany({ where: { ownerId, status: 'approved' }, select: { sourceRefs: true } });
    return new Set(rows.flatMap((r) => (Array.isArray(r.sourceRefs) ? (r.sourceRefs as string[]) : [])));
  }
}
