import type { PrismaClient } from '../prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { mapUser, type User, type UserRole } from './types.js';
import type { Locale } from '../../i18n/index.js';

export class UsersRepository {
  constructor(private db: PrismaClient) {}

  async findById(id: string): Promise<User | undefined> {
    const u = await this.db.user.findUnique({ where: { id } });
    return u ? mapUser(u) : undefined;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const u = await this.db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    return u ? mapUser(u) : undefined;
  }

  async findByGoogleId(googleId: string): Promise<User | undefined> {
    const u = await this.db.user.findUnique({ where: { googleId } });
    return u ? mapUser(u) : undefined;
  }

  /** First admin (or first user created). Used in AUTH_MODE=disabled. */
  async findFirstOwner(): Promise<User | undefined> {
    const u =
      (await this.db.user.findFirst({ where: { roleRef: { isAdmin: true } }, orderBy: { createdAt: 'asc' } })) ??
      (await this.db.user.findFirst({ where: { role: 'owner' }, orderBy: { createdAt: 'asc' } })) ??
      (await this.db.user.findFirst({ orderBy: { createdAt: 'asc' } }));
    return u ? mapUser(u) : undefined;
  }

  count(): Promise<number> {
    return this.db.user.count();
  }

  async list(): Promise<User[]> {
    return (await this.db.user.findMany({ orderBy: { createdAt: 'asc' } })).map(mapUser);
  }

  async countByRole(roleId: string): Promise<number> {
    return this.db.user.count({ where: { roleId } });
  }

  async countAdmins(): Promise<number> {
    return this.db.user.count({ where: { roleRef: { isAdmin: true } } });
  }

  async create(input: {
    email: string;
    name: string;
    password_hash?: string | null;
    /** DEPRECATED legacy flag, derived from the role when omitted */
    role?: UserRole;
    role_id: string;
    avatar_url?: string | null;
    invited_at?: Date | null;
  }): Promise<User> {
    const u = await this.db.user.create({
      data: {
        id: newId(),
        email: input.email.trim().toLowerCase(),
        name: input.name.trim(),
        passwordHash: input.password_hash ?? null,
        role: input.role ?? 'member',
        roleId: input.role_id,
        avatarUrl: input.avatar_url ?? null,
        invitedAt: input.invited_at ?? null,
      },
    });
    return mapUser(u);
  }

  async touchLogin(userId: string): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  }

  async setRole(userId: string, roleId: string, legacy: UserRole): Promise<User | undefined> {
    const u = await this.db.user.update({ where: { id: userId }, data: { roleId, role: legacy } });
    return mapUser(u);
  }

  async delete(userId: string): Promise<boolean> {
    return (await this.db.user.deleteMany({ where: { id: userId } })).count > 0;
  }

  async linkGoogle(userId: string, googleId: string, avatarUrl?: string | null): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { googleId, ...(avatarUrl ? { avatarUrl } : {}) },
    });
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { passwordHash } });
  }

  /**
   * Claims a nickname for this user. The write itself decides: two requests racing for the same
   * nickname can both pass a check-then-act read, so this attempts the update directly and lets the
   * unique index reject the loser as 'taken' (P2002), instead of asking first (see ChatRepository.getOrCreateForUser
   * for the same idiom against the same shape of race). Re-claiming the nickname you already hold is
   * still 'ok': the update is a no-op write on your own row, not a conflict with anyone else's.
   * Changing a nickname that is already set is 'locked': an address, once claimed, is never released.
   */
  async setNickname(userId: string, nickname: string): Promise<'ok' | 'taken' | 'locked'> {
    try {
      // Conditional on the row having no nickname yet (or already this one): a claimed address is
      // never released, so a shared /city/@nick link cannot be inherited by whoever claims it next.
      // The condition is part of the write, so two concurrent claims cannot both land.
      const { count } = await this.db.user.updateMany({ where: { id: userId, OR: [{ nickname: null }, { nickname }] }, data: { nickname } });
      return count === 1 ? 'ok' : 'locked';
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return 'taken';
      throw err;
    }
  }

  async findByNickname(nickname: string): Promise<User | undefined> {
    const u = await this.db.user.findUnique({ where: { nickname } });
    return u ? mapUser(u) : undefined;
  }

  /**
   * Stores the partner short link, only when the row has none yet: the condition is part of the
   * write, so two attempts racing (two app colors, say) cannot overwrite each other. False = one
   * was already there, and it stays.
   */
  async setCityShortUrlPartner(userId: string, url: string): Promise<boolean> {
    const { count } = await this.db.user.updateMany({ where: { id: userId, cityShortUrlPartner: null }, data: { cityShortUrlPartner: url } });
    return count === 1;
  }

  /** Sets (a pasted short link) or clears (null: back to the partner one) the custom short link. */
  async setCityShortUrlCustom(userId: string, url: string | null): Promise<User> {
    return mapUser(await this.db.user.update({ where: { id: userId }, data: { cityShortUrlCustom: url } }));
  }

  /** Store-review switch (Settings → Usuários → Revisão): `until` null turns it off. `by` is the
   *  admin's id, kept alongside the expiry for "ligado até … por …" on the panel. */
  async setReview(userId: string, until: Date | null, by: string | null): Promise<User> {
    return mapUser(await this.db.user.update({ where: { id: userId }, data: { reviewEnabledUntil: until, reviewEnabledBy: by } }));
  }

  /** "Memória do chat" switch (spec 2026-09-26 §7): true when the row is missing too — callers only
   *  reach this for a real user, so a missing row just means "no reason to turn it off yet". */
  async chatSuggestions(userId: string): Promise<boolean> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { chatSuggestions: true } });
    return u?.chatSuggestions ?? true;
  }

  /** The language this person chose (TER-405); null = automatic. */
  async setLocale(userId: string, locale: Locale | null): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { locale } });
  }

  /** The IANA zone the client reported (the daily summary's clock); null when unset. */
  async timeZone(userId: string): Promise<string | null> {
    return (await this.db.user.findUnique({ where: { id: userId }, select: { timeZone: true } }))?.timeZone ?? null;
  }

  async setTimeZone(userId: string, timeZone: string): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { timeZone } });
  }

  async setChatSuggestions(userId: string, enabled: boolean): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { chatSuggestions: enabled } });
  }

  /** "Responder sozinho quando houver precedente" (spec 2026-09-26 concierge memory D8): false when
   *  the row is missing too — off is the safe default, never send keys without an explicit opt-in.
   *  Also false while the account waits out its deletion (TER-720): a deactivated account answers nothing. */
  async chatAutodecide(userId: string): Promise<boolean> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { chatAutodecide: true, deletionScheduledAt: true } });
    return !!u?.chatAutodecide && !u.deletionScheduledAt;
  }

  async setChatAutodecide(userId: string, enabled: boolean): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { chatAutodecide: enabled } });
  }

  /** "Responder perguntas do Codex pelo chat": false when the row is missing too — opt-in, off by default. */
  async chatCodexReplies(userId: string): Promise<boolean> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { chatCodexReplies: true } });
    return u?.chatCodexReplies ?? false;
  }

  async setChatCodexReplies(userId: string, enabled: boolean): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { chatCodexReplies: enabled } });
  }

  /** "Avisar quando uma aba terminar" (TER-925): off unless the person turned it on. */
  async pushTabFinished(userId: string): Promise<boolean> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { pushTabFinished: true } });
    return u?.pushTabFinished ?? false;
  }

  async setPushTabFinished(userId: string, enabled: boolean): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { pushTabFinished: enabled } });
  }
}
