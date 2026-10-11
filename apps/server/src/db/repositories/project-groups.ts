import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { LocalizedText, msg } from '../../i18n/index.js';

export const FAVORITES_KEY = 'favorites';
export const MAX_GROUPS = 50;
export const MAX_ITEMS = 500;

export type ProjectGroupRuleCode = 'SYSTEM_GROUP' | 'BAD_ORDER' | 'LIMIT' | 'NOT_FOUND' | 'DUPLICATE';

export class ProjectGroupRuleError extends Error {
  /** Non-enumerable, so equality checks on the error (tests, logs) see only code and message. */
  declare readonly localized: LocalizedText;
  constructor(
    readonly code: ProjectGroupRuleCode,
    message: string | LocalizedText,
  ) {
    const localized = message instanceof LocalizedText ? message : new LocalizedText(message);
    super(localized.toString());
    Object.defineProperty(this, 'localized', { value: localized, enumerable: false });
    this.name = 'ProjectGroupRuleError';
  }
}

export interface ProjectGroup {
  id: string;
  name: string;
  kind: 'favorites' | 'custom';
  position: number;
  project_ids: string[];
}

type Row = { id: string; name: string; systemKey: string | null; position: number; items: { projectId: string }[] };
const view = (g: Row): ProjectGroup => ({ id: g.id, name: g.name, kind: g.systemKey === FAVORITES_KEY ? 'favorites' : 'custom', position: g.position, project_ids: g.items.map((i) => i.projectId) });
const INCLUDE = { items: { orderBy: [{ position: 'asc' as const }, { createdAt: 'asc' as const }], select: { projectId: true } } };

/** A user's sidebar groups. Always keyed by the real signed-in user, never the view-as owner. */
export class ProjectGroupsRepository {
  constructor(private db: PrismaClient) {}

