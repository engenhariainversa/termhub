import type { PrismaClient } from '../prisma.js';
import type { DataExport as PrismaDataExport } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

export type DataExportStatus = 'pending' | 'running' | 'ready' | 'failed' | 'expired';

export interface DataExport {
  id: string;
  user_id: string;
  status: DataExportStatus;
  attempts: number;
  bytes: number | null;
  error_code: string | null;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  downloaded_at: string | null;
  created_at: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function mapExport(r: PrismaDataExport): DataExport {
  return {
    id: r.id,
    user_id: r.userId,
    status: r.status as DataExportStatus,
    attempts: r.attempts,
    bytes: r.bytes === null ? null : Number(r.bytes),
    error_code: r.errorCode,
    started_at: iso(r.startedAt),
    completed_at: iso(r.completedAt),
    expires_at: iso(r.expiresAt),
    downloaded_at: iso(r.downloadedAt),
    created_at: r.createdAt.toISOString(),
  };
}

/** One table of the archive: plain rows, keys in snake_case, ready for JSON. */
export type ExportRows = Record<string, unknown>[];

/**
 * Everything the account holds, as rows. Each list is read by the account's own ids — `owner_id`,
 * `user_id`, or a project/conversation/machine the account owns — never through the request scope:
 * an admin exporting gets their own data, not the instance's. Secrets never leave the database:
 * password hash, agent and hook token hashes, integration secrets, API token hashes, a device's
 * PIN secret and push token.
 */
export interface UserDataBundle {
  account: Record<string, unknown>;
  projects: ExportRows;
  project_machines: ExportRows;
  project_setups: ExportRows;
  project_groups: ExportRows;
  columns: ExportRows;
  cards: ExportRows;
  pull_requests: ExportRows;
  notes: ExportRows;
  tickets: ExportRows;
  tabs: ExportRows;
  last_answers: ExportRows;
  tab_questions: ExportRows;
  conversations: ExportRows;
  messages: ExportRows;
  actions: ExportRows;
  decisions: ExportRows;
  attachments: ExportRows;
  memory: ExportRows;
  machines: ExportRows;
  integrations: ExportRows;
  ai_accounts: ExportRows;
  api_tokens: ExportRows;
  uploads: ExportRows;
  devices: ExportRows;
  device_events: ExportRows;
  notifications: ExportRows;
}

const snakeKey = (k: string) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

/** Top-level keys to snake_case (JSON columns keep their own shape); BigInt and dates become JSON-safe. */
export function exportRow(row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[snakeKey(k)] = jsonSafe(v);
  return out;
}

function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  return v;
}

const rows = (list: object[]): ExportRows => list.map(exportRow);

/**
 * "Exportar meus dados" (TER-741): the requests and what goes in the archive. A request moves
 * pending → running → ready (or failed), then expired once its file is gone. The writes that move it
 * are conditional, so the two app colors running the job never build the same export twice.
 */
export class DataExportsRepository {
  constructor(private db: PrismaClient) {}

  async create(userId: string): Promise<DataExport> {
    return mapExport(await this.db.dataExport.create({ data: { id: newId(), userId } }));
  }

  async findById(id: string): Promise<DataExport | undefined> {
    const r = await this.db.dataExport.findUnique({ where: { id } });
    return r ? mapExport(r) : undefined;
  }

  /** The account's most recent request, whatever its state. */
  async latestForUser(userId: string): Promise<DataExport | undefined> {
    const r = await this.db.dataExport.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return r ? mapExport(r) : undefined;
  }

  /** The account's most recent request after `since` that counts against the daily limit (a failed one does not). */
  async latestCountedSince(userId: string, since: Date): Promise<DataExport | undefined> {
    const r = await this.db.dataExport.findFirst({ where: { userId, createdAt: { gt: since }, status: { not: 'failed' } }, orderBy: { createdAt: 'desc' } });
    return r ? mapExport(r) : undefined;
  }

