import type { PrismaClient } from '../prisma.js';
import { Prisma, type LegalDocumentVersion as PrismaLegalVersion } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { legalStatus, type LegalChannel, type LegalDocument, type LegalStatus, type LegalVersion } from './legal-status.js';

export type { LegalChannel, LegalDocument, LegalStatus, LegalVersion } from './legal-status.js';

/** How long before a relevant version takes effect its notice goes out (and the least a replacement may be registered ahead). */
export const LEGAL_NOTICE_MS = 30 * 24 * 60 * 60 * 1000;

const map = (r: PrismaLegalVersion): LegalVersion => ({
  id: r.id,
  document: r.document as LegalDocument,
  version: r.version,
  effective_at: r.effectiveAt.toISOString(),
  url: r.url,
  requires_acceptance: r.requiresAcceptance,
  summary: r.summary,
});

export interface CreateLegalVersionInput {
  document: LegalDocument;
  version: string;
  effective_at: Date;
  url: string;
  requires_acceptance: boolean;
  summary: string | null;
}

export interface AcceptanceMeta {
  ip: string | null;
  user_agent: string | null;
  channel: LegalChannel;
}

/**
 * The versions of the Terms of Use and of the Privacy Policy, and who accepted which (TER-742). The
 * table is small (a handful of rows per year), so the status reads it whole and decides in code.
 * Acceptance rows are never updated: a new acceptance is a new row.
 */
export class LegalRepository {
  constructor(private db: PrismaClient) {}

  /** Every version, by document, newest first. */
  async listVersions(): Promise<LegalVersion[]> {
    const rows = await this.db.legalDocumentVersion.findMany({ orderBy: [{ document: 'asc' }, { effectiveAt: 'desc' }, { createdAt: 'desc' }] });
    return rows.map(map);
  }

  /** undefined when that document already has a version with that number (the unique key). */
  async createVersion(input: CreateLegalVersionInput): Promise<LegalVersion | undefined> {
    try {
      const row = await this.db.legalDocumentVersion.create({
        data: {
          id: newId(),
          document: input.document,
          version: input.version,
          effectiveAt: input.effective_at,
          url: input.url,
          requiresAcceptance: input.requires_acceptance,
          summary: input.summary,
        },
      });
      return map(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return undefined;
      throw err;
    }
  }

  async findVersion(id: string): Promise<LegalVersion | undefined> {
    const row = await this.db.legalDocumentVersion.findUnique({ where: { id } });
    return row ? map(row) : undefined;
  }

  /** The document's version with the latest effective date, relevant or not; undefined when it has none. */
  async latestVersion(document: LegalDocument): Promise<LegalVersion | undefined> {
    const row = await this.db.legalDocumentVersion.findFirst({ where: { document }, orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }] });
    return row ? map(row) : undefined;
  }

  /** One row per version, all with the same moment, origin and channel. */
  async recordAcceptances(userId: string, versionIds: readonly string[], meta: AcceptanceMeta): Promise<void> {
    if (versionIds.length === 0) return;
    const acceptedAt = new Date();
    await this.db.legalAcceptance.createMany({
      data: [...new Set(versionIds)].map((versionId) => ({
        id: newId(),
        userId,
        versionId,
        acceptedAt,
        ip: meta.ip,
        userAgent: meta.user_agent,
        channel: meta.channel,
      })),
    });
  }

  async statusFor(userId: string, now: Date = new Date()): Promise<LegalStatus> {
    const versions = await this.listVersions();
    if (versions.length === 0) return { pending: [], upcoming: [] };
    const accepted = await this.db.legalAcceptance.findMany({ where: { userId }, select: { versionId: true }, distinct: ['versionId'] });
    return legalStatus(
      versions,
      accepted.map((a) => a.versionId),
      now,
    );
  }

  /**
   * The relevant versions whose 30-day notice is due now: they replace an earlier version of the same
   * document, take effect within 30 days, and no notice went out yet. Each is claimed by setting
   * `notice_sent_at` from null in one UPDATE, so when both colours run the job only one sends it.
   */
  async claimDueNotices(now: Date = new Date()): Promise<LegalVersion[]> {
    const candidates = await this.db.legalDocumentVersion.findMany({
      where: { requiresAcceptance: true, noticeSentAt: null, effectiveAt: { gt: now, lte: new Date(now.getTime() + LEGAL_NOTICE_MS) } },
      orderBy: [{ document: 'asc' }, { effectiveAt: 'asc' }],
    });
    const claimed: LegalVersion[] = [];
    for (const row of candidates) {
      // The first version of a document replaces nothing: no notice (spec decision 6).
      const earlier = await this.db.legalDocumentVersion.count({ where: { document: row.document, effectiveAt: { lt: row.effectiveAt } } });
      if (earlier === 0) continue;
      const done = await this.db.legalDocumentVersion.updateMany({ where: { id: row.id, noticeSentAt: null }, data: { noticeSentAt: now } });
      if (done.count === 1) claimed.push(map(row));
    }
    return claimed;
  }
}
