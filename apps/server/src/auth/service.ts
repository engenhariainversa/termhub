import { createHash, randomInt } from 'node:crypto';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import { config } from '../config.js';
import type { Mailer } from '../email/mailer.js';
import { loginCodeMail } from '../email/templates.js';
import { verifyPassword } from './password.js';
import { generateToken, hashToken, safeEqual } from './tokens.js';
import { API_TOKEN_EVENT_RETENTION_DAYS } from './api-tokens.js';
import { DEFAULT_LOCALE, type Locale } from '../i18n/index.js';

export type LoginResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterMs: number };

export type SendCodeResult = { ok: true } | { ok: false; reason: 'rate_limited'; retryAfterMs: number } | { ok: false; reason: 'send_failed' };

const CODE_RATE_WINDOW_MS = 10 * 60 * 1000;
const CODE_RATE_MAX = 3;
const CODE_MAX_ATTEMPTS = 5;

/** Regras de autenticação independentes de HTTP (testáveis isoladamente). */
export class AuthService {
  constructor(
    private repos: Repositories,
    private mailer: Mailer,
  ) {}

  private async checkLock(email: string, ip: string): Promise<number> {
    const [a, b] = await Promise.all([
      this.repos.loginAttempts.lockedFor(`email:${email}`),
      this.repos.loginAttempts.lockedFor(`ip:${ip}`),
    ]);
    return Math.max(a, b);
  }

  private async recordFailure(email: string, ip: string): Promise<number> {
    const [a, b] = await Promise.all([
      this.repos.loginAttempts.recordFailure(`email:${email}`),
      this.repos.loginAttempts.recordFailure(`ip:${ip}`),
    ]);
    return Math.max(a, b);
  }

  private async clearFailures(email: string, ip: string): Promise<void> {
    await Promise.all([this.repos.loginAttempts.clear(`email:${email}`), this.repos.loginAttempts.clear(`ip:${ip}`)]);
  }

  // ---------- e-mail + senha ----------

  async loginWithPassword(rawEmail: string, password: string, ip: string): Promise<LoginResult> {
    const email = rawEmail.trim().toLowerCase();
    const locked = await this.checkLock(email, ip);
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };

