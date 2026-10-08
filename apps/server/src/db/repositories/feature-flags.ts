import type { PrismaClient } from '../prisma.js';

/** A flag's instance-wide row (`FeatureFlag`). No row = the flag's default in code. */
export interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}

/** One person's own value for a flag, with who they are for the admin screen. */
export interface FeatureFlagOverride {
  flag: string;
  user_id: string;
  email: string;
  name: string;
  enabled: boolean;
  created_at: string;
}

/** Instance-wide feature flags and per-user overrides (TER-1040, docs/feature-flags.md). */
export class FeatureFlagsRepository {
  constructor(private db: PrismaClient) {}

  /** The instance-wide value, or null when nobody has set it (the default in code applies). */
  async instanceValue(key: string): Promise<boolean | null> {
    const row = await this.db.featureFlag.findUnique({ where: { key } });
    return row ? row.enabled : null;
  }

  /** This person's own value, or null when they follow the instance. */
  async overrideFor(key: string, userId: string): Promise<boolean | null> {
    const row = await this.db.featureFlagOverride.findUnique({ where: { flag_userId: { flag: key, userId } } });
    return row ? row.enabled : null;
  }

  /** Whether anyone has the flag turned on for themselves (a provider webhook must stay live for them). */
  async anyOverrideOn(key: string): Promise<boolean> {
    return (await this.db.featureFlagOverride.count({ where: { flag: key, enabled: true } })) > 0;
  }

  async list(): Promise<FeatureFlagRow[]> {
    const rows = await this.db.featureFlag.findMany({ orderBy: { key: 'asc' } });
    return rows.map((r) => ({ key: r.key, enabled: r.enabled, updated_at: r.updatedAt.toISOString(), updated_by: r.updatedBy }));
  }

  async listOverrides(key: string): Promise<FeatureFlagOverride[]> {
    const rows = await this.db.featureFlagOverride.findMany({
      where: { flag: key },
      include: { user: { select: { email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ flag: r.flag, user_id: r.userId, email: r.user.email, name: r.user.name, enabled: r.enabled, created_at: r.createdAt.toISOString() }));
  }

  async setInstance(key: string, enabled: boolean, by: string | null): Promise<void> {
    await this.db.featureFlag.upsert({ where: { key }, create: { key, enabled, updatedBy: by }, update: { enabled, updatedBy: by } });
  }

  async setOverride(key: string, userId: string, enabled: boolean, by: string | null): Promise<void> {
    await this.db.featureFlagOverride.upsert({
      where: { flag_userId: { flag: key, userId } },
      create: { flag: key, userId, enabled, createdBy: by },
      update: { enabled },
    });
  }

  /** false when the person had no override. */
  async removeOverride(key: string, userId: string): Promise<boolean> {
    const { count } = await this.db.featureFlagOverride.deleteMany({ where: { flag: key, userId } });
    return count > 0;
  }
}
