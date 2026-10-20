import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { isValidProjectKey } from '../../lib/project-key.js';
import { ensureDefaultColumns } from './task-board.js';
import { mapProject, type Project, type ProjectStatus } from './types.js';
import { LocalizedText, msg } from '../../i18n/index.js';

export interface ProjectInput {
  owner_id: string | null;
  key: string;
  name: string;
  status?: ProjectStatus;
  description?: string | null;
  is_public?: boolean;
  ai_memory_lessons?: boolean;
}

export type ProjectPatch = Partial<Pick<ProjectInput, 'name' | 'status' | 'description' | 'is_public' | 'ai_memory_lessons'>>;

export type ProjectRuleCode = 'KEY_INVALID' | 'KEY_TAKEN' | 'MACHINE_ALREADY_LINKED' | 'MACHINE_NOT_LINKED' | 'MACHINE_REQUIRED' | 'NO_MACHINE';

/** A project rule broken by the caller (pt-BR message, shown as is by the routes). */
export class ProjectRuleError extends Error {
  /** Non-enumerable, so equality checks on the error (tests, logs) see only code and message. */
  declare readonly localized: LocalizedText;
  constructor(
    readonly code: ProjectRuleCode,
    message: string | LocalizedText,
  ) {
    const localized = message instanceof LocalizedText ? message : new LocalizedText(message);
    super(localized.toString());
    Object.defineProperty(this, 'localized', { value: localized, enumerable: false });
    this.name = 'ProjectRuleError';
  }
}

export class ProjectsRepository {
  constructor(private db: PrismaClient) {}

  /** `owner`: only that user's projects (undefined/null = no filter). `machine_id`: only projects linked to it. */
  async list(filter?: { machine_id?: string; status?: ProjectStatus; owner?: string | null }): Promise<Project[]> {
    const rows = await this.db.project.findMany({
      where: {
        ...(filter?.machine_id ? { machines: { some: { machineId: filter.machine_id } } } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.owner ? { ownerId: filter.owner } : {}),
      },
      orderBy: { name: 'asc' },
    });
    return rows.map(mapProject);
  }

  async findById(id: string): Promise<Project | undefined> {
    const p = await this.db.project.findUnique({ where: { id } });
    return p ? mapProject(p) : undefined;
  }

  async findByKey(key: string): Promise<Project | undefined> {
    const p = await this.db.project.findUnique({ where: { key } });
    return p ? mapProject(p) : undefined;
  }

  /**
   * Batched by id, one query regardless of how many ids are asked for, filtered to one owner —
   * never "no filter": a caller that resolves names for one person's screen (e.g. the chat action
   * trail) must not be able to pass `null` and see everyone's. Another owner's project id is simply
   * absent from the result, like a row that does not exist.
   */
  async findByIdsForOwner(ids: string[], ownerId: string): Promise<Project[]> {
    if (ids.length === 0) return [];
    return (await this.db.project.findMany({ where: { id: { in: ids }, ownerId } })).map(mapProject);
  }

  /** false for an invalid key too, so the create form can show one answer for both. */
  async isKeyAvailable(key: string): Promise<boolean> {
    if (!isValidProjectKey(key)) return false;
    return (await this.db.project.count({ where: { key } })) === 0;
  }

  async create(input: ProjectInput): Promise<Project> {
    if (!isValidProjectKey(input.key)) throw new ProjectRuleError('KEY_INVALID', 'Chave inválida: 2 a 10 letras maiúsculas ou dígitos, começando com letra');
    if ((await this.db.project.count({ where: { key: input.key } })) > 0) throw new ProjectRuleError('KEY_TAKEN', msg('A chave {{key}} já está em uso', { key: input.key }));
    return this.db.$transaction(async (tx) => {
      const p = await tx.project.create({
        data: {
          id: newId(),
          ownerId: input.owner_id,
          key: input.key,
          name: input.name,
          status: input.status ?? 'active',
          description: input.description ?? null,
          isPublic: input.is_public ?? false,
        },
      });
      // Every board starts with "A fazer", "Fazendo", "Feito" (spec §2).
      await ensureDefaultColumns(tx, p.id);
      return mapProject(p);
    });
  }

  async update(id: string, patch: ProjectPatch): Promise<Project | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    const p = await this.db.project.update({
      where: { id },
      data: { name: next.name, status: next.status, description: next.description ?? null, isPublic: next.is_public, aiMemoryLessons: next.ai_memory_lessons },
    });
    return mapProject(p);
  }

  async touchTerminal(id: string): Promise<void> {
    await this.db.project.updateMany({ where: { id }, data: { lastTerminalAt: new Date() } });
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.db.project.deleteMany({ where: { id } });
    return r.count > 0;
  }
}
