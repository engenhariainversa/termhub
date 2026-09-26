import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';
import { requireSimCapable } from '../agent/errors.js';
import { swapAccount } from '../control/account-swap.js';
import { ControlError } from '../control/context.js';
import { killTmuxSession } from '../terminal/machine-exec.js';
import type { SimulatorSessionManager } from '../simulator/session-manager.js';
import { PASTE_MAX_BYTES, saveFileOnMachine } from '../terminal/paste-file.js';
import { INPUT_MAX_CHARS, sendKeysToSession } from '../monitor/send-keys.js';
import { applyState, publishTabChange } from '../monitor/ingest.js';
import { publishTabOpened, publishTabRemoved } from '../monitor/tab-events.js';
import { publicBus } from '../public/bus.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const pasteQuery = z.object({ name: z.string().max(255).optional() });
const inputBody = z.object({ text: z.string().max(INPUT_MAX_CHARS).default(''), enter: z.boolean().default(true) });
const eventsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const patchBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  simulator_udid: z.string().regex(/^[A-Fa-f0-9-]{8,64}$/).nullable().optional(),
});
const swapBody = z.object({ account_id: z.string().min(1).max(64).optional() }).default({});

export async function tabRoutes(
  app: FastifyInstance,
  repos: Repositories,
  deps: { simulators: SimulatorSessionManager; closeSimulatorTab: (tabId: string) => void },
) {
  // Binary bodies for pasted/dropped files (this plugin only). JSON keeps its own parser.
  app.addContentTypeParser(['application/octet-stream'], { parseAs: 'buffer', bodyLimit: PASTE_MAX_BYTES }, (_req, body, done) => done(null, body));
  app.addContentTypeParser(/^(image|text|audio|video)\/.+/, { parseAs: 'buffer', bodyLimit: PASTE_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { tab, machine } = await scoped(repos, request).tab(id);
    const body = patchBody.parse(request.body);
    if (body.simulator_udid !== undefined && tab.kind !== 'simulator') throw badRequest('Só tabs de simulador têm aparelho');
    if (body.simulator_udid !== undefined) requireSimCapable(machine);
    const updated = await repos.tabs.update(id, body);
    if (updated) publishTabOpened(updated, machine);
    if (body.simulator_udid !== undefined && body.simulator_udid !== tab.simulator_udid) deps.closeSimulatorTab(id);
    return { tab: updated };
  });

  /**
   * The user focused this tab: if it needs you, mark it seen — the orange dot goes away for
   * everyone watching, without waiting for the tool's next hook event. Idempotent (always 200).
   */
  app.post('/:id/seen', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { tab, project, machine } = await scoped(repos, request).tab(id);
    const updated = await repos.tabs.markSeen(id);
    if (updated) publishTabChange(updated, project.id, machine);
    return { tab: updated ?? tab };
  });

  /**
   * Moves the tab's Claude session to another Claude account of its machine and resumes it there
   * (spec 2026-09-26 account swap). Without account_id, the account with the most room is chosen.
   */
  app.post('/:id/account-swap', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = swapBody.parse(request.body ?? {});
    const { tab, machine } = await scoped(repos, request).tab(id);
    try {
      return await swapAccount(repos, request.log, tab, machine, { accountId: body.account_id, auto: false });
    } catch (e) {
      if (e instanceof ControlError) throw conflict(e.message);
      throw e;
    }
  });

  app.get('/:id/simulator/screenshot', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { tab, machine } = await scoped(repos, request).tab(id);
    if (tab.kind !== 'simulator') throw notFound('Tab não encontrada');
    if (!tab.simulator_udid) throw conflict('Simulador não está conectado');
    const client = deps.simulators.getClient(machine.id, tab.simulator_udid);
    if (!client) throw conflict('Simulador não está conectado');
    const png = await client.screenshotPng();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return reply
      .header('content-type', 'image/png')
      .header('content-disposition', `attachment; filename="simulador-${stamp}.png"`)
      .send(png);
  });

  /**
   * Monitor: types text into the tab's tmux session (and presses Enter) — the "reply from the list"
   * path, no terminal attached needed. Marks the tab as working right away; the tool's next hook confirms.
   */
  app.post('/:id/input', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { tab, machine } = await scoped(repos, request).tab(id);
    if (tab.kind !== 'terminal' || !tab.tmux_session) throw badRequest('Só tabs de terminal recebem input');
    const body = inputBody.parse(request.body);
    if (!body.text && !body.enter) throw badRequest('Nada a enviar');
    const r = await sendKeysToSession(machine, tab.tmux_session, body.text, body.enter);
    if (!r.ok) throw conflict(r.error ?? 'Não foi possível enviar para o terminal');
    request.log.info({ tabId: tab.id, machineId: machine.id, chars: body.text.length, enter: body.enter }, 'monitor: input sent');
    const updated = tab.state ? await applyState(repos, request.log, tab, tab.state_tool ?? 'termhub', { kind: 'working', text: null, meta: { event: 'input', via: 'termhub' } }) : tab;
    return { ok: true, tab: updated };
  });

  app.get('/:id/events', async (request) => {
    const { id } = idParam.parse(request.params);
    const { tab } = await scoped(repos, request).tab(id);
    const { limit } = eventsQuery.parse(request.query);
    return { events: await repos.tabs.listEvents(tab.id, limit) };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { tab, machine } = await scoped(repos, request).tab(id);
    let killed = false;
    if (tab.tmux_session) {
      try {
        killed = await killTmuxSession(machine, tab.tmux_session);
      } catch {
        killed = false;
      }
    }
    await repos.tabs.delete(id);
    publicBus.publishTabRemoved({ tab_id: tab.id, project_id: tab.project_id, machine_id: machine.id });
    publishTabRemoved(tab, machine);
    return { ok: true, killed };
  });

  /**
   * File pasted (Cmd+V) or dropped on the terminal: written to ~/.cache/termhub/paste/ on the tab's
   * machine; the returned path is what the frontend pastes into the terminal as text.
   */
  app.post('/:id/paste-file', { bodyLimit: PASTE_MAX_BYTES, config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { name } = pasteQuery.parse(request.query);
    const { project, machine } = await scoped(repos, request).tab(id);
    if (!Buffer.isBuffer(request.body)) throw badRequest('Envie o arquivo como corpo binário (content-type application/octet-stream)');
    const file = await saveFileOnMachine(machine, request.body, name);
    request.log.info({ tabId: id, machineId: machine.id, bytes: file.bytes, mime: file.mime }, 'file pasted');
    // attribution for Settings → Arquivos; the paste itself already succeeded, so a DB hiccup only logs
    try {
      await repos.uploads.create({ user_id: request.user?.id ?? null, machine_id: machine.id, project_id: project.id, tab_id: id, name: file.name, path: file.path, mime: file.mime, bytes: file.bytes });
    } catch (err) {
      request.log.warn({ err, tabId: id }, 'could not record the upload');
    }
    return file;
  });
}
