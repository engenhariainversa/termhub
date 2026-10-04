import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { canonicalHtu } from '@termhub/mobile-api';
import { hashToken } from '../auth/tokens.js';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import { rejectUpgrade } from '../ws/router.js';
import { MOBILE_TOKEN_RE } from './codes.js';
import { isPendingDeletion } from '../account/deletion.js';
import { verifyProof, type JtiCache } from './dpop.js';

export interface MobileUpgradeDeps {
  repos: Repositories;
  jtis: JtiCache;
  /** The mobile API's public base URL: proofs are bound to `<publicUrl><path of the socket>`. */
  publicUrl: string;
}

/**
 * The checks every phone socket runs before its upgrade, like the REST prefix does: the Origin, the
 * `Authorization: Bearer thb_mob_…` token, a DPoP proof over `GET <publicUrl><path>` bound to that
 * token, and the token's user. Rejects the upgrade itself and returns null, or returns who is
 * connecting. Permission checks stay with each socket. Never logs a token or a proof.
 */
export async function authenticateMobileUpgrade(
  deps: MobileUpgradeDeps,
  ctx: { req: IncomingMessage; socket: Duplex; url: URL },
): Promise<{ user: User; deviceId: string } | null> {
  const { req, socket, url } = ctx;
  // React Native's WebSocket (SocketRocket on iOS, OkHttp on Android) always sends the socket
  // URL's own origin, and the app cannot drop it. Any other Origin is a page elsewhere trying
  // its luck; it could not send the bearer token and proof anyway, so refuse it outright.
  const origin = req.headers.origin;
  if (origin && origin !== new URL(deps.publicUrl).origin) return reject(socket, 403, 'Forbidden');
  const raw = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!MOBILE_TOKEN_RE.test(raw)) return reject(socket, 401, 'Unauthorized');
  const found = await deps.repos.deviceSessions.findValidToken(hashToken(raw), new Date());
  if (!found) return reject(socket, 401, 'Unauthorized');
  let publicKeyJwk: JsonWebKey;
  try {
    publicKeyJwk = JSON.parse(found.device.public_key) as JsonWebKey;
  } catch {
    return reject(socket, 401, 'Unauthorized');
  }
  const proof = await verifyProof({
    proof: String(req.headers.dpop ?? ''),
    htm: 'GET',
    htu: canonicalHtu(deps.publicUrl, url.pathname),
    publicKeyJwk,
    accessToken: raw,
  });
  // The jti is claimed only once the signature has verified, so garbage cannot fill the cache.
  if (!proof.ok || !deps.jtis.claim(found.device.id, proof.jti)) return reject(socket, 401, 'Unauthorized');
  const user = await deps.repos.users.findById(found.device.user_id);
  // A deactivated account (deletion pending, TER-720) opens no socket: only the cancel path is left.
  if (!user || isPendingDeletion(user)) return reject(socket, 403, 'Forbidden');
  return { user, deviceId: found.device.id };
}

function reject(socket: Duplex, status: number, text: string): null {
  rejectUpgrade(socket, status, text);
  return null;
}
