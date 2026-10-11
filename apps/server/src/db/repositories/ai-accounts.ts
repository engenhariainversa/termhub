import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapAiAccount, type AiAccount, type AiProvider } from './types.js';

export interface AiAccountInput {
  provider: AiProvider;
  label: string;
  machine_id: string;
  config_dir?: string | null;
  /** TER-990: the only project the account may run in; null clears it. */
  exclusive_project_id?: string | null;
}

/** Every read carries the exclusive project's name: the errors and badges name it (TER-990). */
const include = { exclusiveProject: { select: { id: true, name: true } } } as const;

export class AiAccountsRepository {
  constructor(private db: PrismaClient) {}

  /** `owner`: only accounts on machines of that user (null = all). */
  async list(owner: string | null = null): Promise<AiAccount[]> {
    return (await this.db.aiAccount.findMany({ where: owner ? { machine: { ownerId: owner } } : {}, include, orderBy: { createdAt: 'asc' } })).map(mapAiAccount);
  }

  async findById(id: string): Promise<AiAccount | undefined> {
    const a = await this.db.aiAccount.findUnique({ where: { id }, include });
    return a ? mapAiAccount(a) : undefined;
  }

  async create(input: AiAccountInput): Promise<AiAccount> {
    const a = await this.db.aiAccount.create({
      data: { id: newId(), provider: input.provider, label: input.label, machineId: input.machine_id, configDir: input.config_dir ?? null, exclusiveProjectId: input.exclusive_project_id ?? null },
      include,
    });
    return mapAiAccount(a);
  }

  async update(id: string, patch: Partial<AiAccountInput>): Promise<AiAccount | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const a = await this.db.aiAccount.update({
      where: { id },
      data: {
        label: patch.label ?? current.label,
        machineId: patch.machine_id ?? current.machine_id,
        configDir: patch.config_dir === undefined ? current.config_dir : patch.config_dir,
        ...(patch.exclusive_project_id === undefined ? {} : { exclusiveProjectId: patch.exclusive_project_id }),
      },
      include,
    });
    return mapAiAccount(a);
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.db.aiAccount.deleteMany({ where: { id } });
    return r.count > 0;
  }
}
