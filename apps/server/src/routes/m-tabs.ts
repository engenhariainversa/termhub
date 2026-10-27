import {
  sessionStartOptionsQuery,
  startSessionBody,
  startTabAgentBody,
  TAB_FILE_MAX_BYTES,
  tabActionBody,
  tabChatQuery,
  tabFileQuery,
  tabMessageBody,
  tabScreenQuery,
  type TSessionStartOptions,
  type TTabActionResponse,
  type TStartTabAgentResponse,
  type TTabAgentOptions,
  type TTabChatPage,
  type TTabsResponse,
} from '@termhub/mobile-api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireTranscriptCapable } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import { scoped } from '../auth/scope.js';
import { startAgent, startTabAgent, tabAgentOptions } from '../control/agents.js';
import { ControlError, controlContextFor } from '../control/context.js';
import { readScreen } from '../control/screen.js';
import { sendInput, sendKey } from '../control/terminals.js';
import type { Repositories } from '../db/repositories/index.js';
import { describeTabQuestions, splitTabRows } from '../db/repositories/tab-questions-view.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { applyState } from '../monitor/ingest.js';
import { readHooksStatus } from '../monitor/install.js';
import { AT_PROMPT } from '../monitor/state.js';
import { claudeAccountDirs } from '../monitor/machine-hooks.js';
import { claudeFooterMode } from '../monitor/screen-state.js';
import type { TabChatHub } from '../tab-chat/hub.js';
import { availabilityOf, emptyReasonOf, hasNoHistory, hasReportedSession, readPage as defaultReadPage, transcriptToolOf, type AgentView, type HooksOnMachine, type Page, type TabChatAvailability } from '../tab-chat/reader.js';
import { tabSummaryOf } from '../tab-chat/view.js';
import { saveFileOnMachine } from '../terminal/paste-file.js';
import { paneForeground } from '../terminal/session-ops.js';
import type { Machine } from '../db/repositories/types.js';
import type { PaneForeground } from '@termhub/machine-ops';
import { tk } from '../i18n/index.js';
import { audit } from '../auth/audit.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/** The message a tab waiting on a permission answers with: the card is right above the composer. */
export const WAITING_PERMISSION_MESSAGE = tk('Responda a pergunta acima antes de enviar uma mensagem');
/** Rows of the pane `cycle_mode` reads the footer from. */
const MODE_SCREEN_LINES = 30;

export interface MobileTabDeps {
  hub: TabChatHub;
  /** Injected by tests; the real reader otherwise. */
  readPage?: typeof defaultReadPage;
  agent?: AgentView;
  /** Pause between Shift+Tab and reading the footer, so Claude Code has redrawn it. */
  modeSettleMs?: number;
  /**
   * Where a message typed here comes from, for its origin note (TER-851): the phone (`/api/m/tabs`, the
   * default) or the web's conversation view (`/api/tab-chat`, TER-1003).
   */
  surface?: 'app' | 'web';
  /** Injected by tests; the machine's live hooks status otherwise (TER-1095). */
  codexHooksTrusted?: (machine: Machine) => Promise<boolean | null>;
  /** What the tab's pane runs in front (TER-1094); injected by tests, the agent's `tmux.foreground` otherwise. */
  foreground?: (machine: Machine, session: string) => Promise<PaneForeground>;
}

