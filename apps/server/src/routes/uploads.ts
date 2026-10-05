import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import type { Upload } from '../db/repositories/uploads.js';
import { HttpError, conflict, localizedOf, notFound } from '../lib/errors.js';
import { assertUploadName, deletePasteFile, listPasteDir, type DiskFile } from '../terminal/uploads.js';
import { requestLocale, t, tk } from '../i18n/index.js';

const fileParams = z.object({ machineId: z.string().min(1).max(64), name: z.string().min(1).max(160) });

export interface UploadMachineStatus {
  id: string;
  name: string;
  owner_id: string | null;
  owner_name: string | null;
  ok: boolean;
  error?: string;
}

/** One line of the report: what is on disk, joined with who sent it (when known). */
export interface UploadEntry extends DiskFile {
  machine_id: string;
  /** false = the machine could not be listed; the row comes from the DB and the file may or may not exist */
  on_disk: boolean;
  upload: Pick<Upload, 'id' | 'user_id' | 'user_name' | 'user_email' | 'mime' | 'project_id' | 'created_at'> | null;
}

/**
 * Settings → Arquivos: every file in ~/.cache/termhub/paste/ on every machine, attributed to the user
 * who pasted it through the uploads table. Disk is the source of truth: rows whose file is gone
 * (7-day cleanup, manual rm) are dropped while listing; files with no row show up unattributed.
 */
export async function uploadRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/', async (request) => {
    // admins (scope "all") see every machine; a non-admin granted uploads:read only their own
    const [machines, rows] = await Promise.all([repos.machines.list(request.scope.ownerId), repos.uploads.list()]);
    const byMachine = new Map<string, Upload[]>();
    for (const r of rows) byMachine.set(r.machine_id, [...(byMachine.get(r.machine_id) ?? []), r]);

    const statuses: UploadMachineStatus[] = [];
    const files: UploadEntry[] = [];
    await Promise.all(
      machines.map(async (m) => {
        const listing = await listPasteDir(m);
        const known = new Map((byMachine.get(m.id) ?? []).map((r) => [r.name, r]));
        if (!listing.ok) {
          statuses.push({ id: m.id, name: m.name, owner_id: m.owner_id, owner_name: m.owner_name, ok: false, error: t(requestLocale(request), listing.error) });
          for (const r of known.values()) files.push({ machine_id: m.id, name: r.name, bytes: r.bytes, modified_at: r.created_at, on_disk: false, upload: view(r) });
          return;
        }
        statuses.push({ id: m.id, name: m.name, owner_id: m.owner_id, owner_name: m.owner_name, ok: true });
        for (const f of listing.files) {
          const r = known.get(f.name);
          files.push({ ...f, machine_id: m.id, on_disk: true, upload: r ? view(r) : null });
        }
        const present = listing.files.map((f) => f.name);
        if (known.size) await repos.uploads.deleteMissing(m.id, present);
      }),
    );
    files.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
    return { machines: statuses.sort((a, b) => a.name.localeCompare(b.name)), files };
  });

  app.delete('/:machineId/:name', async (request) => {
    const { machineId, name } = fileParams.parse(request.params);
    assertUploadName(name);
    const machine = await repos.machines.findById(machineId);
    if (!machine) throw notFound('Máquina não encontrada');
    // deletePasteFile runs shell on the machine; agents only answer named RPCs and have none for this yet
    if (machine.type === 'agent') throw conflict('Remoção de arquivos ainda não disponível em máquinas com agente');
    let existed: boolean;
    try {
      existed = await deletePasteFile(machine, name);
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? localizedOf(err) : tk('Falha ao remover o arquivo'));
    }
    await repos.uploads.deleteByName(machineId, name);
    request.log.info({ machineId, name, existed }, 'upload deleted');
    return { ok: true, existed };
  });
}

function view(r: Upload): UploadEntry['upload'] {
  return { id: r.id, user_id: r.user_id, user_name: r.user_name, user_email: r.user_email, mime: r.mime, project_id: r.project_id, created_at: r.created_at };
}
