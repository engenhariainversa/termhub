import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import type { Device } from '../db/repositories/devices.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Mailer } from '../email/mailer.js';
import { deviceRevokedMail } from '../email/templates.js';

/** Why a device was revoked, and who did it; written to the device trail as `device_revoked`. */
export interface RevokeInput {
  reason: 'user' | 'admin' | 'pin_bruteforce' | 'review';
  actor: string;
  ip?: string | null;
}

/**
 * Tracks which devices currently hold a live socket (chat, later push delivery), so a revoke can
 * close the connection immediately instead of waiting for the device's next request to hit the
 * revoked token. Sockets register themselves through `add`, which returns the release function to
 * call on their own 'close' — the registry never listens for socket events itself.
 */
export class MobileSocketRegistry {
  private readonly byDevice = new Map<string, Set<WebSocket>>();
  private readonly byUser = new Map<string, Set<string>>();

  add(deviceId: string, ws: WebSocket, userId: string): () => void {
    let sockets = this.byDevice.get(deviceId);
    if (!sockets) {
      sockets = new Set();
      this.byDevice.set(deviceId, sockets);
    }
    sockets.add(ws);

    let devices = this.byUser.get(userId);
    if (!devices) {
      devices = new Set();
      this.byUser.set(userId, devices);
    }
    devices.add(deviceId);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const set = this.byDevice.get(deviceId);
      set?.delete(ws);
      if (set && set.size === 0) {
        this.byDevice.delete(deviceId);
        const userDevices = this.byUser.get(userId);
        userDevices?.delete(deviceId);
        if (userDevices && userDevices.size === 0) this.byUser.delete(userId);
      }
    };
  }

  /**
   * Closes every live socket for a device and forgets them at once, so `hasLive`/`liveDevices`
   * stop reporting a revoked device before the sockets' own 'close' events arrive (their release
   * functions then find nothing left to remove). Returns how many were closed.
   */
  closeDevice(deviceId: string, code: number, reason: string): number {
    const sockets = this.byDevice.get(deviceId);
    if (!sockets) return 0;
    this.byDevice.delete(deviceId);
    for (const [userId, devices] of this.byUser) {
      if (devices.delete(deviceId) && devices.size === 0) this.byUser.delete(userId);
    }
    for (const ws of sockets) ws.close(code, reason);
    return sockets.size;
  }

  hasLive(deviceId: string): boolean {
    return (this.byDevice.get(deviceId)?.size ?? 0) > 0;
  }

  /** A snapshot, not a live view: safe for a caller to iterate while sockets close. */
  liveDevices(userId: string): Set<string> {
    return new Set(this.byUser.get(userId) ?? []);
  }
}

const failureLabel = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return err instanceof Error ? err.name : typeof err;
};

/**
 * Revokes a device, in this order: flip its status (conditional, so a second call or a race returns
 * undefined and does nothing else), clear its push token, record
 * `device_revoked`, close any live socket with 4401, and — only for a PIN brute-force, which the
 * owner did not ask for — mail the owner. A mail failure never undoes or fails the revoke.
 * The device's access tokens are kept on purpose: `findValidToken` already refuses a token whose
 * device is not active, and keeping the row lets the auth hook answer DEVICE_REVOKED (so the app
 * wipes itself) instead of TOKEN_EXPIRED. The hourly purge removes them once they expire.
 */
export async function revokeDevice(
  deps: { repos: Repositories; sockets: MobileSocketRegistry; mailer: Mailer; log?: FastifyBaseLogger; now?: () => Date },
  deviceId: string,
  input: RevokeInput,
): Promise<Device | undefined> {
  const { repos } = deps;
  const now = deps.now?.() ?? new Date();
  const device = await repos.devices.revoke(deviceId, input.reason, now);
  if (!device) return undefined;
  await repos.devices.setPushToken(deviceId, null);
  await repos.deviceEvents.record({ user_id: device.user_id, device_id: deviceId, kind: 'device_revoked', actor: input.actor, ip: input.ip ?? null, meta: { reason: input.reason } });
  deps.sockets.closeDevice(deviceId, 4401, 'device revoked');
  if (input.reason === 'pin_bruteforce') {
    try {
      const owner = await repos.users.findById(device.user_id);
      if (owner) await deps.mailer.send(deviceRevokedMail(owner.email, { deviceLabel: `${device.name} (${device.model})`, at: now }));
    } catch (err) {
      deps.log?.warn({ err: failureLabel(err), deviceId }, 'device revoked mail failed');
    }
  }
  return device;
}
