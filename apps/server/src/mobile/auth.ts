import type { FastifyRequest } from 'fastify';
import { decodeProtectedHeader } from 'jose';
import { canonicalHtu, compareVersions, parseAppHeader } from '@termhub/mobile-api';
import type { Repositories } from '../db/repositories/index.js';
import type { Device } from '../db/repositories/devices.js';
import type { User } from '../db/repositories/types.js';
import { actionForMethod, canAccess } from '../auth/permissions.js';
import { hashToken } from '../auth/tokens.js';
import { HttpError, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { MOBILE_TOKEN_RE } from './codes.js';
import { verifyProof, type JtiCache } from './dpop.js';

// The mobile prefix's own authentication: a device access token plus a DPoP proof, and nothing
// else. It never reads a cookie or the Cloudflare Access header, and a personal API token is
// refused by the token regex before any database lookup. Never log a token or a proof.

/** Route config `mobileAuth`: 'none' = no auth, 'proof' = a DPoP proof alone, 'device' (default) = token + proof. */
export type MobileAuthMode = 'none' | 'proof' | 'device';

declare module 'fastify' {
  interface FastifyRequest {
    /** set by the mobile auth hook: the device and its user ('device'), or the proof's key ('proof') */
    mobile?: { device: Device; user: User } | { proofJwk: JsonWebKey; jwkThumbprint: string };
  }
}

export interface MobileAuthDeps {
  repos: Repositories;
  /** the public base the app signs `htu` against (the landing host, never PUBLIC_URL) */
  publicUrl: string;
  minAppVersion: string | null;
  jtis: JtiCache;
}

const header = (request: FastifyRequest, name: string): string | undefined => {
  const v = request.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Where a request comes from, as Cloudflare saw it (country and city are its geo headers). */
export function clientLocation(request: FastifyRequest): { ip: string; country: string | null; city: string | null } {
  return { ip: request.ip, country: header(request, 'cf-ipcountry') ?? null, city: header(request, 'cf-ipcity') ?? null };
}

const proofInvalid = (code: string) => new HttpError(401, 'Prova inválida', code);
const replayed = () => new HttpError(401, 'Prova repetida', 'PROOF_REPLAYED');

export function buildMobileAuthHook(deps: MobileAuthDeps) {
  return async function mobileAuthHook(request: FastifyRequest) {
    const cfg = (request.routeOptions?.config ?? {}) as { mobileAuth?: MobileAuthMode; resource?: string; action?: string };

    // The version gate comes first, on every route: an app too old to speak this API is told to
    // update before anything else can fail. No header is tolerated (a command-line client).
    const appHeader = header(request, 'x-termhub-app');
    if (appHeader !== undefined) {
      const app = parseAppHeader(appHeader);
      if (!app) throw badRequest('Cabeçalho X-Termhub-App inválido');
      if (deps.minAppVersion && compareVersions(app.version, deps.minAppVersion) < 0) {
        throw new HttpError(426, 'Atualize o app do termhub para continuar', 'APP_TOO_OLD');
      }
    }

    const mode = cfg.mobileAuth ?? 'device';
    if (mode === 'none') return;

    const htm = request.method.toUpperCase();
    const htu = canonicalHtu(deps.publicUrl, request.url);
    const proof = header(request, 'dpop') ?? '';

    if (mode === 'proof') {
      // No device yet (enrolment): the proof is checked against the key it carries, which proves
      // possession of that key; the route binds it to whatever it creates.
      if (!proof) throw proofInvalid('PROOF_MISSING');
      let jwk: JsonWebKey | undefined;
      try {
        jwk = decodeProtectedHeader(proof).jwk as JsonWebKey | undefined;
      } catch {
        throw proofInvalid('PROOF_INVALID');
      }
      if (!jwk) throw proofInvalid('PROOF_INVALID');
      const r = await verifyProof({ proof, htm, htu, publicKeyJwk: jwk });
      if (!r.ok) throw proofInvalid(r.code);
      if (!deps.jtis.claim(r.jwkThumbprint, r.jti)) throw replayed();
      request.mobile = { proofJwk: jwk, jwkThumbprint: r.jwkThumbprint };
      return;
    }

    const auth = header(request, 'authorization') ?? '';
    const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!MOBILE_TOKEN_RE.test(raw)) throw unauthorized();
    const tokenHash = hashToken(raw);
    const found = await deps.repos.deviceSessions.findValidToken(tokenHash, new Date());
    if (!found) {
      // Tell a revoked device apart from an unknown or expired token: the app wipes itself on the former.
      const any = await deps.repos.deviceSessions.findTokenAny(tokenHash);
      const dev = any ? await deps.repos.devices.findById(any.device_id) : undefined;
      if (dev?.status === 'revoked') throw new HttpError(401, 'Este aparelho foi removido da conta', 'DEVICE_REVOKED');
      // Expired, or already purged: the app renews on TOKEN_EXPIRED (spec 2026-09-24 §5). A token
      // that never existed gets the same answer — the renewal it triggers needs the key and the PIN secret.
      throw new HttpError(401, 'Sessão expirada.', 'TOKEN_EXPIRED');
    }
    const device = found.device;
    let publicKeyJwk: JsonWebKey;
    try {
      publicKeyJwk = JSON.parse(device.public_key) as JsonWebKey;
    } catch {
      throw proofInvalid('PROOF_INVALID');
    }
    const r = await verifyProof({ proof, htm, htu, publicKeyJwk, accessToken: raw });
    if (!r.ok) throw proofInvalid(r.code);
    // Claimed only after the signature verified, so a forged proof cannot burn a real jti.
    if (!deps.jtis.claim(device.id, r.jti)) throw replayed();
    const user = await deps.repos.users.findById(device.user_id);
    if (!user) throw unauthorized();
    request.user = user;
    // A phone always acts as its own user: no "view as" here.
    request.scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id };
    request.mobile = { device, user };
    void deps.repos.devices.touchSeen(device.id, request.ip, new Date()).catch(() => {});

    if (cfg.resource) {
      const action = cfg.action ?? actionForMethod(request.method);
      if (!(await canAccess(deps.repos, user, cfg.resource, action))) throw forbidden(`Sem permissão: ${cfg.resource}:${action}`);
    }
  };
}
