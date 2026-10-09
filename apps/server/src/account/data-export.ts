import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { DataExport } from '../db/repositories/data-exports.js';
import type { User } from '../db/repositories/types.js';
import type { Mailer } from '../email/mailer.js';
import { dataExportReadyMail } from '../email/templates.js';
import { HttpError } from '../lib/errors.js';
import { localeOf } from '../i18n/index.js';
import { exportEntries, writeZip } from './export-archive.js';

/** The download stays available this long after the archive is ready (GitHub's model: 7 days). */
export const EXPORT_TTL_DAYS = 7;
export const EXPORT_TTL_MS = EXPORT_TTL_DAYS * 24 * 60 * 60 * 1000;
/** One request a day per account (a failed one does not count). */
export const EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A build still `running` after this long was cut short (a deploy, a crash): the job takes it again. */
export const EXPORT_STALE_MS = 30 * 60 * 1000;
export const EXPORT_MAX_ATTEMPTS = 3;

const FILE_RE = /^([a-z0-9]+)\.zip(\.tmp)?$/;

/** What Perfil shows about the account's latest request. */
export interface DataExportView {
  id: string;
  status: 'pending' | 'running' | 'ready' | 'failed' | 'expired';
  bytes: number | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

export interface DataExportStatus {
  export: DataExportView | null;
  /** When the account may ask again; null = now. */
  next_allowed_at: string | null;
}

export interface DataExportDeps {
  repos: Repositories;
  mailer: Mailer;
  /** Where the archives live: a folder on the chat-files volume, shared by both app colors. */
  dir: string;
  /** One chat attachment's bytes; rejects when the file is gone. */
  readAttachment: (userId: string, id: string) => Promise<Uint8Array>;
  appUrl: string;
  log: FastifyBaseLogger;
  now?: () => Date;
}

/**
 * "Exportar meus dados" (TER-741, LGPD art. 18): a person asks in Perfil; the archive is built in the
 * background (right away by the color that took the request, else by the hourly job), an e-mail says
 * it is ready, and Perfil downloads it — only by its own account, while signed in — for 7 days.
 */
export class DataExportService {
  private readonly building = new Set<string>();

