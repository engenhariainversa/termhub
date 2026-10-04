import {
  startSessionBody,
  TAB_FILE_MAX_BYTES,
  tabActionBody,
  tabChatQuery,
  tabFileQuery,
  tabMessageBody,
  tabScreenQuery,
  type TTabActionResponse,
  type TTabChatPage,
  type TTabsResponse,
} from '@termhub/mobile-api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireTranscriptCapable } from '../agent/errors.js';
import { scoped } from '../auth/scope.js';
import { startAgent } from '../control/agents.js';
import { ControlError, controlContextFor } from '../control/context.js';
import { readScreen } from '../control/screen.js';
import { sendInput, sendKey } from '../control/terminals.js';
import type { Repositories } from '../db/repositories/index.js';
import { describeTabQuestions, splitTabRows } from '../db/repositories/tab-questions-view.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { claudeFooterMode } from '../monitor/screen-state.js';
import type { TabChatHub } from '../tab-chat/hub.js';
import { availabilityOf, readPage as defaultReadPage, type AgentView, type Page, type TabChatAvailability } from '../tab-chat/reader.js';
import { tabSummaryOf } from '../tab-chat/view.js';
import { saveFileOnMachine } from '../terminal/paste-file.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/** The message a tab waiting on a permission answers with: the card is right above the composer. */
export const WAITING_PERMISSION_MESSAGE = 'Responda a pergunta acima antes de enviar uma mensagem';
/** Rows of the pane `cycle_mode` reads the footer from. */
const MODE_SCREEN_LINES = 30;

export interface MobileTabDeps {
  hub: TabChatHub;
  /** Injected by tests; the real reader otherwise. */
  readPage?: typeof defaultReadPage;
  agent?: AgentView;
  /** Pause between Shift+Tab and reading the footer, so Claude Code has redrawn it. */
  modeSettleMs?: number;
}

/**
 * A control function's refusal as an HTTP answer. The tab-question routes send every refusal as 409
 * (`asHttp`); here a few have a status of their own, and a tab waiting on a permission says where the
 * answer goes instead of the MCP tool's hint (`answering_permission`).
 */
function asHttp(err: unknown): unknown {
  if (!(err instanceof ControlError)) return err;
  switch (err.code) {
    case 'WAITING_PERMISSION':
      return new HttpError(409, WAITING_PERMISSION_MESSAGE, err.code);
    case 'MACHINE_OFFLINE':
      return new HttpError(503, err.message, err.code);
    case 'FORBIDDEN':
      return new HttpError(403, err.message, err.code);
    case 'NOT_A_TERMINAL':
    case 'TEXT_TOO_LONG':
    case 'PROMPT_TOO_LONG':
    case 'PROMPT_CONTROL_CHARS':
    case 'PROMPT_LOOKS_LIKE_FLAG':
      return new HttpError(400, err.message, err.code);
    default:
      return new HttpError(409, err.message, err.code);
  }
}

async function control<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw asHttp(err);
  }
}

const emptyPage = (): Page => ({ items: [], before: null, live: null, mode: null, degraded: false, missing: false });

/**
 * A terminal tab read as a conversation on the phone (spec 2026-10-01 tab chat §5.4), mounted at
 * `/tabs` of the mobile API under `terminals`: reads need `terminals:read`, everything that types,
 * presses a key or starts a session needs `terminals:write`. Every tab is loaded through the caller's
 * scope (404 outside it). Never logs a message, a prompt, a screen or a transcript line: lengths only.
 */
