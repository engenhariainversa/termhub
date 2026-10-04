import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { toPublicUser, type User } from '../db/repositories/types.js';
import type { Role } from '../db/repositories/roles.js';
import type { Device } from '../db/repositories/devices.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import type { Mailer } from '../email/mailer.js';
import { alphaInviteMail, inviteMail, type AlphaLocale } from '../email/templates.js';
import type { Mail } from '../email/mailer.js';
import type { AccessAllowlist } from '../cloudflare/access.js';
import type { RevokeInput } from '../mobile/revocation.js';
import { canAccess, isAdmin } from '../auth/permissions.js';
import { failureLabel } from '../chat/service.js';
import { config } from '../config.js';
import { describeDeviceEvent } from './devices.js';
import type { AccountDeletionService } from '../account/deletion.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const deviceParams = z.object({ id: z.string().min(1).max(64), deviceId: z.string().min(1).max(64) });
const patchBody = z.object({ role_id: z.string().min(1).max(64) });
const inviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().max(120).optional(),
  role_id: z.string().min(1).max(64),
});
const inviteFromWaitlistBody = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(200),
  role_id: z.string().min(1).max(64),
});
const reviewBody = z.object({
  days: z.union([z.literal(1), z.literal(3), z.literal(7)]).nullable(),
  revoke_devices: z.boolean().default(false),
});
const DAY_MS = 24 * 60 * 60 * 1000;

const mobileDisabled = () => new HttpError(503, 'O app mobile não está habilitado neste servidor', 'MOBILE_DISABLED');

export interface UserRouteDeps {
  mailer: Mailer;
  access: AccessAllowlist;
  /** The same cascade as a self-service deletion (TER-720), without the 30-day window. */
  deletion: Pick<AccountDeletionService, 'purge'>;
  /** null when this server has no mobile app configured (config.mobile unset) — see app.ts. */
  revoke: ((deviceId: string, input: RevokeInput) => Promise<Device | undefined>) | null;
}