    const user = await this.repos.users.findByEmail(email);
    const valid = await verifyPassword(user?.password_hash ?? null, password);
    if (!user || !valid) {
      const lock = await this.recordFailure(email, ip);
      if (lock > 0) return { ok: false, reason: 'locked', retryAfterMs: lock };
      return { ok: false, reason: 'invalid' };
    }
    await this.clearFailures(email, ip);
    return { ok: true, user };
  }

  // ---------- e-mail + código ----------

  private hashCode(email: string, code: string): string {
    return createHash('sha256').update(`${email}:${code}`).digest('hex');
  }

  /**
   * Envia um código de 6 dígitos. Sempre responde "ok" para e-mails desconhecidos
   * (não revela quem está cadastrado) — mas só envia de fato se o usuário existir.
   */
  /** `fallbackLocale`: the request's language, used when the account has no language of its own. */
  async sendLoginCode(rawEmail: string, ip: string, fallbackLocale: Locale = DEFAULT_LOCALE): Promise<SendCodeResult> {
    const email = rawEmail.trim().toLowerCase();
    const locked = await this.checkLock(email, ip);
    if (locked > 0) return { ok: false, reason: 'rate_limited', retryAfterMs: locked };

    const recent = await this.repos.loginCodes.countSince(email, new Date(Date.now() - CODE_RATE_WINDOW_MS));
    if (recent >= CODE_RATE_MAX) return { ok: false, reason: 'rate_limited', retryAfterMs: CODE_RATE_WINDOW_MS };

    const user = await this.repos.users.findByEmail(email);
    if (!user) {
      // Conta como tentativa (evita enumeração em massa) e finge sucesso.
      await this.repos.loginAttempts.recordFailure(`ip:${ip}`);
      return { ok: true };
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ttl = config.auth.loginCodeTtlMs;
    await this.repos.loginCodes.invalidateAll(email);
    await this.repos.loginCodes.create(email, this.hashCode(email, code), new Date(Date.now() + ttl));
    try {
      await this.mailer.send(loginCodeMail(email, code, Math.round(ttl / 60000), user.locale ?? fallbackLocale));
    } catch {
      return { ok: false, reason: 'send_failed' };
    }
    return { ok: true };
  }

  async verifyLoginCode(rawEmail: string, code: string, ip: string): Promise<LoginResult> {
    const email = rawEmail.trim().toLowerCase();
    const locked = await this.checkLock(email, ip);
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };

    const record = await this.repos.loginCodes.findLatestUnused(email);
    const fail = async (): Promise<LoginResult> => {
      const lock = await this.recordFailure(email, ip);
      return lock > 0 ? { ok: false, reason: 'locked', retryAfterMs: lock } : { ok: false, reason: 'invalid' };
    };

    if (!record || record.expires_at.getTime() < Date.now()) return fail();
    const attempts = await this.repos.loginCodes.incrementAttempts(record.id);
    if (attempts > CODE_MAX_ATTEMPTS) {
      await this.repos.loginCodes.markUsed(record.id);
      return fail();
    }
    if (!safeEqual(record.code_hash, this.hashCode(email, code.trim()))) return fail();

    const user = await this.repos.users.findByEmail(email);
    if (!user) return fail();

    await this.repos.loginCodes.invalidateAll(email);
    await this.clearFailures(email, ip);
    return { ok: true, user };
  }

  // ---------- Google ----------

  /** Google só entra se o e-mail já estiver cadastrado. Vincula google_id na primeira vez. */
  async loginWithGoogle(profile: { sub: string; email: string; emailVerified: boolean; picture?: string; name?: string }): Promise<User | null> {
    if (!profile.emailVerified) return null;
    const byGoogle = await this.repos.users.findByGoogleId(profile.sub);
    if (byGoogle) return byGoogle;
    const byEmail = await this.repos.users.findByEmail(profile.email);
    if (!byEmail) {
      // First sign-in with an unknown Google account: create the user with the default role when
      // AUTH_GOOGLE_SIGNUP=true (sensible behind Cloudflare Access, which already gates who gets here).
      if (!config.auth.googleSignup) return null;
      const role = (await this.repos.roles.findByName(config.auth.defaultRole)) ?? (await this.repos.roles.findByName('AUTHENTICATED'));
      if (!role) return null;
      const created = await this.repos.users.create({
        email: profile.email,
        name: profile.name?.trim() || profile.email.split('@')[0],
        role_id: role.id,
        role: role.is_admin ? 'owner' : 'member',
        avatar_url: profile.picture ?? null,
      });
      await this.repos.users.linkGoogle(created.id, profile.sub, profile.picture);
      return (await this.repos.users.findById(created.id)) ?? null;
    }
    if (byEmail.google_id && byEmail.google_id !== profile.sub) return null;
    await this.repos.users.linkGoogle(byEmail.id, profile.sub, profile.picture);
    return (await this.repos.users.findById(byEmail.id)) ?? null;
  }

  // ---------- sessões ----------

  /** Cria sessão e devolve o token opaco (só o hash vai pro banco). */
  async createSession(userId: string): Promise<{ token: string; csrf: string; expiresAt: Date }> {
    const token = generateToken(32);
    const expiresAt = new Date(Date.now() + config.auth.sessionTtlMs);
    await this.repos.sessions.create(userId, hashToken(token), expiresAt);
    await this.repos.users.touchLogin(userId);
    return { token, csrf: generateToken(24), expiresAt };
  }

  async resolveSession(token: string): Promise<User | null> {
    const found = await this.repos.sessions.findValidByTokenHash(hashToken(token));
    return found?.user ?? null;
  }

  async destroySession(token: string): Promise<void> {
    await this.repos.sessions.deleteByTokenHash(hashToken(token));
  }

  async purgeExpired(): Promise<void> {
    const eventsCutoff = new Date(Date.now() - API_TOKEN_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await Promise.all([this.repos.sessions.purgeExpired(), this.repos.loginCodes.purgeExpired(), this.repos.apiTokens.purgeEventsBefore(eventsCutoff)]);
  }
}