  constructor(private readonly deps: DataExportDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  fileFor(id: string): string {
    if (!/^[a-z0-9]+$/.test(id)) throw new Error('data export: invalid id');
    return path.join(this.deps.dir, `${id}.zip`);
  }

  private view(row: DataExport): DataExportView {
    const expired = row.status === 'ready' && !!row.expires_at && new Date(row.expires_at) <= this.now();
    return {
      id: row.id,
      status: expired ? 'expired' : row.status,
      bytes: row.bytes,
      created_at: row.created_at,
      completed_at: row.completed_at,
      expires_at: row.expires_at,
    };
  }

  async status(user: User): Promise<DataExportStatus> {
    const latest = await this.deps.repos.dataExports.latestForUser(user.id);
    const counted = await this.deps.repos.dataExports.latestCountedSince(user.id, new Date(this.now().getTime() - EXPORT_COOLDOWN_MS));
    return {
      export: latest ? this.view(latest) : null,
      next_allowed_at: counted ? new Date(new Date(counted.created_at).getTime() + EXPORT_COOLDOWN_MS).toISOString() : null,
    };
  }

  /** Files a request and starts building it. 409 while one is under way, 429 within a day of the last one. */
  async request(user: User): Promise<DataExportStatus> {
    const now = this.now();
    const latest = await this.deps.repos.dataExports.latestForUser(user.id);
    if (latest && (latest.status === 'pending' || latest.status === 'running')) {
      throw new HttpError(409, 'Sua exportação ainda está sendo preparada. Você recebe um e-mail quando ela ficar pronta.', 'EXPORT_IN_PROGRESS');
    }
    const counted = await this.deps.repos.dataExports.latestCountedSince(user.id, new Date(now.getTime() - EXPORT_COOLDOWN_MS));
    if (counted) {
      throw new HttpError(429, 'Você pode pedir uma exportação por dia. Tente de novo depois de 24 horas do último pedido.', 'RATE_LIMITED');
    }
    const row = await this.deps.repos.dataExports.create(user.id);
    this.deps.log.info({ userId: user.id, exportId: row.id }, 'data export: requested');
    setImmediate(() => void this.build(row.id));
    return this.status(user);
  }

  /**
   * Builds one request if this process can claim it. Never throws: a failure marks the row failed
   * (the person may ask again at once) and is logged with ids only.
   */
  async build(id: string): Promise<boolean> {
    if (this.building.has(id)) return false;
    this.building.add(id);
    try {
      const now = this.now();
      const row = await this.deps.repos.dataExports.claim(id, now, new Date(now.getTime() - EXPORT_STALE_MS), EXPORT_MAX_ATTEMPTS);
      if (!row) return false;
      const started = Date.now();
      try {
        const user = await this.deps.repos.users.findById(row.user_id);
        const bundle = user ? await this.deps.repos.dataExports.collect(row.user_id) : undefined;
        if (!user || !bundle) {
          await this.deps.repos.dataExports.markFailed(id, 'ACCOUNT_GONE', this.now());
          return false;
        }
        await mkdir(this.deps.dir, { recursive: true });
        const locale = localeOf(user.locale);
        const bytes = await writeZip(
          this.fileFor(id),
          exportEntries(bundle, {
            locale,
            generatedAt: now,
            readAttachment: (attachmentId) => this.deps.readAttachment(row.user_id, attachmentId).catch(() => null),
          }),
        );
        const done = this.now();
        const expiresAt = new Date(done.getTime() + EXPORT_TTL_MS);
        if (!(await this.deps.repos.dataExports.markReady(id, bytes, done, expiresAt))) {
          // Another color took it over meanwhile (this one looked stale): its file wins.
          return false;
        }
        this.deps.log.info({ userId: row.user_id, exportId: id, bytes, ms: Date.now() - started }, 'data export: ready');
        try {
          await this.deps.mailer.send(dataExportReadyMail(user.email, { url: `${this.deps.appUrl}/settings/profile`, expiresAt }, locale));
        } catch (err) {
          this.deps.log.warn({ err: errText(err), userId: row.user_id, exportId: id }, 'data export: e-mail failed');
        }
        return true;
      } catch (err) {
        this.deps.log.warn({ err: errText(err), userId: row.user_id, exportId: id }, 'data export: build failed');
        await rm(this.fileFor(id), { force: true }).catch(() => {});
        await this.deps.repos.dataExports.markFailed(id, 'BUILD_FAILED', this.now()).catch(() => {});
        return false;
      }
    } catch (err) {
      this.deps.log.warn({ err: errText(err), exportId: id }, 'data export: could not claim');
      return false;
    } finally {
      this.building.delete(id);
    }
  }

  /**
   * The archive to send for a download: the account's own, ready and within its 7 days. Anything else
   * — another account's id included — is a 404, so an id never tells whether it exists.
   */
  async openDownload(user: User, id: string): Promise<{ file: string; bytes: number; filename: string }> {
    const row = /^[a-z0-9]+$/.test(id) ? await this.deps.repos.dataExports.findById(id) : undefined;
    const now = this.now();
    if (!row || row.user_id !== user.id || row.status !== 'ready' || !row.expires_at || new Date(row.expires_at) <= now) {
      throw new HttpError(404, 'Este arquivo não está mais disponível. Peça uma nova exportação no Perfil.', 'EXPORT_NOT_FOUND');
    }
    const file = this.fileFor(id);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, 'Este arquivo não está mais disponível. Peça uma nova exportação no Perfil.', 'EXPORT_NOT_FOUND');
    await this.deps.repos.dataExports.markDownloaded(id, now);
    this.deps.log.info({ userId: user.id, exportId: id }, 'data export: downloaded');
    return { file, bytes: info.size, filename: `termhub-${(row.completed_at ?? row.created_at).slice(0, 10)}.zip` };
  }

  /**
   * The hourly job, safe on both colors: builds what is waiting (or was cut short), gives up on rows
   * out of attempts, expires archives past their 7 days and removes files with no live row (expired,
   * failed, or an account deleted meanwhile).
   */
  async runDue(): Promise<void> {
    const now = this.now();
    const staleBefore = new Date(now.getTime() - EXPORT_STALE_MS);
    const repo = this.deps.repos.dataExports;
    await repo.failExhausted(staleBefore, EXPORT_MAX_ATTEMPTS, now);
    for (const id of await repo.listClaimable(staleBefore)) await this.build(id);
    for (const id of await repo.expireDue(now)) await rm(this.fileFor(id), { force: true }).catch(() => {});
    await this.sweepFiles();
  }

  private async sweepFiles(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.deps.dir);
    } catch {
      return;
    }
    const byId = new Map<string, string[]>();
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (m) byId.set(m[1]!, [...(byId.get(m[1]!) ?? []), name]);
    }
    const live = await this.deps.repos.dataExports.liveFileIds([...byId.keys()]);
    for (const [id, files] of byId) {
      if (live.has(id)) continue;
      for (const name of files) await rm(path.join(this.deps.dir, name), { force: true }).catch(() => {});
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