/** Whether Codex trusts every termhub hook on the machine; null when that cannot be read (offline, an old agent, no Codex). */
async function readCodexHooksTrusted(repos: Repositories, machine: Machine): Promise<boolean | null> {
  try {
    const status = await readHooksStatus(machine, await claudeAccountDirs(repos, machine.id));
    return status.codex.present && status.codex.trusted !== null ? status.codex.trusted === 'all' : null;
  } catch {
    return null;
  }
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
      return new HttpError(503, err.localized, err.code);
    case 'FORBIDDEN':
      return new HttpError(403, err.localized, err.code);
    case 'NOT_A_TERMINAL':
    case 'TEXT_TOO_LONG':
    case 'PROMPT_TOO_LONG':
    case 'PROMPT_CONTROL_CHARS':
    case 'PROMPT_LOOKS_LIKE_FLAG':
      return new HttpError(400, err.localized, err.code);
    default:
      return new HttpError(409, err.localized, err.code);
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
 * A terminal tab read as a conversation (spec 2026-10-01 tab chat §5.4), mounted at `/tabs` of the
 * mobile API and at `/tab-chat` of the web API (TER-1003), under `terminals` in both: reads need `terminals:read`, everything that types,
 * presses a key or starts a session needs `terminals:write`. Every tab is loaded through the caller's
 * scope (404 outside it). Never logs a message, a prompt, a screen or a transcript line: lengths only.
 */
export async function mobileTabRoutes(app: FastifyInstance, repos: Repositories, deps: MobileTabDeps) {
  const readPage = deps.readPage ?? defaultReadPage;
  const foreground = deps.foreground ?? paneForeground;
  const ctxOf = (request: FastifyRequest) => controlContextFor(repos, request.scope.user);
  const availability = (tab: Parameters<typeof availabilityOf>[0], machine: Parameters<typeof availabilityOf>[1]) => availabilityOf(tab, machine, deps.agent);

  /** The Sessões list: every terminal tab of the scope, with why it can or cannot be opened. */
  app.get('/', async (request): Promise<TTabsResponse> => {
    const owner = request.scope.ownerId;
    const [tabs, projects, machines, autoRuns] = await Promise.all([
      repos.tabs.listOpenTerminals(owner),
      repos.projects.list({ owner }),
      repos.machines.list(owner),
      repos.automationRuns.activeTabRefs(owner),
    ]);
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const machineById = new Map(machines.map((m) => [m.id, m]));
    const autoRef = new Map(autoRuns.map((r) => [r.tab_id, r.ref]));
    return {
      tabs: tabs.flatMap((tab) => {
        const project = projectById.get(tab.project_id);
        const machine = machineById.get(tab.machine_id);
        return project && machine ? [tabSummaryOf(tab, project, machine, availability(tab, machine), autoRef.get(tab.id) ?? null)] : [];
      }),
    };
  });

  /**
   * "Nova sessão" from a project (TER-1119): the project's machines, online or not, each with the accounts
   * an agent can start with there and the one picked without asking — the same rule as `GET /:id/agent`.
   */
  app.get('/start-options', async (request): Promise<TSessionStartOptions> => {
    const { project_id } = sessionStartOptionsQuery.parse(request.query);
    const { project, machines } = await scoped(repos, request).projectMachines(project_id);
    const ctx = ctxOf(request);
    const online = deps.agent ?? agents;
    return {
      machines: await Promise.all(
        machines.map(async ({ machine }) => ({
          id: machine.id,
          name: machine.name,
          online: machine.type !== 'agent' || online.isOnline(machine.id),
          ...(await control(() => tabAgentOptions(ctx, project, machine))),
        })),
      ),
    };
  });

  /** "Nova sessão": an agent in a new tab of the project, with the chosen account (else the project's) and the project's model. */
  app.post('/', { config: { action: 'write' } }, async (request) => {
    const body = startSessionBody.parse(request.body);
    const started = await control(() => startAgent(ctxOf(request), { project_id: body.project_id, machine_id: body.machine_id, ...(body.account_id ? { account_id: body.account_id } : {}), prompt: body.prompt }));
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
    // Only a tab that never reported a session needs to know whether the machine has the hooks (TER-1091),
    // and a Codex one whether Codex was told to trust them (TER-1095).
    let hooks: HooksOnMachine = 'installed';
    if (avail === 'no_session' && !hasReportedSession(tab)) {
      if (!(await repos.machineHooks.findByMachine(machine.id))) hooks = 'missing';
      else if (transcriptToolOf(tab) === 'codex' && (await (deps.codexHooksTrusted ?? ((m: Machine) => readCodexHooksTrusted(repos, m)))(machine)) === false) hooks = 'codex_untrusted';
    }
    // A page with no history at all is worth a look at the pane (TER-1094): a plain shell there means no
    // agent, not a missing history. Any failure (an agent older than 0.14.0, offline) keeps the other reasons.
    const atShell = tab.tmux_session && (avail === 'no_session' || avail === 'ready') && hasNoHistory(avail, page, !before) ? (await foreground(machine, tab.tmux_session).catch(() => null)) === 'shell' : false;
    const empty_reason = emptyReasonOf(tab, avail, page, !before, hooks, atShell);
    request.log.debug({ tabId: tab.id, availability: avail, items: page.items.length, degraded: page.degraded, emptyReason: empty_reason }, 'tab chat: page');
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
      empty_reason,
    };
  });

  /** "Iniciar sessão" (TER-1094): the accounts the tab's agent can start with, and the one picked without asking. */
  app.get('/:id/agent', async (request): Promise<TTabAgentOptions> => {
    const { id } = idParam.parse(request.params);
    const { project, machine } = await scoped(repos, request).tab(id);
    return control(() => tabAgentOptions(ctxOf(request), project, machine));
  });

  /** Starts the agent in the tab (its shell is free) or in a new tab of the same project and machine. */
  app.post('/:id/agent', { config: { action: 'write' } }, async (request): Promise<TStartTabAgentResponse> => {
    const { id } = idParam.parse(request.params);
    const { account_id } = startTabAgentBody.parse(request.body ?? {});
    const { tab, project, machine } = await scoped(repos, request).tab(id);
    const started = await control(() => startTabAgent({ ...ctxOf(request), log: request.log }, tab, project, machine, account_id));
    // the CLI line is typed into the tab: the trail's terminal input, marked as an agent start
    await audit(repos, request, 'terminal.input', { target: { type: 'tab', id: started.tab_id, label: tab.name }, meta: { machine_id: machine.id, agent_start: true, provider: started.provider, account_id: started.account.id, new_tab: started.new_tab, surface: deps.surface ?? 'app' } });
    deps.hub.poke(tab.id);
    return started;
  });

  /** Text typed into the session, as in the web terminal: no confirmation card (spec D12). */
  app.post('/:id/chat/messages', { config: { action: 'write' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { text } = tabMessageBody.parse(request.body);
    const { tab } = await scoped(repos, request).tab(id);
    await control(() => sendInput(ctxOf(request), { tab_id: tab.id, text }, { level: 'person_typed', userId: request.scope.user.id, surface: deps.surface ?? 'app' }));
    request.log.info({ tabId: tab.id, textLen: text.length }, 'tab chat: message sent');
    await audit(repos, request, 'terminal.input', { target: { type: 'tab', id: tab.id, label: tab.name }, meta: { machine_id: tab.machine_id, chars: text.length, surface: deps.surface ?? 'app' } });
    // An agent at its prompt starts a turn: the tab works from now, as the web's input marks it (TER-1102), so the
    // conversation says "pensando…" before the agent's first hook — and at all with Codex hooks not trusted yet.
    if (tab.state && AT_PROMPT.includes(tab.state)) await applyState(repos, request.log, tab, tab.state_tool ?? 'termhub', { kind: 'working', text: null, meta: { event: 'input', via: 'termhub' } });
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
        await control(() => sendInput(ctx, { tab_id: tab.id, text: '/clear' }, null));
        break;
      case 'compact':
        await control(() => sendInput(ctx, { tab_id: tab.id, text: '/compact' }, null));
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
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Arquivo vazio');
      // A refusal is logged with the step's status and code (TER-1105): the app shows the reason, the log says where it broke.
      const saved = await saveFileOnMachine(machine, body, name).catch((err: unknown) => {
        const status = err instanceof HttpError ? err.statusCode : 500;
        request.log.warn({ tabId: tab.id, machineId: machine.id, bytes: body.length, status, code: err instanceof HttpError ? err.code : null }, 'tab chat: file not saved');
        throw err;
      });
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
