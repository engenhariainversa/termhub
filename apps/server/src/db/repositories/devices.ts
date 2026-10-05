import type { PrismaClient } from '../prisma.js';
import type { Device as PrismaDevice } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

export type DeviceStatus = 'active' | 'revoked';

const TOUCH_INTERVAL_MS = 60_000;

/** An enrolled phone as routes see it: never `pin_secret_enc` — see `pinSecretEnc` for that. */
export interface Device {
  id: string;
  user_id: string;
  name: string;
  platform: string;
  model: string;
  os_version: string;
  app_version: string;
  public_key: string;
  key_thumbprint: string;
  pin_failures: number;
  pin_locked_until: string | null;
  status: DeviceStatus;
  revoked_at: string | null;
  revoked_reason: string | null;
  push_token: string | null;
  last_seen_at: string | null;
  last_ip: string | null;
  request_id: string | null;
  created_at: string;
}

export interface DeviceCreateInput {
  user_id: string;
  name: string;
  platform: string;
  model: string;
  os_version: string;
  app_version: string;
  public_key: string;
  key_thumbprint: string;
  pin_secret_enc: string;
  request_id: string | null;
}

export const mapDevice = (d: PrismaDevice): Device => ({
  id: d.id,
  user_id: d.userId,
  name: d.name,
  platform: d.platform,
  model: d.model,
  os_version: d.osVersion,
  app_version: d.appVersion,
  public_key: d.publicKey,
  key_thumbprint: d.keyThumbprint,
  pin_failures: d.pinFailures,
  pin_locked_until: d.pinLockedUntil?.toISOString() ?? null,
  status: d.status as DeviceStatus,
  revoked_at: d.revokedAt?.toISOString() ?? null,
  revoked_reason: d.revokedReason,
  push_token: d.pushToken,
  last_seen_at: d.lastSeenAt?.toISOString() ?? null,
  last_ip: d.lastIp,
  request_id: d.requestId,
  created_at: d.createdAt.toISOString(),
});

export class DevicesRepository {
  constructor(private db: PrismaClient) {}

  /** Rejects with Prisma P2002 when `key_thumbprint` is already enrolled (unique index). */
  async create(input: DeviceCreateInput): Promise<Device> {
    const d = await this.db.device.create({
      data: {
        id: newId(),
        userId: input.user_id,
        name: input.name,
        platform: input.platform,
        model: input.model,
        osVersion: input.os_version,
        appVersion: input.app_version,
        publicKey: input.public_key,
        keyThumbprint: input.key_thumbprint,
        pinSecretEnc: input.pin_secret_enc,
        requestId: input.request_id,
      },
    });
    return mapDevice(d);
  }

  async findById(id: string): Promise<Device | undefined> {
    const d = await this.db.device.findFirst({ where: { id } });
    return d ? mapDevice(d) : undefined;
  }

  async findActiveById(id: string): Promise<Device | undefined> {
    const d = await this.db.device.findFirst({ where: { id, status: 'active' } });
    return d ? mapDevice(d) : undefined;
  }

  /** The wrapped PIN secret, for the PIN-unlock flow only — never part of the DTO. */
  async pinSecretEnc(id: string): Promise<string | undefined> {
    const d = await this.db.device.findFirst({ where: { id }, select: { pinSecretEnc: true } });
    return d?.pinSecretEnc;
  }

  async listByUser(userId: string): Promise<Device[]> {
    const rows = await this.db.device.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.map(mapDevice);
  }

  async countActive(userId: string): Promise<number> {
    return this.db.device.count({ where: { userId, status: 'active' } });
  }

  async rename(id: string, userId: string, name: string): Promise<Device | undefined> {
    const { count } = await this.db.device.updateMany({ where: { id, userId }, data: { name } });
    if (count === 0) return undefined;
    const d = await this.db.device.findFirst({ where: { id, userId } });
    return d ? mapDevice(d) : undefined;
  }

  /** Conditional on the device still being active, so a second revoke (or a race between two)
   * returns undefined rather than the already-revoked row. */
  async revoke(id: string, reason: string, now: Date): Promise<Device | undefined> {
    const { count } = await this.db.device.updateMany({ where: { id, status: 'active' }, data: { status: 'revoked', revokedAt: now, revokedReason: reason } });
    if (count === 0) return undefined;
    const d = await this.db.device.findFirst({ where: { id } });
    return d ? mapDevice(d) : undefined;
  }

  async recordPinFailure(id: string): Promise<{ failures: number }> {
    const d = await this.db.device.update({ where: { id }, data: { pinFailures: { increment: 1 } }, select: { pinFailures: true } });
    return { failures: d.pinFailures };
  }

  async lockUntil(id: string, until: Date): Promise<void> {
    await this.db.device.update({ where: { id }, data: { pinLockedUntil: until } });
  }

  async resetPin(id: string): Promise<void> {
    await this.db.device.update({ where: { id }, data: { pinFailures: 0, pinLockedUntil: null } });
  }

  async setPushToken(id: string, token: string | null): Promise<void> {
    await this.db.device.update({ where: { id }, data: { pushToken: token } });
  }

  /** Clears the push token only while it is still `token`: a newer one registered since stays. */
  async clearPushTokenIf(id: string, token: string): Promise<boolean> {
    return (await this.db.device.updateMany({ where: { id, pushToken: token }, data: { pushToken: null } })).count > 0;
  }

  async findByPushToken(token: string): Promise<Device | undefined> {
    const d = await this.db.device.findFirst({ where: { pushToken: token } });
    return d ? mapDevice(d) : undefined;
  }

  /** Records a use; skips the write when the last one is under a minute old — like
   * `ApiTokensRepository.touchLastUsed`. */
  async touchSeen(id: string, ip: string, now: Date): Promise<void> {
    await this.db.device.updateMany({
      where: { id, OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: new Date(now.getTime() - TOUCH_INTERVAL_MS) } }] },
      data: { lastSeenAt: now, lastIp: ip },
    });
  }

  async listActiveWithPush(userId: string): Promise<Device[]> {
    const rows = await this.db.device.findMany({ where: { userId, status: 'active', pushToken: { not: null } } });
    return rows.map(mapDevice);
  }
}