  /** Favoritos exists for every user: created on first use, the unique (user, system_key) index makes racing creates converge. */
  private async ensureFavorites(userId: string): Promise<void> {
    const agg = await this.db.projectGroup.aggregate({ where: { userId }, _max: { position: true } });
    try {
      await this.db.projectGroup.upsert({
        where: { userId_systemKey: { userId, systemKey: FAVORITES_KEY } },
        create: { id: newId(), userId, systemKey: FAVORITES_KEY, name: 'Favoritos', position: (agg._max.position ?? -1) + 1 },
        update: {},
      });
    } catch (e) {
      // the other racer inserted first: the row is there, which is all we wanted
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
  }

  /** The user's groups in sidebar order, Favoritos included when its row exists. Never writes: what a
   *  tool call or a prompt reads (`list` creates Favoritos on first use, which the sidebar wants). */
  async read(userId: string): Promise<ProjectGroup[]> {
    const rows = await this.db.projectGroup.findMany({ where: { userId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: INCLUDE });
    return rows.map(view);
  }

  async list(userId: string): Promise<ProjectGroup[]> {
    await this.ensureFavorites(userId);
    return this.read(userId);
  }

  private async own(userId: string, groupId: string, db: Pick<PrismaClient, 'projectGroup'> = this.db): Promise<Row> {
    const g = await db.projectGroup.findFirst({ where: { id: groupId, userId }, include: INCLUDE });
    if (!g) throw new ProjectGroupRuleError('NOT_FOUND', 'Grupo não encontrado');
    return g;
  }

  /** Pins or unpins one project in Favoritos. States the end result, so a repeat is a no-op; a new
   *  pin goes last, as the sidebar's pin does. The phone's write (TER-541): it changes one member
   *  without sending the whole list, which a phone holding a stale list would overwrite. */
  async setFavorite(userId: string, projectId: string, favorite: boolean): Promise<void> {
    await this.ensureFavorites(userId);
    try {
      await this.db.$transaction(async (tx) => {
        const fav = await tx.projectGroup.findUniqueOrThrow({ where: { userId_systemKey: { userId, systemKey: FAVORITES_KEY } }, select: { id: true } });
        if (!favorite) {
          await tx.projectGroupItem.deleteMany({ where: { groupId: fav.id, projectId } });
          return;
        }
        if (await tx.projectGroupItem.findUnique({ where: { groupId_projectId: { groupId: fav.id, projectId } } })) return;
        const agg = await tx.projectGroupItem.aggregate({ where: { groupId: fav.id }, _max: { position: true }, _count: true });
        if (agg._count >= MAX_ITEMS) throw new ProjectGroupRuleError('LIMIT', msg('Limite de {{max}} projetos por grupo', { max: MAX_ITEMS }));
        await tx.projectGroupItem.create({ data: { groupId: fav.id, projectId, position: (agg._max.position ?? -1) + 1 } });
      });
    } catch (e) {
      // the other racer pinned it first: it is pinned, which is all we wanted
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
  }

  async create(userId: string, name: string): Promise<ProjectGroup> {
    await this.ensureFavorites(userId);
    const count = await this.db.projectGroup.count({ where: { userId } });
    if (count >= MAX_GROUPS) throw new ProjectGroupRuleError('LIMIT', msg('Limite de {{max}} grupos', { max: MAX_GROUPS }));
    const agg = await this.db.projectGroup.aggregate({ where: { userId }, _max: { position: true } });
    const g = await this.db.projectGroup.create({ data: { id: newId(), userId, name: name.trim(), position: (agg._max.position ?? -1) + 1 }, include: INCLUDE });
    return view(g);
  }

  async rename(userId: string, groupId: string, name: string): Promise<ProjectGroup> {
    const g = await this.own(userId, groupId);
    if (g.systemKey) throw new ProjectGroupRuleError('SYSTEM_GROUP', 'Favoritos não pode ser renomeado');
    return view(await this.db.projectGroup.update({ where: { id: groupId }, data: { name: name.trim() }, include: INCLUDE }));
  }

  async delete(userId: string, groupId: string): Promise<void> {
    const g = await this.own(userId, groupId);
    if (g.systemKey) throw new ProjectGroupRuleError('SYSTEM_GROUP', 'Favoritos não pode ser excluído');
    // the remaining groups are renumbered 0..n-1 so positions stay dense
    await this.db.$transaction(async (tx) => {
      await tx.projectGroup.delete({ where: { id: groupId } });
      const rest = await tx.projectGroup.findMany({ where: { userId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true, position: true } });
      for (const [position, r] of rest.entries()) {
        if (r.position !== position) await tx.projectGroup.update({ where: { id: r.id }, data: { position } });
      }
    });
  }

  async reorder(userId: string, ids: string[]): Promise<ProjectGroup[]> {
    await this.ensureFavorites(userId);
    const mine = await this.db.projectGroup.findMany({ where: { userId }, select: { id: true } });
    const set = new Set(ids);
    if (set.size !== ids.length || ids.length !== mine.length || mine.some((g) => !set.has(g.id))) {
      throw new ProjectGroupRuleError('BAD_ORDER', 'A ordem precisa conter todos os seus grupos, uma vez cada');
    }
    await this.db.$transaction(ids.map((id, position) => this.db.projectGroup.update({ where: { id }, data: { position } })));
    return this.list(userId);
  }

  /**
   * Replaces the ordered members of each listed group in one transaction. `visible` says which
   * projects the caller can see right now: members it cannot see are not in the client's list,
   * so they are kept, after the visible ones, in their previous order.
   */
  async setMemberships(userId: string, changes: { id: string; project_ids: string[] }[], visible: (projectId: string) => boolean): Promise<ProjectGroup[]> {
    if (new Set(changes.map((c) => c.id)).size !== changes.length) throw new ProjectGroupRuleError('DUPLICATE', 'Grupo repetido na mesma alteração');
    for (const c of changes) {
      if (new Set(c.project_ids).size !== c.project_ids.length) throw new ProjectGroupRuleError('DUPLICATE', 'Projeto repetido no mesmo grupo');
    }
    await this.db.$transaction(async (tx) => {
      // read inside the transaction: the hidden members kept below must be the ones being replaced
      const groups = [];
      for (const c of changes) groups.push(await this.own(userId, c.id, tx));
      for (const [i, c] of changes.entries()) {
        const hidden = groups[i].items.map((it) => it.projectId).filter((id) => !visible(id) && !c.project_ids.includes(id));
        const next = [...c.project_ids, ...hidden];
        if (next.length > MAX_ITEMS) throw new ProjectGroupRuleError('LIMIT', msg('Limite de {{max}} projetos por grupo', { max: MAX_ITEMS }));
        await tx.projectGroupItem.deleteMany({ where: { groupId: c.id } });
        if (next.length) await tx.projectGroupItem.createMany({ data: next.map((projectId, position) => ({ groupId: c.id, projectId, position })) });
      }
    });
    return this.list(userId);
  }
}
