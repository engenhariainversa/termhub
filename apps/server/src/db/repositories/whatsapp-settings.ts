import type { PrismaClient } from '../prisma.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';

/** TER-1201: the person's Evolution API setup, as the server uses it. The API key never leaves through here. */
export interface WhatsappSettings {
  user_id: string;
  server_url: string;
  instance: string;
  number: string;
  enabled: boolean;
  notify_needs_you: boolean;
  notify_done: boolean;
  last_sent_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  updated_at: string;
}

export interface WhatsappSettingsInput {
  server_url: string;
  instance: string;
  number: string;
  enabled: boolean;
  notify_needs_you: boolean;
  notify_done: boolean;
  /** Absent or empty keeps the stored key (the screen never shows it back). */
  api_key?: string;
}

type Row = {
  userId: string;
  serverUrl: string;
  instance: string;
  number: string;
  enabled: boolean;
  notifyNeedsYou: boolean;
  notifyDone: boolean;
  lastSentAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  updatedAt: Date;
};

const map = (r: Row): WhatsappSettings => ({
  user_id: r.userId,
  server_url: r.serverUrl,
  instance: r.instance,
  number: r.number,
  enabled: r.enabled,
  notify_needs_you: r.notifyNeedsYou,
  notify_done: r.notifyDone,
  last_sent_at: r.lastSentAt?.toISOString() ?? null,
  last_error: r.lastError,
  last_error_at: r.lastErrorAt?.toISOString() ?? null,
  updated_at: r.updatedAt.toISOString(),
});

const omitKey = { userId: true, serverUrl: true, instance: true, number: true, enabled: true, notifyNeedsYou: true, notifyDone: true, lastSentAt: true, lastError: true, lastErrorAt: true, updatedAt: true } as const;

export class WhatsappSettingsRepository {
  constructor(private db: PrismaClient) {}

  async get(userId: string): Promise<WhatsappSettings | null> {
    const r = await this.db.whatsappSettings.findUnique({ where: { userId }, select: omitKey });
    return r ? map(r) : null;
  }

  /** The stored API key in clear, for a request to the person's own server. */
  async apiKey(userId: string): Promise<string | null> {
    const r = await this.db.whatsappSettings.findUnique({ where: { userId }, select: { apiKey: true } });
    return r ? decryptSecret(r.apiKey) : null;
  }

  /**
   * Creates or replaces the setup. A first save needs `api_key`; an update without one keeps the stored
   * key. A save clears the last error: it was about the setup being replaced.
   */
  async save(userId: string, input: WhatsappSettingsInput): Promise<WhatsappSettings> {
    const fields = {
      serverUrl: input.server_url,
      instance: input.instance,
      number: input.number,
      enabled: input.enabled,
      notifyNeedsYou: input.notify_needs_you,
      notifyDone: input.notify_done,
      lastError: null,
      lastErrorAt: null,
    };
    const key = input.api_key ? { apiKey: encryptSecret(input.api_key) } : {};
    const existing = await this.db.whatsappSettings.findUnique({ where: { userId }, select: { userId: true } });
    if (!existing) {
      if (!input.api_key) throw new Error('WHATSAPP_KEY_REQUIRED');
      return map(await this.db.whatsappSettings.create({ data: { userId, ...fields, apiKey: encryptSecret(input.api_key) }, select: omitKey }));
    }
    return map(await this.db.whatsappSettings.update({ where: { userId }, data: { ...fields, ...key }, select: omitKey }));
  }

  async delete(userId: string): Promise<boolean> {
    return (await this.db.whatsappSettings.deleteMany({ where: { userId } })).count > 0;
  }

  /** Records a delivery: `error` null = it went out. */
  async noteDelivery(userId: string, error: string | null, at: Date = new Date()): Promise<void> {
    await this.db.whatsappSettings.updateMany({
      where: { userId },
      data: error === null ? { lastSentAt: at, lastError: null, lastErrorAt: null } : { lastError: error.slice(0, 64), lastErrorAt: at },
    });
  }
}
