import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { installHooksResponse, type TInstallHooksResponse } from '@termhub/mobile-api';
import { scoped } from '../auth/scope.js';
import type { Repositories } from '../db/repositories/index.js';
import { tk } from '../i18n/index.js';
import { conflict, HttpError, localizedOf } from '../lib/errors.js';
import { installMachineHooksOn } from '../monitor/machine-hooks.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/**
 * The phone's machine actions, mounted at `/machines` of the mobile API under `machines`. For now only
 * "Instalar hooks" (TER-1091), offered by a tab's conversation that is empty because the machine never had
 * them: the web's `POST /machines/:id/hooks`, same install, no PIN (the web asks none either).
 */
export async function mobileMachineRoutes(app: FastifyInstance, repos: Repositories) {
  app.post('/:id/hooks', { config: { action: 'update' } }, async (request): Promise<TInstallHooksResponse> => {
    const { id } = idParam.parse(request.params);
    const machine = await scoped(repos, request).machine(id);
    let done;
    try {
      done = await installMachineHooksOn(repos, machine);
    } catch (err) {
      // Agent failures (offline, outdated, what the machine reported) already carry their own status.
      if (err instanceof HttpError) throw err;
      throw conflict(err instanceof Error ? localizedOf(err) : tk('Instalação falhou'));
    }
    request.log.info({ machineId: machine.id, claude: done.report.claude, claudeDirs: done.report.claude_dirs.length }, 'monitor: hooks installed from the app');
    return installHooksResponse.parse({ installed_at: done.installed_at });
  });
}
