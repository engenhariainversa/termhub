import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

export interface WaitlistEntry {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_country: string;
  phone_area: string;
  phone_number: string;
  phone: string;
  linkedin: string | null;
  github: string | null;
  locale: string;
  source: string;
  created_at: string;
  /** when the alpha invite was (last) sent; null = not invited yet */
  invited_at: string | null;
}

export type WaitlistInput = Omit<WaitlistEntry, 'id' | 'created_at' | 'source' | 'invited_at'> & { source?: string };

function map(e: {
  id: string; firstName: string; lastName: string; email: string; phoneCountry: string; phoneArea: string; phoneNumber: string; phone: string;
  linkedin: string | null; github: string | null; locale: string; source: string; createdAt: Date; invitedAt: Date | null;
}): WaitlistEntry {
  return {
    id: e.id, first_name: e.firstName, last_name: e.lastName, email: e.email, phone_country: e.phoneCountry, phone_area: e.phoneArea,
    phone_number: e.phoneNumber, phone: e.phone, linkedin: e.linkedin, github: e.github, locale: e.locale, source: e.source, created_at: e.createdAt.toISOString(),
    invited_at: e.invitedAt ? e.invitedAt.toISOString() : null,
  };
}

export class WaitlistRepository {
  constructor(private db: PrismaClient) {}

  async findByEmail(email: string): Promise<WaitlistEntry | undefined> {
    const e = await this.db.waitlistEntry.findUnique({ where: { email } });
    return e ? map(e) : undefined;
  }

  async create(input: WaitlistInput): Promise<WaitlistEntry> {
    const e = await this.db.waitlistEntry.create({
      data: {
        id: newId(),
        firstName: input.first_name, lastName: input.last_name, email: input.email,
        phoneCountry: input.phone_country, phoneArea: input.phone_area, phoneNumber: input.phone_number, phone: input.phone,
        linkedin: input.linkedin, github: input.github, locale: input.locale, source: input.source ?? 'landing',
      },
    });
    return map(e);
  }

  async list(): Promise<WaitlistEntry[]> {
    return (await this.db.waitlistEntry.findMany({ orderBy: { createdAt: 'desc' } })).map(map);
  }

  async findByIds(ids: string[]): Promise<WaitlistEntry[]> {
    if (ids.length === 0) return [];
    return (await this.db.waitlistEntry.findMany({ where: { id: { in: ids } } })).map(map);
  }

  /** Stamps invited_at = now on the given entries (re-invites overwrite the previous stamp). */
  async markInvited(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.waitlistEntry.updateMany({ where: { id: { in: ids } }, data: { invitedAt: new Date() } });
  }

  async count(): Promise<number> {
    return this.db.waitlistEntry.count();
  }

  /** The retention purge (TER-743): entries never invited that signed up before `cutoff`, and entries
   *  whose (last) invite is older than it. */
  async purgeBefore(cutoff: Date): Promise<number> {
    const r = await this.db.waitlistEntry.deleteMany({ where: { OR: [{ invitedAt: null, createdAt: { lt: cutoff } }, { invitedAt: { lt: cutoff } }] } });
    return r.count;
  }

  async delete(id: string): Promise<boolean> {
    return (await this.db.waitlistEntry.deleteMany({ where: { id } })).count > 0;
  }
}
