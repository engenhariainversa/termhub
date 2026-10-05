import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type { deviceActivateBody, deviceRequestBody, deviceRequestResponse } from '@termhub/mobile-api';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { DeviceRequest } from '../db/repositories/device-requests.js';
import type { Device } from '../db/repositories/devices.js';
import type { Mailer } from '../email/mailer.js';
import { deviceRequestMail } from '../email/templates.js';
import { canAccess } from '../auth/permissions.js';
import { hashToken, safeEqual } from '../auth/tokens.js';
import { encryptSecret } from '../lib/crypto.js';
import { forbidden, HttpError, notFound } from '../lib/errors.js';
import { hashEmail, newMobileToken, newPinSecret, newRequestSecret, newVerificationCode } from './codes.js';
import { thumbprint } from './dpop.js';
import { SlidingWindow } from './rate-limit.js';
import { localeOf, t } from '../i18n/index.js';

export const REQUEST_TTL_MS = 10 * 60_000;
export const ACTIVATE_TTL_MS = 10 * 60_000;
export const MAX_ACTIVE_DEVICES = 5;
export const MAX_PENDING_PER_USER = 3;
export const POLL_AFTER_MS = 2000;
const ACCESS_TOKEN_TTL_MS = 15 * 60_000;

/** Where a call came from, as `clientLocation` reads it; written to every device event. */
export interface CallerLocation {
  ip: string;
  country: string | null;
  city: string | null;
}

export interface EnrolmentHooks {
  /** A real (non-decoy) request was created; push to the owner's other devices (Task 16). */
  onRequestCreated?: (user: User, request: DeviceRequest) => Promise<void>;
}

export interface EnrolmentDeps {
  repos: Repositories;
  mailer: Mailer;
  appUrl: string;
  log: FastifyBaseLogger;
  hooks?: EnrolmentHooks;
  now?: () => Date;
}

const rateLimited = () => new HttpError(429, 'Muitos pedidos; tente de novo em alguns minutos', 'RATE_LIMITED');
const codeExpired = () => new HttpError(409, 'O código expirou; peça um novo', 'CODE_EXPIRED');
const deviceLimit = () => new HttpError(409, 'Revogue um aparelho antes', 'DEVICE_LIMIT');
const notApproved = () => new HttpError(409, 'O pedido ainda não foi aprovado', 'NOT_APPROVED');
const requestClosed = () => new HttpError(409, 'Este pedido já foi encerrado', 'REQUEST_CLOSED');
const keyMismatch = () => new HttpError(401, 'A chave do aparelho não confere', 'PROOF_KEY_MISMATCH');
const requestNotFound = () => notFound('Pedido não encontrado');

/** A short, secret-free label for a failure: a mailer error can carry the recipient address. */
const failureLabel = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return err instanceof Error ? err.name : typeof err;
};

const isPrismaUniqueViolation = (err: unknown) => (err as { code?: unknown } | null)?.code === 'P2002';

/**
 * Enrolling a phone by e-mail (spec §4): the app asks, the owner approves on the web after checking
 * the code on both screens, the app activates with its hardware key and gets its PIN secret.
 *
 * `request()` is built so the app learns nothing about the account: every call — known e-mail,
 * unknown e-mail, account without `devices:create`, account over its pending limit — writes exactly
 * one row and answers the same shape. Rows that must never become a device are decoys
 * (`user_id: null`); they store the e-mail's hash only and simply expire.
 */
export class EnrolmentService {
  private readonly byEmail = new SlidingWindow(10 * 60_000, 3);
  private readonly byIp = new SlidingWindow(10 * 60_000, 10);
  private readonly mailPerUser = new SlidingWindow(60 * 60_000, 5);
  private readonly now: () => Date;