/** Outcome of the two side effects of an invite; the user row itself is never rolled back. */
interface InviteSideEffects {
  access: { configured: boolean; synced: boolean; error?: string };
  mail: { sent: boolean; error?: string };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The user-admin view of an account: the public user plus its role and who turned review mode on. */
function withRoleInfo(u: User, role: Role | undefined) {
  return { ...toPublicUser(u), review_enabled_by: u.review_enabled_by, role_info: role ? { id: role.id, name: role.name, label: role.label, is_admin: role.is_admin } : null };
}

/** User administration. Guarded as resource "users" (see app.ts). */
export async function userRoutes(app: FastifyInstance, repos: Repositories, deps: UserRouteDeps) {
  /** Allowlist the e-mail and send the invite; failures are reported, not thrown (the user already exists). */
  async function runInvite(user: User, role: Role, invitedBy: string, log: FastifyBaseLogger, mail?: (accessAllowlisted: boolean) => Mail): Promise<InviteSideEffects> {
    const out: InviteSideEffects = { access: { configured: !!config.cloudflareAccess, synced: false }, mail: { sent: false } };
    if (config.cloudflareAccess) {
      try {
        await deps.access.add(user.email);
        out.access.synced = true;
      } catch (err) {
        out.access.error = errMessage(err);
        log.warn({ err, userId: user.id }, 'invite: cloudflare access allowlist failed');
      }
    }
    try {
      await deps.mailer.send(
        mail ? mail(out.access.synced) : inviteMail(user.email, { invitedBy, appUrl: config.publicUrl, roleLabel: role.label, accessAllowlisted: out.access.synced }),
      );
      out.mail.sent = true;
    } catch (err) {
      out.mail.error = errMessage(err);
      log.warn({ err, userId: user.id }, 'invite: e-mail failed');
    }
    return out;
  }

  app.get('/', async () => {
    const [users, roles] = await Promise.all([repos.users.list(), repos.roles.list()]);
    const byId = new Map(roles.map((r) => [r.id, r]));
    return { users: users.map((u) => withRoleInfo(u, u.role_id ? byId.get(u.role_id) : undefined)) };
  });

  /** Cloudflare Access allowlist as seen from the API (which e-mails can reach the app). */
  app.get('/access', async () => {
    try {
      return await deps.access.status();
    } catch (err) {
      return { configured: true, domain: config.cloudflareAccess?.appDomain, emails: [], error: errMessage(err) };
    }
  });

  /** Invite = create the user with a role (no password: Google or e-mail code), allowlist and e-mail. */
  app.post('/invite', async (request, reply) => {
    const body = inviteBody.parse(request.body);
    const role = await repos.roles.findById(body.role_id);
    if (!role) throw badRequest('Role inexistente');
    if (await repos.users.findByEmail(body.email)) throw conflict('Já existe um usuário com este e-mail');
    const user = await repos.users.create({
      email: body.email,
      name: body.name || body.email.split('@')[0]!,
      role_id: role.id,
      role: role.is_admin ? 'owner' : 'member',
      invited_at: new Date(),
    });
    const effects = await runInvite(user, role, request.user?.name ?? 'Alguém', request.log);
    request.log.info({ userId: user.id, roleId: role.id, access: effects.access.synced, mail: effects.mail.sent }, 'user invited');
    return reply.code(201).send({ user: withRoleInfo(user, role), ...effects });
  });

  /**
   * Alpha invite from the Waitlist tab: for each entry, create the user with the chosen role
   * (or reuse the account that already has that e-mail), run the invite side effects with the
   * alpha-tester e-mail (app link + WhatsApp community, in the entry's language) and stamp
   * invited_at on the entry. Per-entry outcomes are reported, never thrown, so one bad
   * address does not stop the batch.
   */
  app.post('/invite-from-waitlist', async (request) => {
    const body = inviteFromWaitlistBody.parse(request.body);
    const role = await repos.roles.findById(body.role_id);
    if (!role) throw badRequest('Role inexistente');
    const entries = new Map((await repos.waitlist.findByIds(body.ids)).map((e) => [e.id, e]));
    const results: Array<{ id: string; error: string } | ({ id: string; user_id: string; existing: boolean } & InviteSideEffects)> = [];
    const invited: string[] = [];
    for (const id of body.ids) {
      const entry = entries.get(id);
      if (!entry) {
        results.push({ id, error: 'Entry not found' });
        continue;
      }
      let user = await repos.users.findByEmail(entry.email);
      const existing = !!user;
      if (!user) {
        user = await repos.users.create({
          email: entry.email,
          name: `${entry.first_name} ${entry.last_name}`.trim(),
          role_id: role.id,
          role: role.is_admin ? 'owner' : 'member',
          invited_at: new Date(),
        });
      }
      const locale: AlphaLocale = entry.locale === 'en' ? 'en' : 'pt';
      const effects = await runInvite(user, role, request.user?.name ?? 'Alguém', request.log, () =>
        alphaInviteMail(user!.email, { appUrl: config.publicUrl, communityUrl: config.alphaCommunityUrl, firstName: entry.first_name, locale }),
      );
      invited.push(id);
      results.push({ id, user_id: user.id, existing, ...effects });
    }
    await repos.waitlist.markInvited(invited);
    request.log.info({ invited: invited.length, roleId: role.id }, 'alpha invites sent from waitlist');
    return { results };
  });

  /** Re-run the invite side effects (e-mail bounced, allowlist edited by hand, …). */
  app.post('/:id/invite', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const user = await repos.users.findById(id);
    if (!user) throw notFound('Usuário não encontrado');
    const role = user.role_id ? await repos.roles.findById(user.role_id) : undefined;
    if (!role) throw badRequest('Usuário sem role; defina uma antes de reenviar o convite');
    const effects = await runInvite(user, role, request.user?.name ?? 'Alguém', request.log);
    return { user: withRoleInfo(user, role), ...effects };
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { role_id } = patchBody.parse(request.body);
    const user = await repos.users.findById(id);
    if (!user) throw notFound('Usuário não encontrado');
    const role = await repos.roles.findById(role_id);
    if (!role) throw badRequest('Role inexistente');
    // never leave the system without an admin
    if (!role.is_admin && user.role_id) {
      const current = await repos.roles.findById(user.role_id);
      if (current?.is_admin && (await repos.users.countAdmins()) <= 1) throw badRequest('Este é o único administrador; promova outro antes');
    }
    const updated = await repos.users.setRole(id, role.id, role.is_admin ? 'owner' : 'member');
    return { user: updated && withRoleInfo(updated, role) };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    if (id === request.user?.id) throw badRequest('Você não pode excluir a si mesmo');
    const user = await repos.users.findById(id);
    if (!user) throw notFound('Usuário não encontrado');
    if (user.role_id) {
      const role = await repos.roles.findById(user.role_id);
      if (role?.is_admin && (await repos.users.countAdmins()) <= 1) throw badRequest('Este é o único administrador');
    }
    // Everything the account owns goes with it (machines, projects, integrations, chat, files…),
    // and its public city, agents and Cloudflare Access entry are cleaned up after the commit.
    // No e-mail: the admin did this, not the person.
    if (!(await deps.deletion.purge(id, { actor: `admin:${request.user!.id}`, notify: false }))) throw notFound('Usuário não encontrado');
    return { ok: true };
  });