export async function mobileTabRoutes(app: FastifyInstance, repos: Repositories, deps: MobileTabDeps) {
  const readPage = deps.readPage ?? defaultReadPage;
  const ctxOf = (request: FastifyRequest) => controlContextFor(repos, request.scope.user);
  const availability = (tab: Parameters<typeof availabilityOf>[0], machine: Parameters<typeof availabilityOf>[1]) => availabilityOf(tab, machine, deps.agent);

  /** The Sessões list: every terminal tab of the scope, with why it can or cannot be opened. */
  app.get('/', async (request): Promise<TTabsResponse> => {
    const owner = request.scope.ownerId;
    const [tabs, projects, machines] = await Promise.all([repos.tabs.listOpenTerminals(owner), repos.projects.list({ owner }), repos.machines.list(owner)]);
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const machineById = new Map(machines.map((m) => [m.id, m]));
    return {
      tabs: tabs.flatMap((tab) => {
        const project = projectById.get(tab.project_id);
        const machine = machineById.get(tab.machine_id);
        return project && machine ? [tabSummaryOf(tab, project, machine, availability(tab, machine))] : [];
      }),
    };
  });

  /** "Nova sessão": Claude Code in a new tab of the project, with the project's account and model. */
  app.post('/', { config: { action: 'write' } }, async (request) => {
    const body = startSessionBody.parse(request.body);
    const started = await control(() => startAgent(ctxOf(request), { project_id: body.project_id, machine_id: body.machine_id, prompt: body.prompt }));
    request.log.info({ tabId: started.tab_id, projectId: body.project_id, promptLen: body.prompt.length }, 'tab chat: session started');
    return { tab_id: started.tab_id };
  });

  /** A page of the conversation, read backward from `before`, with the tab's open cards. */
  app.get('/:id/chat', async (request): Promise<TTabChatPage> => {
    const { id } = idParam.parse(request.params);
    const { before } = tabChatQuery.parse(request.query);
    const { tab, project, machine } = await scoped(repos, request).tab(id);
    let avail: TabChatAvailability = availability(tab, machine);
    let page = emptyPage();
    if (avail === 'ready') {
      try {
        page = await readPage(machine, tab, before ?? null);
        if (page.missing) avail = 'no_session';
      } catch (err) {
        // The agent left between the check and the read: the screen says so instead of failing.
        if (!(err instanceof HttpError) || (err.statusCode !== 503 && err.statusCode !== 504)) throw err;
        avail = 'offline';
      }
    }
    const rows = await repos.tabQuestions.listOpenForTab(tab.id, request.scope.user.id);
    const { tab_questions, tab_suggestions } = splitTabRows(await describeTabQuestions(repos, rows, request.scope.user.id));
    request.log.debug({ tabId: tab.id, availability: avail, items: page.items.length, degraded: page.degraded }, 'tab chat: page');
    return {
      tab: tabSummaryOf(tab, project, machine, avail),
      session_id: tab.agent_session_id,
      items: page.items,
      before: page.before,
      live: page.live,
      mode: page.mode,
      degraded: page.degraded,
      // the views' fields are the contract's (events-parity.test.ts keeps them in step)
      questions: tab_questions as TTabChatPage['questions'],
      suggestions: tab_suggestions as TTabChatPage['suggestions'],
    };
  });

  /** Text typed into the session, as in the web terminal: no confirmation card (spec D12). */
  app.post('/:id/chat/messages', { config: { action: 'write' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { text } = tabMessageBody.parse(request.body);
    const { tab } = await scoped(repos, request).tab(id);
    await control(() => sendInput(ctxOf(request), { tab_id: tab.id, text }));
    request.log.info({ tabId: tab.id, textLen: text.length }, 'tab chat: message sent');
    deps.hub.poke(tab.id);
    return { sent: true as const };
  });

  /** Interrupt, cycle the permission mode, `/clear`, `/compact`. */
  app.post('/:id/chat/actions', { config: { action: 'write' } }, async (request): Promise<TTabActionResponse> => {
    const { id } = idParam.parse(request.params);
    const { action } = tabActionBody.parse(request.body);
    const { tab, machine } = await scoped(repos, request).tab(id);
    const ctx = ctxOf(request);
    let mode: string | null = null;
    switch (action) {
      case 'interrupt':
        await control(() => sendKey(ctx, { tab_id: tab.id, key: 'Escape' }));
        break;
      case 'clear':
        await control(() => sendInput(ctx, { tab_id: tab.id, text: '/clear' }));
        break;
      case 'compact':
        await control(() => sendInput(ctx, { tab_id: tab.id, text: '/compact' }));
        break;
      case 'cycle_mode': {
        // An older agent's schema refuses the key: say "update" instead of a bare 400 from the machine.
        requireTranscriptCapable(machine);
        await control(() => sendKey(ctx, { tab_id: tab.id, key: 'BTab' }));
        // The transcript writes the mode with the next prompt, not with the key: the footer is the witness.
        await new Promise((r) => setTimeout(r, deps.modeSettleMs ?? 300));
        const screen = await control(() => readScreen(ctx, { tab_id: tab.id, lines: MODE_SCREEN_LINES }, { plain: true }));
        mode = claudeFooterMode(screen.text);
        break;
      }
    }
    request.log.info({ tabId: tab.id, action, mode }, 'tab chat: action');
    deps.hub.poke(tab.id);
    return { done: true, mode };
  });

  /** A file for the session: saved on the tab's machine; the app puts the path in the message. */
  await app.register(async (files) => {
    files.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: TAB_FILE_MAX_BYTES }, (_req, body, done) => done(null, body));
    files.post('/:id/chat/files', { config: { action: 'write' }, bodyLimit: TAB_FILE_MAX_BYTES }, async (request) => {
      const { id } = idParam.parse(request.params);
      const { name } = tabFileQuery.parse(request.query);
      const { machine, tab } = await scoped(repos, request).tab(id);
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw badRequest('Arquivo vazio');
      const saved = await saveFileOnMachine(machine, request.body, name);
      request.log.info({ tabId: tab.id, machineId: machine.id, bytes: saved.bytes }, 'tab chat: file saved');
      return { path: saved.path, name: saved.name };
    });
  });

  /** The raw screen ("Ver tela"): the last lines of the pane, plain text. */
  app.get('/:id/screen', async (request) => {
    const { id } = idParam.parse(request.params);
    const { lines } = tabScreenQuery.parse(request.query);
    const { tab } = await scoped(repos, request).tab(id);
    const screen = await control(() => readScreen(ctxOf(request), { tab_id: tab.id, lines }, { plain: true }));
    return { text: screen.text };
  });
}