  /**
   * Takes a request to build it: a pending one, or one left `running` since before `staleBefore` (the
   * color building it went away). Undefined = another process has it, or it ran out of attempts.
   */
  async claim(id: string, now: Date, staleBefore: Date, maxAttempts: number): Promise<DataExport | undefined> {
    const { count } = await this.db.dataExport.updateMany({
      where: { id, attempts: { lt: maxAttempts }, OR: [{ status: 'pending' }, { status: 'running', startedAt: { lt: staleBefore } }] },
      data: { status: 'running', startedAt: now, attempts: { increment: 1 } },
    });
    return count === 1 ? this.findById(id) : undefined;
  }

  /** Requests the job should (re)try: pending, or running for too long. Oldest first. */
  async listClaimable(staleBefore: Date, limit = 10): Promise<string[]> {
    const list = await this.db.dataExport.findMany({
      where: { OR: [{ status: 'pending' }, { status: 'running', startedAt: { lt: staleBefore } }] },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    return list.map((r) => r.id);
  }

  /** Running rows that used all their attempts: they never finish, so they fail. */
  async failExhausted(staleBefore: Date, maxAttempts: number, now: Date): Promise<number> {
    const { count } = await this.db.dataExport.updateMany({
      where: { status: 'running', startedAt: { lt: staleBefore }, attempts: { gte: maxAttempts } },
      data: { status: 'failed', errorCode: 'GAVE_UP', completedAt: now },
    });
    return count;
  }

  async markReady(id: string, bytes: number, now: Date, expiresAt: Date): Promise<boolean> {
    const { count } = await this.db.dataExport.updateMany({
      where: { id, status: 'running' },
      data: { status: 'ready', bytes: BigInt(bytes), completedAt: now, expiresAt, errorCode: null },
    });
    return count === 1;
  }

  async markFailed(id: string, errorCode: string, now: Date): Promise<void> {
    await this.db.dataExport.updateMany({ where: { id, status: 'running' }, data: { status: 'failed', errorCode, completedAt: now } });
  }

  async markDownloaded(id: string, now: Date): Promise<void> {
    await this.db.dataExport.updateMany({ where: { id, downloadedAt: null }, data: { downloadedAt: now } });
  }

  /** Ready rows whose link ran out: the caller removes their files after this. */
  async expireDue(now: Date): Promise<string[]> {
    const due = await this.db.dataExport.findMany({ where: { status: 'ready', expiresAt: { lte: now } }, select: { id: true } });
    if (!due.length) return [];
    await this.db.dataExport.updateMany({ where: { id: { in: due.map((r) => r.id) }, status: 'ready' }, data: { status: 'expired' } });
    return due.map((r) => r.id);
  }

  /** Ids whose file may stay on disk: ready ones, and those still being built. */
  async liveFileIds(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const list = await this.db.dataExport.findMany({ where: { id: { in: ids }, status: { in: ['ready', 'running', 'pending'] } }, select: { id: true } });
    return new Set(list.map((r) => r.id));
  }

  /** Everything the account holds (see UserDataBundle). Undefined when the account is gone. */
  async collect(userId: string): Promise<UserDataBundle | undefined> {
    const db = this.db;
    const user = await db.user.findUnique({
      where: { id: userId },
      omit: { passwordHash: true, roleId: true, reviewEnabledBy: true },
      include: { roleRef: { select: { name: true, label: true } } },
    });
    if (!user) return undefined;
    const { roleRef, ...account } = user;

    const [projects, machines, conversations] = await Promise.all([
      db.project.findMany({ where: { ownerId: userId }, orderBy: { createdAt: 'asc' } }),
      db.machine.findMany({ where: { ownerId: userId }, omit: { agentTokenHash: true }, orderBy: { createdAt: 'asc' } }),
      db.chatConversation.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    ]);
    const projectIds = projects.map((p) => p.id);
    const machineIds = machines.map((m) => m.id);
    const conversationIds = conversations.map((c) => c.id);
    const inProjects = { projectId: { in: projectIds } };
    const inConversations = { conversationId: { in: conversationIds } };

    const [projectMachines, setups, groups, columns, cards, pullRequests, notes, tickets, tabs] = await Promise.all([
      db.projectMachine.findMany({ where: inProjects, orderBy: [{ projectId: 'asc' }, { position: 'asc' }] }),
      db.projectSetup.findMany({ where: inProjects }),
      db.projectGroup.findMany({ where: { userId }, include: { items: { select: { projectId: true, position: true } } }, orderBy: { position: 'asc' } }),
      db.taskColumn.findMany({ where: inProjects, orderBy: [{ projectId: 'asc' }, { position: 'asc' }] }),
      db.task.findMany({ where: inProjects, orderBy: [{ projectId: 'asc' }, { number: 'asc' }] }),
      db.taskPullRequest.findMany({ where: inProjects }),
      db.note.findMany({ where: inProjects }),
      db.ticket.findMany({ where: inProjects, orderBy: [{ projectId: 'asc' }, { createdAt: 'asc' }] }),
      db.tab.findMany({ where: inProjects, orderBy: [{ projectId: 'asc' }, { position: 'asc' }] }),
    ]);
    const tabIds = tabs.map((t) => t.id);

    const [lastAnswers, tabQuestions, messages, actions, decisions, attachments, memory] = await Promise.all([
      db.tabLastAnswer.findMany({ where: { tabId: { in: tabIds } } }),
      db.tabQuestion.findMany({ where: inConversations, orderBy: { createdAt: 'asc' } }),
      db.chatMessage.findMany({ where: inConversations, orderBy: { createdAt: 'asc' } }),
      db.chatAction.findMany({ where: inConversations, orderBy: { createdAt: 'asc' } }),
      db.chatDecision.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      db.chatAttachment.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      db.memoryItem.findMany({ where: { ownerId: userId }, orderBy: [{ kind: 'asc' }, { sourceAt: 'asc' }] }),
    ]);

    const [integrations, aiAccounts, apiTokens, uploads, devices, deviceEvents, notifications] = await Promise.all([
      db.integration.findMany({ where: { ownerId: userId }, omit: { secret: true }, orderBy: { createdAt: 'asc' } }),
      db.aiAccount.findMany({ where: { machineId: { in: machineIds } }, orderBy: { createdAt: 'asc' } }),
      // The person's own tokens; the concierge's and the tabs' are minted by termhub, not by them.
      db.apiToken.findMany({ where: { userId, chatConversationId: null, tabId: null }, omit: { tokenHash: true }, orderBy: { createdAt: 'asc' } }),
      db.upload.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      db.device.findMany({ where: { userId }, omit: { pinSecretEnc: true, pushToken: true }, orderBy: { createdAt: 'asc' } }),
      db.deviceEvent.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      db.userNotification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    ]);

    return {
      account: { ...exportRow(account), role: roleRef ? { name: roleRef.name, label: roleRef.label } : null },
      projects: rows(projects),
      project_machines: rows(projectMachines),
      project_setups: rows(setups),
      project_groups: groups.map(({ items, ...g }) => ({ ...exportRow(g), items: rows(items) })),
      columns: rows(columns),
      cards: rows(cards),
      pull_requests: rows(pullRequests),
      notes: rows(notes),
      tickets: rows(tickets),
      tabs: rows(tabs),
      last_answers: rows(lastAnswers),
      tab_questions: rows(tabQuestions),
      conversations: rows(conversations),
      messages: rows(messages),
      actions: rows(actions),
      decisions: rows(decisions),
      attachments: rows(attachments),
      memory: rows(memory),
      machines: rows(machines),
      integrations: rows(integrations),
      ai_accounts: rows(aiAccounts),
      api_tokens: rows(apiTokens),
      uploads: rows(uploads),
      devices: rows(devices),
      device_events: rows(deviceEvents),
      notifications: rows(notifications),
    };
  }
}