  /**
   * The store-review switch (spec: Apple/Google reviewers sign in with one ordinary account whose
   * device requests auto-approve while `review_enabled_until` is in the future — see
   * mobile/enrolment.ts). `days: null` turns it off. Refused on an admin target: an admin bypasses
   * every grant already, so auto-approving its device requests would hand a reviewer more than a
   * store review needs. The refusal is checked before any write.
   */
  app.post('/:id/review', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { days, revoke_devices } = reviewBody.parse(request.body);
    const target = await repos.users.findById(id);
    if (!target) throw notFound('Usuário não encontrado');
    if (await isAdmin(repos, target)) throw new HttpError(400, 'A conta de revisão não pode ser admin.', 'REVIEW_ADMIN');

    const until = days ? new Date(Date.now() + days * DAY_MS) : null;
    const updated = await repos.users.setReview(id, until, request.user!.id);
    await repos.deviceEvents.record({ user_id: target.id, kind: 'review_changed', actor: `admin:${request.user!.id}`, meta: { until: until ? until.toISOString() : null } });
    // Each revoke runs independently: one failing device (a stale row, a DB hiccup) must neither stop
    // the rest nor turn the flag change already written above into a 500 the admin cannot explain.
    let revokedDevices = 0;
    if (revoke_devices && deps.revoke) {
      const active = (await repos.devices.listByUser(id)).filter((d) => d.status === 'active');
      for (const d of active) {
        try {
          if (await deps.revoke(d.id, { reason: 'review', actor: `admin:${request.user!.id}` })) revokedDevices++;
        } catch (err) {
          request.log.warn({ err: failureLabel(err), deviceId: d.id }, 'review: device revoke failed');
        }
      }
    }
    const role = updated.role_id ? await repos.roles.findById(updated.role_id) : undefined;
    return { user: withRoleInfo(updated, role), revoked_devices: revokedDevices };
  });

  /** The target user's own devices and device trail, for the review panel (Settings → Usuários).
   *  `can_enrol` is the server-side answer to "does this account's role even let its app enrol
   *  devices" — the web panel's BETA-role note follows it instead of guessing from a role name. */
  app.get('/:id/devices', async (request) => {
    if (!deps.revoke) throw mobileDisabled();
    const { id } = idParam.parse(request.params);
    const target = await repos.users.findById(id);
    if (!target) throw notFound('Usuário não encontrado');
    const [devices, events, can_enrol] = await Promise.all([
      repos.devices.listByUser(id),
      repos.deviceEvents.listForUser(id, 50),
      canAccess(repos, target, 'devices', 'create'),
    ]);
    return { devices, events: events.map((e) => ({ ...e, text: describeDeviceEvent(e) })), can_enrol };
  });

  /** Admin revoke of one of the target's devices; 404 unless that device really belongs to `:id`. */
  app.delete('/:id/devices/:deviceId', async (request) => {
    if (!deps.revoke) throw mobileDisabled();
    const { id, deviceId } = deviceParams.parse(request.params);
    const existing = await repos.devices.findById(deviceId);
    if (!existing || existing.user_id !== id) throw notFound('Aparelho não encontrado');
    const device = await deps.revoke(deviceId, { reason: 'admin', actor: `admin:${request.user!.id}` });
    if (!device) throw notFound('Aparelho não encontrado');
    return { device };
  });
}
