import type { PrismaClient } from '../prisma.js';
import type { DeviceEvent as PrismaDeviceEvent } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

/** Every kind of entry in the device trail; the web's pt-BR sentences cover each one. */
export const DEVICE_EVENT_KINDS = [
  'request_created',
  'request_approved',
  'request_denied',
  'request_expired',
  'device_activated',
  'token_refreshed',
  'pin_failed',
  'pin_locked',
  'device_revoked',
  'push_token_set',
  'push_failed',
  'push_test',
  'review_auto_approved',
  'review_changed',
] as const;

export type DeviceEventKind = (typeof DEVICE_EVENT_KINDS)[number];

export interface DeviceEventInput {
  user_id?: string | null;
  device_id?: string | null;
  request_id?: string | null;
  kind: DeviceEventKind;
  actor: string;
  ip?: string | null;
  country?: string | null;
  city?: string | null;
  meta?: Record<string, unknown>;
}

/** One row of the device trail (spec §8). `meta` holds ids and names, never secrets. */
export interface DeviceEvent {
  id: string;
  user_id: string | null;
  device_id: string | null;
  request_id: string | null;
  kind: DeviceEventKind;
  actor: string;
  ip: string | null;
  country: string | null;
  city: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

const mapDeviceEvent = (e: PrismaDeviceEvent): DeviceEvent => ({
  id: e.id,
  user_id: e.userId,
  device_id: e.deviceId,
  request_id: e.requestId,
  kind: e.kind as DeviceEventKind,
  actor: e.actor,
  ip: e.ip,
  country: e.country,
  city: e.city,
  meta: (e.meta ?? {}) as Record<string, unknown>,
  created_at: e.createdAt.toISOString(),
});

export class DeviceEventsRepository {
  constructor(private db: PrismaClient) {}

  async record(e: DeviceEventInput): Promise<void> {
    await this.db.deviceEvent.create({
      data: {
        id: newId(),
        userId: e.user_id ?? null,
        deviceId: e.device_id ?? null,
        requestId: e.request_id ?? null,
        kind: e.kind,
        actor: e.actor,
        ip: e.ip ?? null,
        country: e.country ?? null,
        city: e.city ?? null,
        meta: (e.meta ?? {}) as never,
      },
    });
  }

  async listForUser(userId: string, limit = 50): Promise<DeviceEvent[]> {
    const rows = await this.db.deviceEvent.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(mapDeviceEvent);
  }

  async purgeBefore(cutoff: Date): Promise<number> {
    const r = await this.db.deviceEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  }
}