  constructor(private readonly deps: EnrolmentDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async request(input: z.infer<typeof deviceRequestBody>, ctx: CallerLocation): Promise<z.infer<typeof deviceRequestResponse>> {
    const now = this.now();
    const email = input.email; // already trim().toLowerCase() by the schema
    const emailHash = hashEmail(email);
    // Limits come before the lookup, so a refused call never touches the users table.
    if (!this.byEmail.take(emailHash) || !this.byIp.take(ctx.ip)) throw rateLimited();

    const { repos } = this.deps;
    const user = await repos.users.findByEmail(email);
    const allowed = user ? await canAccess(repos, user, 'devices', 'create') : false;
    const pending = user && allowed ? await repos.deviceRequests.countPendingForUser(user.id, now) : 0;
    const real = !!user && allowed && pending < MAX_PENDING_PER_USER;
    // Store-review mode is read once, here: the row carries the outcome, nothing re-reads the flag later.
    const review = real && user!.review_enabled_until !== null && new Date(user!.review_enabled_until) > now;

    const code = newVerificationCode();
    const secret = newRequestSecret();
    const row = await repos.deviceRequests.create({
      user_id: real ? user!.id : null,
      email_hash: emailHash,
      public_key: JSON.stringify(input.public_key),
      key_thumbprint: await thumbprint(input.public_key),
      platform: input.device.platform,
      model: input.device.model,
      os_version: input.device.os_version,
      device_name: input.device.name,
      app_version: input.app_version,
      verification_code: code,
      request_secret_hash: hashToken(secret),
      ip: ctx.ip,
      country: ctx.country,
      city: ctx.city,
      expires_at: new Date(now.getTime() + REQUEST_TTL_MS),
      status: review ? 'approved' : 'pending',
      activate_until: review ? new Date(now.getTime() + ACTIVATE_TTL_MS) : null,
    });

    if (real) {
      // Everything the real branch does beyond the row runs in the background: the response is
      // built at the same point, with the same latency, in every branch — and a failing mail,
      // event write or hook never turns into an error only real accounts can see.
      const owner = user!;
      const background = (p: Promise<unknown>, what: string) =>
        void p.catch((err) => this.deps.log.warn({ err: failureLabel(err), requestId: row.id }, what));
      background(repos.deviceEvents.record({ user_id: owner.id, request_id: row.id, kind: 'request_created', actor: 'user', ...ctx, meta: { model: row.model, platform: row.platform } }), 'device request event failed');
      if (review) background(repos.deviceEvents.record({ user_id: owner.id, request_id: row.id, kind: 'review_auto_approved', actor: 'system', ...ctx }), 'review auto-approval event failed');
      if (this.mailPerUser.take(owner.id)) {
        const locale = localeOf(owner.locale);
        const mail = deviceRequestMail(
          owner.email,
          {
            deviceLabel: `${row.model} (${row.platform === 'ios' ? 'iOS' : 'Android'} ${row.os_version})`,
            code,
            place: [row.city, row.country].filter(Boolean).join(', ') || t(locale, 'local desconhecido'),
            ip: row.ip,
            appUrl: this.deps.appUrl,
          },
          locale,
        );
        background(Promise.resolve().then(() => this.deps.mailer.send(mail)), 'device request mail failed');
      }
      const hook = this.deps.hooks?.onRequestCreated;
      if (hook) background(Promise.resolve().then(() => hook(owner, row)), 'device request hook failed');
    }

    return { request_id: row.id, request_secret: secret, verification_code: code, expires_at: row.expires_at, poll_after: POLL_AFTER_MS };
  }

  /**
   * Unknown ids and wrong secrets are `closed`. A decoy answers exactly like a real request nobody
   * approved — `pending` until `expires_at`, then `closed` — so polling reveals nothing either;
   * it can never become `approved`, since `decide` never matches a null `user_id`.
   */
  async poll(id: string, secret: string): Promise<{ status: 'pending' | 'approved' | 'closed' }> {
    const now = this.now();
    const found = await this.deps.repos.deviceRequests.findByIdWithSecretHash(id);
    if (!found || !safeEqual(hashToken(secret), found.request_secret_hash)) return { status: 'closed' };
    const r = found.request;
    switch (r.status) {
      case 'pending':
        return { status: new Date(r.expires_at) > now ? 'pending' : 'closed' };
      case 'approved':
        return { status: r.activate_until !== null && new Date(r.activate_until) > now ? 'approved' : 'closed' };
      default:
        return { status: 'closed' };
    }
  }

  async approve(id: string, user: User, ctx: CallerLocation): Promise<DeviceRequest> {
    const now = this.now();
    const { repos } = this.deps;
    if ((await repos.devices.countActive(user.id)) >= MAX_ACTIVE_DEVICES) {
      await this.assertOwn(id, user);
      throw deviceLimit();
    }
    const decided = await repos.deviceRequests.decide(id, user.id, 'approved', now, new Date(now.getTime() + ACTIVATE_TTL_MS));
    if (!decided) throw await this.whyNotDecided(id, user);
    await repos.deviceEvents.record({ user_id: user.id, request_id: id, kind: 'request_approved', actor: 'user', ...ctx, meta: { model: decided.model, platform: decided.platform } });
    return decided;
  }

  async deny(id: string, user: User, ctx: CallerLocation): Promise<DeviceRequest> {
    const now = this.now();
    const { repos } = this.deps;
    const decided = await repos.deviceRequests.decide(id, user.id, 'denied', now, null);
    if (!decided) throw await this.whyNotDecided(id, user);
    await repos.deviceEvents.record({ user_id: user.id, request_id: id, kind: 'request_denied', actor: 'user', ...ctx, meta: { model: decided.model, platform: decided.platform } });
    return decided;
  }

  /**
   * Turns an approved request into a device. Order matters: every check first, then
   * `markActivated` (the conditional flip) before anything is created, so a request that lost the
   * race with expiry — or a second activation — creates nothing.
   */
  async activate(
    input: z.infer<typeof deviceActivateBody>,
    proof: { jwk: JsonWebKey; thumbprint: string },
    ctx: CallerLocation,
  ): Promise<{ device: Device; pin_secret: string; access_token: string; expires_in: number }> {
    const now = this.now();
    const { repos } = this.deps;
    const found = await repos.deviceRequests.findByIdWithSecretHash(input.request_id);
    if (!found || !safeEqual(hashToken(input.request_secret), found.request_secret_hash)) throw requestNotFound();
    const r = found.request;

    switch (r.status) {
      case 'approved':
        if (r.activate_until === null || new Date(r.activate_until) <= now) throw codeExpired();
        break;
      case 'pending':
        throw new Date(r.expires_at) > now ? notApproved() : codeExpired();
      case 'expired':
        throw codeExpired();
      default:
        throw requestClosed();
    }
    // Only this key may finish what it started; the header JWK itself is never stored.
    if (!safeEqual(proof.thumbprint, r.key_thumbprint)) throw keyMismatch();

    // An approved row always has an owner; re-check the grant, it may have been withdrawn since.
    const owner = r.user_id ? await repos.users.findById(r.user_id) : undefined;
    if (!owner || !(await canAccess(repos, owner, 'devices', 'create'))) throw forbidden();
    // Approval checked the limit too, but two approvals inside the window can race.
    if ((await repos.devices.countActive(owner.id)) >= MAX_ACTIVE_DEVICES) throw deviceLimit();

    if (!(await repos.deviceRequests.markActivated(r.id))) throw codeExpired();

    const pinSecret = newPinSecret();
    let device: Device;
    try {
      device = await repos.devices.create({
        user_id: owner.id,
        name: r.device_name,
        platform: r.platform,
        model: r.model,
        os_version: r.os_version,
        app_version: r.app_version,
        public_key: r.public_key,
        key_thumbprint: r.key_thumbprint,
        pin_secret_enc: encryptSecret(pinSecret),
        request_id: r.id,
      });
    } catch (err) {
      if (isPrismaUniqueViolation(err)) throw new HttpError(409, 'Este aparelho já está cadastrado', 'DEVICE_EXISTS');
      throw err;
    }
    const accessToken = newMobileToken();
    await repos.deviceSessions.createToken(device.id, hashToken(accessToken), new Date(now.getTime() + ACCESS_TOKEN_TTL_MS));
    await repos.deviceEvents.record({ user_id: owner.id, device_id: device.id, request_id: r.id, kind: 'device_activated', actor: 'user', ...ctx, meta: { model: device.model, platform: device.platform } });
    return { device, pin_secret: pinSecret, access_token: accessToken, expires_in: ACCESS_TOKEN_TTL_MS / 1000 };
  }

  /** Hourly: flips stale requests to expired and writes the trail for the real ones (never decoys). */
  async expire(): Promise<number> {
    const now = this.now();
    const { repos } = this.deps;
    const stale = await repos.deviceRequests.listExpirable(now);
    const count = await repos.deviceRequests.expireOlderThan(now);
    for (const r of stale) {
      if (r.user_id === null) continue;
      await repos.deviceEvents.record({ user_id: r.user_id, request_id: r.id, kind: 'request_expired', actor: 'system', ip: r.ip, country: r.country, city: r.city });
    }
    return count;
  }

  /** 404 unless the request exists and is this user's — decoys and other accounts' rows included. */
  private async assertOwn(id: string, user: User): Promise<DeviceRequest> {
    const r = await this.deps.repos.deviceRequests.findById(id);
    if (!r || r.user_id !== user.id) throw requestNotFound();
    return r;
  }

  /** `decide` returned nothing: tell "not yours / unknown" (404) from "too late" and "already decided" (409). */
  private async whyNotDecided(id: string, user: User): Promise<HttpError> {
    let r: DeviceRequest;
    try {
      r = await this.assertOwn(id, user);
    } catch (err) {
      return err as HttpError;
    }
    if (r.status === 'expired' || (r.status === 'pending' && new Date(r.expires_at) <= this.now())) return codeExpired();
    return requestClosed();
  }
}
