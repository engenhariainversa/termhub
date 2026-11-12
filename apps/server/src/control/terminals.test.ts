import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/errors.js';

const { captureScreen, ensureSession, awaitAgent, killTmuxSession, paneForeground, requireAgentVersion, sendKeyToSession, sendTextToSession, typeCommandLine, waitForState } = vi.hoisted(() => ({
  captureScreen: vi.fn(),
  paneForeground: vi.fn(),
  ensureSession: vi.fn(),
  awaitAgent: vi.fn(async () => true),
  killTmuxSession: vi.fn(),
  requireAgentVersion: vi.fn(),
  sendKeyToSession: vi.fn(),
  sendTextToSession: vi.fn(),
  typeCommandLine: vi.fn(),
  waitForState: vi.fn(),
}));
vi.mock('../agent/screen.js', () => ({ captureScreen }));
vi.mock('../agent/registry.js', () => ({ agents: { awaitAgent } }));
vi.mock('../agent/errors.js', () => ({ requireAgentVersion }));
vi.mock('../terminal/session-ops.js', () => ({ ensureSession, paneForeground, sendKeyToSession, sendTextToSession, typeCommandLine, TERMINAL_RPC_MIN_AGENT_VERSION: '0.2.0', INPUT_MAX_CHARS: 4000 }));
vi.mock('../terminal/machine-exec.js', () => ({ killTmuxSession }));
const { removeTabMcp } = vi.hoisted(() => ({ removeTabMcp: vi.fn(async () => undefined) }));
vi.mock('../terminal/tab-mcp.js', () => ({ removeTabMcp }));
// Only waitForState is faked here; assertTerminal/clamp/offline/SCREEN_*_LINES come from the real module
// (screen.test.ts already covers waitForState's own behavior — this file only needs to control when it resolves).
vi.mock('./screen.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./screen.js')>();
  return { ...actual, waitForState };
});

const dialogFixture = (name: string) => readFileSync(new URL(`../monitor/fixtures/cli-dialogs/${name}.txt`, import.meta.url), 'utf8');
const TEACH = dialogFixture('claude-teach-auto-mode-2.1.322');
const HOOKS_REVIEW = dialogFixture('codex-hooks-review-0.159.3');

const { closeTab, MAX_TABS_PER_TOKEN, openTab, runCommand, sendInput, sendKey, typeCommandInTab } = await import('./terminals.js');
const { resetInputOrigins, takeInputOrigin } = await import('../terminal/input-origin.js');
const { resetUndelivered, undeliveredOf } = await import('../terminal/deliveries.js');

const machine = { id: 'm1', name: 'jarvis', type: 'agent', os: 'linux', capabilities: ['tmux'], owner_id: 'u1' };
const machine2 = { id: 'm2', name: 'mac mini', type: 'agent', os: 'macos', capabilities: ['tmux'], owner_id: 'u1' };
const project = { id: 'p1', name: 'app', status: 'active', owner_id: 'u1', key: 'APP', next_task_number: 1 };
const link = { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/home/u/app', position: 0, created_at: '' };
const tab = (over: Record<string, unknown> = {}) => ({ id: 't1', project_id: 'p1', machine_id: 'm1', name: 'Terminal 1', kind: 'terminal', tmux_session: 'termhub-p1-t1', state: null, state_text: null, state_at: null, created_by_token_id: 'tok1', ...over });

function ctxWith(over: Record<string, unknown> = {}) {
  const tabs = {
    create: vi.fn(async (_p, _m, name) => tab({ name })),
    listByProject: vi.fn(async () => []),
    countOpenByToken: vi.fn(async () => 0),
    delete: vi.fn(async () => true),
    findById: vi.fn(async () => tab()),
    ...(over.tabs as object),
  };
  const projectMachines = {
    find: vi.fn(async (p: string, m: string) => (p === 'p1' && m === 'm1' ? link : undefined)),
    listByProject: vi.fn(async () => [link]),
    ...(over.projectMachines as object),
  };
  return {
    repos: { tabs, projectMachines, ...(over.repos as object) },
    scope: { user: { id: 'u1' }, ownerId: 'u1', createAs: 'u1' },
    scoped: {
      project: vi.fn(async () => ({ project })),
      projectMachine: vi.fn(async () => ({ project, machine, link })),
      projectMachines: vi.fn(async () => ({ project, machines: (await projectMachines.listByProject('p1')).map((l: typeof link) => ({ machine: l.machine_id === 'm1' ? machine : machine2, link: l })) })),
      projectMachineFor: vi.fn(async (projectId: string, machineId?: string) => {
        const pick = (l: typeof link) => (l.machine_id === 'm1' ? machine : machine2);
        if (machineId) {
          const l = await projectMachines.find(projectId, machineId);
          if (!l) throw new HttpError(404, 'Máquina não vinculada ao projeto', 'NOT_FOUND');
          return { project, machine: pick(l), link: l };
        }
        const links = await projectMachines.listByProject(projectId);
        if (links.length === 0) throw new HttpError(400, 'Vincule uma máquina ao projeto antes de abrir um terminal', 'NO_MACHINE');
        if (links.length > 1) throw new HttpError(400, 'Escolha a máquina onde abrir o terminal (machine_id)', 'MACHINE_REQUIRED');
        return { project, machine: pick(links[0]), link: links[0] };
      }),
      tab: vi.fn(async () => ({ tab: (over.tab as object) ?? tab(), machine, cwd: link.cwd })),
    },
    can: vi.fn(async () => true),
    token: 'token' in over ? over.token : { id: 'tok1', scopes: ['terminals'] },
    ...(over.approval ? { approval: over.approval } : {}),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations: a test that made requireAgentVersion throw would leak into the next one.
  requireAgentVersion.mockReset();
  waitForState.mockReset();
  awaitAgent.mockReset().mockResolvedValue(true);
  ensureSession.mockResolvedValue({ created: true });
  paneForeground.mockReset().mockResolvedValue('busy');
  resetUndelivered();
});

describe('openTab', () => {
  it('creates the tab, starts its session in the project cwd and records the token', async () => {
    const ctx = ctxWith();
    const r = await openTab(ctx, { project_id: 'p1' });
    expect(ctx.repos.tabs.create).toHaveBeenCalledWith('p1', 'm1', expect.stringMatching(/^[A-Z][a-z]+$/), { created_by_token_id: 'tok1' });
    expect(ensureSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', '/home/u/app');
    expect(r).toMatchObject({ tab_id: 't1', machine_id: 'm1', created: true });
  });

  it('with a cwd from the server, keeps it on the tab and starts the session there (TER-870)', async () => {
    const ctx = ctxWith();
    await openTab(ctx, { project_id: 'p1' }, { cwd: '/home/u/.termhub/worktrees/APP-7' });
    expect(ctx.repos.tabs.create).toHaveBeenCalledWith('p1', 'm1', expect.any(String), { created_by_token_id: 'tok1', cwd: '/home/u/.termhub/worktrees/APP-7' });
    expect(ensureSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', '/home/u/.termhub/worktrees/APP-7');
  });

  it('without a cwd (manual and MCP tabs), the tab row and the session folder are as before (TER-870)', async () => {
    for (const internal of [undefined, {}]) {
      vi.clearAllMocks();
      const ctx = ctxWith();
      await openTab(ctx, { project_id: 'p1' }, internal);
      expect(ctx.repos.tabs.create.mock.calls[0][3]).toStrictEqual({ created_by_token_id: 'tok1' });
      expect(ensureSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', '/home/u/app');
    }
  });

  it('openTab needs machine_id when the project has two machines and reports it in the result', async () => {
    const ctx = ctxWith();
    (ctx.repos.projectMachines.listByProject as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/a', position: 0, created_at: '' },
      { id: 'l2', project_id: 'p1', machine_id: 'm2', cwd: '/b', position: 1, created_at: '' },
    ]);
    await expect(openTab(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'MACHINE_REQUIRED' });
    const r = await openTab(ctx, { project_id: 'p1', machine_id: 'm1' });
    expect(r.machine_id).toBe('m1');
  });

  it('stops at the per-token limit instead of filling the project with tabs', async () => {
    const ctx = ctxWith({ tabs: { countOpenByToken: vi.fn(async () => MAX_TABS_PER_TOKEN) } });
    await expect(openTab(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'TAB_LIMIT' });
    expect(ctx.repos.tabs.create).not.toHaveBeenCalled();
  });

  it('refuses when the machine is offline', async () => {
    awaitAgent.mockResolvedValue(false);
    const ctx = ctxWith();
    await expect(openTab(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'MACHINE_OFFLINE' });
    expect(ctx.repos.tabs.create).not.toHaveBeenCalled();
  });

  it('proceeds once a moving agent (a deploy) attaches within the wait, instead of answering offline at once', async () => {
    let release!: (v: boolean) => void;
    awaitAgent.mockReturnValue(new Promise<boolean>((r) => (release = r)));
    const ctx = ctxWith();
    const opening = openTab(ctx, { project_id: 'p1' });
    await Promise.resolve();
    expect(ctx.repos.tabs.create).not.toHaveBeenCalled();
    release(true);
    const r = await opening;
    expect(r).toMatchObject({ tab_id: 't1', machine_id: 'm1', created: true });
    expect(awaitAgent).toHaveBeenCalledWith(machine);
  });

  it('refuses an outdated agent before creating a tab that could not be used', async () => {
    requireAgentVersion.mockImplementation(() => {
      throw new HttpError(409, 'Atualize o agente desta máquina', 'AGENT_OUTDATED');
    });
    const ctx = ctxWith();
    await expect(openTab(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(ctx.repos.tabs.create).not.toHaveBeenCalled();
  });

  it('keeps the tab id in the error when the session fails to start after the row is already created', async () => {
    ensureSession.mockRejectedValue(new Error('tmux: command not found'));
    const ctx = ctxWith();
    await expect(openTab(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'SESSION_FAILED', message: expect.stringContaining('t1') });
    expect(ctx.repos.tabs.create).toHaveBeenCalled();
  });
});

describe('sendInput', () => {
  it('makes sure the session is there before typing', async () => {
    await sendInput(ctxWith(), { tab_id: 't1', text: 'oi', enter: true });
    expect(ensureSession).toHaveBeenCalled();
    expect(sendTextToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'oi', true);
  });

  it('requests paste when the text has an embedded newline (a multi-line prompt)', async () => {
    await sendInput(ctxWith(), { tab_id: 't1', text: 'linha um\nlinha dois', enter: true });
    expect(sendTextToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'linha um\nlinha dois', true, { paste: true });
  });

  it('does not request paste for single-line text', async () => {
    await sendInput(ctxWith(), { tab_id: 't1', text: 'oi', enter: true });
    expect(sendTextToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'oi', true);
  });

  it('refuses a pending permission unless the caller says it is answering it', async () => {
    const ctx = ctxWith({ tab: tab({ state: 'waiting_permission', state_text: 'Permitir escrever em src/app.ts?' }) });
    await expect(sendInput(ctx, { tab_id: 't1', text: 'sim' })).rejects.toMatchObject({ code: 'WAITING_PERMISSION', message: expect.stringContaining('Permitir escrever em src/app.ts?') });
    expect(sendTextToSession).not.toHaveBeenCalled();
    await expect(sendInput(ctx, { tab_id: 't1', text: 'sim', answering_permission: true })).resolves.toMatchObject({ sent: true });
  });

  // TER-1166: a modal dialog of the CLI holds the input; the text would be lost while the answer said "sent"
  it('refuses to type into a tab held by a CLI dialog, naming it, and types nothing', async () => {
    captureScreen.mockResolvedValueOnce(TEACH);
    await expect(sendInput(ctxWith({ tab: tab({ state: 'finished' }) }), { tab_id: 't1', text: 'reenvia o resumo' })).rejects.toMatchObject({
      code: 'CLI_DIALOG_OPEN',
      message: expect.stringContaining('Teach auto mode about your environment?'),
    });
    captureScreen.mockResolvedValueOnce(HOOKS_REVIEW);
    await expect(sendInput(ctxWith(), { tab_id: 't1', text: 'oi', enter: false })).rejects.toMatchObject({ code: 'CLI_DIALOG_OPEN', message: expect.stringContaining('Hooks need review') });
    expect(sendTextToSession).not.toHaveBeenCalled();
  });

  it('types as before when the screen shows no dialog, cannot be read, or the text answers a dialog on purpose', async () => {
    captureScreen.mockResolvedValueOnce('● Pronto.\n\n────────────\n❯ \n────────────');
    await expect(sendInput(ctxWith(), { tab_id: 't1', text: 'oi' })).resolves.toMatchObject({ sent: true });
    captureScreen.mockRejectedValueOnce(new Error('rpc timeout'));
    await expect(sendInput(ctxWith(), { tab_id: 't1', text: 'oi' })).resolves.toMatchObject({ sent: true });
    // an answer typed into a permission or question dialog on purpose: the screen is not even read
    captureScreen.mockClear();
    await expect(sendInput(ctxWith(), { tab_id: 't1', text: '2', enter: false, answering_permission: true })).resolves.toMatchObject({ sent: true });
    expect(captureScreen).not.toHaveBeenCalled();
    expect(sendTextToSession).toHaveBeenCalledTimes(3);
  });

  it('refuses text over the cap instead of cutting it', async () => {
    await expect(sendInput(ctxWith(), { tab_id: 't1', text: 'x'.repeat(4001) })).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
  });

  it('refuses a tab that is not a terminal', async () => {
    const ctx = ctxWith({ tab: tab({ kind: 'simulator', tmux_session: null }) });
    await expect(sendInput(ctx, { tab_id: 't1', text: 'oi' })).rejects.toMatchObject({ code: 'NOT_A_TERMINAL' });
  });
});

// TER-1168: the concierge typed a request into a tab whose Claude had exited; it ran in the shell and the answer said "sent"
describe('sendInput into an agent that exited (TER-1168)', () => {
  const agentTab = (over: Record<string, unknown> = {}) => tab({ state: 'idle', state_tool: 'claude', state_at: '2026-11-11T10:00:00.000Z', ...over });
  const fast = { deliveryWaitMs: 20, deliveryPollMs: 5 };

  it('refuses with AGENT_NOT_RUNNING and types nothing when the pane is back at its shell (or dead)', async () => {
    for (const pane of ['shell', 'dead']) {
      paneForeground.mockResolvedValueOnce(pane);
      await expect(sendInput(ctxWith({ tab: agentTab() }), { tab_id: 't1', text: 'publica o pda-app' }, undefined, { requireAgent: true })).rejects.toMatchObject({ code: 'AGENT_NOT_RUNNING', message: expect.stringContaining('to_shell: true') });
    }
    // a tab started by start_agent whose hooks never reported is an agent tab too
    paneForeground.mockResolvedValueOnce('shell');
    await expect(sendInput(ctxWith({ tab: tab({ ai_account_id: 'acc1' }) }), { tab_id: 't1', text: 'oi' }, undefined, { requireAgent: true })).rejects.toMatchObject({ code: 'AGENT_NOT_RUNNING' });
    expect(sendTextToSession).not.toHaveBeenCalled();
  });

  it('types into a shell tab that never ran an agent, into the shell on purpose, and when the pane cannot be read', async () => {
    paneForeground.mockResolvedValue('shell');
    // open_tab's shell: never checked
    await expect(sendInput(ctxWith(), { tab_id: 't1', text: 'ls' }, undefined, { requireAgent: true })).resolves.toMatchObject({ sent: true });
    // to_shell: the caller does not ask for the check
    await expect(sendInput(ctxWith({ tab: agentTab() }), { tab_id: 't1', text: 'claude --continue' }, undefined, {})).resolves.toMatchObject({ sent: true });
    // an agent older than 0.14.0 or a failed call: the check never blocks typing on its own failure
    paneForeground.mockRejectedValueOnce(Object.assign(new Error('old'), { code: 'AGENT_OUTDATED' }));
    await expect(sendInput(ctxWith({ tab: agentTab() }), { tab_id: 't1', text: 'oi' }, undefined, { requireAgent: true })).resolves.toMatchObject({ sent: true });
    expect(sendTextToSession).toHaveBeenCalledTimes(3);
  });

  it('says delivered: true once the tab starts a turn after the text', async () => {
    const eventsAfter = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{ id: 'e1', kind: 'working', created_at: new Date().toISOString(), meta: {} }]);
    const ctx = ctxWith({ tab: agentTab({ state: 'finished' }), tabs: { eventsAfter } });
    const r = await sendInput(ctx, { tab_id: 't1', text: 'continua' }, undefined, { requireAgent: true, confirm: true, deliveryWaitMs: 1000, deliveryPollMs: 5 });
    expect(r).toEqual({ tab_id: 't1', sent: true, delivered: true });
    expect(eventsAfter).toHaveBeenCalledWith('t1', expect.any(Date), ['working', 'waiting_permission', 'error'], 1);
    expect(undeliveredOf('t1')).toBeNull();
  });

  it('says delivered: false with the reason when no turn started, and keeps it for the tab\'s watches', async () => {
    const eventsAfter = vi.fn(async () => []);
    // the agent left between the check and the Enter
    paneForeground.mockResolvedValueOnce('busy').mockResolvedValueOnce('shell');
    const exited = await sendInput(ctxWith({ tab: agentTab({ state: 'finished' }), tabs: { eventsAfter } }), { tab_id: 't1', text: 'oi' }, undefined, { requireAgent: true, confirm: true, ...fast });
    expect(exited).toMatchObject({ sent: true, delivered: false, reason: 'agent_exited', note: expect.stringContaining('Do not promise') });
    expect(undeliveredOf('t1')).toMatchObject({ reason: 'agent_exited' });
    // nothing moved and no dialog: no reaction
    captureScreen.mockResolvedValue('● Pronto.\n\n────────────\n❯ oi\n────────────');
    const none = await sendInput(ctxWith({ tab: agentTab({ state: 'waiting_input' }), tabs: { eventsAfter } }), { tab_id: 't1', text: 'oi' }, undefined, { requireAgent: true, confirm: true, ...fast });
    expect(none).toMatchObject({ delivered: false, reason: 'no_reaction', note: expect.stringContaining('read_screen') });
  });

  it('does not wait when there is nothing to confirm: no Enter, a working agent (queued), no hooks, a shell tab', async () => {
    const eventsAfter = vi.fn(async () => []);
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [agentTab({ state: 'finished' }), { enter: false }],
      [agentTab({ state: 'working' }), {}],
      [tab({ ai_account_id: 'acc1' }), {}],
      [tab(), {}],
    ];
    for (const [t, extra] of cases) {
      const r = await sendInput(ctxWith({ tab: t, tabs: { eventsAfter } }), { tab_id: 't1', text: 'oi', ...extra }, undefined, { requireAgent: true, confirm: true, ...fast });
      expect(r).toEqual({ tab_id: 't1', sent: true });
    }
    expect(eventsAfter).not.toHaveBeenCalled();
  });
});

describe('sendKey into an agent that exited (TER-1168)', () => {
  it('refuses with AGENT_NOT_RUNNING when asked to, and presses the key otherwise', async () => {
    paneForeground.mockResolvedValue('shell');
    const ctx = ctxWith({ tab: tab({ state: 'idle', state_tool: 'codex' }) });
    await expect(sendKey(ctx, { tab_id: 't1', key: 'Enter' }, { requireAgent: true })).rejects.toMatchObject({ code: 'AGENT_NOT_RUNNING' });
    expect(sendKeyToSession).not.toHaveBeenCalled();
    await expect(sendKey(ctx, { tab_id: 't1', key: 'C-c' })).resolves.toMatchObject({ sent: true });
  });
});

// TER-988: the line that resumes an exited agent runs in the shell through typeCommandLine (a file past 900
// bytes, session-ops.test.ts), past sendInput's 4000-character cap and with no origin recorded.
describe('typeCommandInTab', () => {
  it('makes sure the session is there, then hands the whole line to typeCommandLine', async () => {
    const line = `claude --resume x -- '${'a'.repeat(5000)}'`;
    await typeCommandInTab(ctxWith(), 't1', line);
    expect(ensureSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', link.cwd);
    expect(typeCommandLine).toHaveBeenCalledWith(machine, 'termhub-p1-t1', line);
    expect(sendTextToSession).not.toHaveBeenCalled();
    expect(takeInputOrigin('t1', line)).toBeNull();
  });

  it('refuses a tab that is not a terminal, or a machine that is offline', async () => {
    await expect(typeCommandInTab(ctxWith({ tab: tab({ kind: 'simulator', tmux_session: null }) }), 't1', 'claude --continue')).rejects.toMatchObject({ code: 'NOT_A_TERMINAL' });
    awaitAgent.mockResolvedValueOnce(false);
    await expect(typeCommandInTab(ctxWith(), 't1', 'claude --continue')).rejects.toBeTruthy();
    expect(typeCommandLine).not.toHaveBeenCalled();
  });
});

describe('sendInput: who wrote the text (TER-851)', () => {
  const HOUR = 60 * 60_000;
  const memoryRepos = (createdAgo = HOUR, over: Record<string, unknown> = {}) => ({
    memoryItems: {
      findManyForOwner: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' ? ids.filter((i) => i.startsWith('mi')).map((i) => ({ id: i, kind: 'message', trust: 'person', source_id: `cm-${i}`, ...over })) : [])),
      // A chat message `cmN` the person typed is indexed by the item `ixN` (TER-1037).
      findMessagesBySource: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' ? ids.filter((i) => /^cm\d+$/.test(i)).map((i) => ({ id: `ix${i.slice(2)}`, kind: 'message', trust: 'person', source_id: i, ...over })) : [])),
    },
    chat: { findUserMessagesForUser: vi.fn(async (ids: string[]) => ids.map((i) => ({ id: i, role: 'user', created_at: new Date(Date.now() - createdAgo).toISOString() }))) },
  });
  const gated = { id: 'chat-tok', scopes: ['terminals'], gated: true };
  beforeEach(() => resetInputOrigins());

  it('marks the chat assistant when it sends on its own', async () => {
    await sendInput(ctxWith({ token: gated }), { tab_id: 't1', text: 'rode os testes' });
    expect(takeInputOrigin('t1', 'rode os testes')).toEqual({ level: 'assistant', userId: 'u1' });
  });

  it('marks the person’s request, with their messages, when on_behalf_of checks out', async () => {
    await sendInput(ctxWith({ token: gated, repos: memoryRepos() }), { tab_id: 't1', text: 'pode mesclar', on_behalf_of: ['message:mi1', 'message:mi2'] });
    expect(takeInputOrigin('t1', 'pode mesclar')).toEqual({ level: 'person_requested', userId: 'u1', messageIds: ['cm-mi1', 'cm-mi2'] });
  });

  it('takes the ref of the chat message itself, the one the chat hands the concierge (TER-1037)', async () => {
    await sendInput(ctxWith({ token: gated, repos: memoryRepos() }), { tab_id: 't1', text: 'pode mesclar', on_behalf_of: ['message:cm7', 'message:mi1'] });
    expect(takeInputOrigin('t1', 'pode mesclar')).toEqual({ level: 'person_requested', userId: 'u1', messageIds: ['cm7', 'cm-mi1'] });
  });

  it('refuses the ref of a chat message nothing indexed (a wake, an injected decision)', async () => {
    const repos = memoryRepos();
    repos.memoryItems.findMessagesBySource.mockResolvedValueOnce([]);
    await expect(sendInput(ctxWith({ token: gated, repos }), { tab_id: 't1', text: 'x', on_behalf_of: ['message:cm7'] })).rejects.toMatchObject({ code: 'ON_BEHALF_INVALID' });
    expect(sendTextToSession).not.toHaveBeenCalled();
  });

  it('marks a clicked confirmation card as the person’s approval, even under the chat token', async () => {
    const approvedAt = new Date('2026-10-04T20:00:00Z');
    await sendInput(ctxWith({ token: gated, approval: { actionId: 'a1', approvedAt } }), { tab_id: 't1', text: 'pode mesclar' });
    expect(takeInputOrigin('t1', 'pode mesclar')).toEqual({ level: 'person_approved', userId: 'u1', actionId: 'a1', approvedAt });
  });

  it('marks any other token as an MCP client', async () => {
    await sendInput(ctxWith(), { tab_id: 't1', text: 'oi' });
    expect(takeInputOrigin('t1', 'oi')).toEqual({ level: 'mcp_client', userId: 'u1', tokenId: 'tok1' });
  });

  it('takes the origin a termhub screen gives, and records nothing for null', async () => {
    await sendInput(ctxWith({ token: undefined }), { tab_id: 't1', text: 'oi' }, { level: 'person_typed', userId: 'u1', surface: 'app' });
    expect(takeInputOrigin('t1', 'oi')).toEqual({ level: 'person_typed', userId: 'u1', surface: 'app' });
    await sendInput(ctxWith(), { tab_id: 't1', text: '/clear' }, null);
    expect(takeInputOrigin('t1', '/clear')).toBeNull();
  });

  it('refuses on_behalf_of outside the chat token', async () => {
    await expect(sendInput(ctxWith({ repos: memoryRepos() }), { tab_id: 't1', text: 'x', on_behalf_of: ['message:mi1'] })).rejects.toMatchObject({ code: 'ON_BEHALF_NOT_ALLOWED' });
    expect(sendTextToSession).not.toHaveBeenCalled();
  });

  it.each([
    ['another kind of ref', ['note:mi1'], memoryRepos()],
    ['someone else’s or a missing message', ['message:zz1'], memoryRepos()],
    ['an item that is not the person’s', ['message:mi1'], memoryRepos(HOUR, { trust: 'derived' })],
    ['a message older than 24 h', ['message:mi1'], memoryRepos(25 * HOUR)],
  ])('refuses %s, typing nothing', async (_label, refs, repos) => {
    await expect(sendInput(ctxWith({ token: gated, repos }), { tab_id: 't1', text: 'x', on_behalf_of: refs })).rejects.toMatchObject({ code: 'ON_BEHALF_INVALID' });
    expect(sendTextToSession).not.toHaveBeenCalled();
  });

  it('refuses a memory item whose chat message is not the person’s (an assistant answer, another user)', async () => {
    const repos = { ...memoryRepos(), chat: { findUserMessagesForUser: vi.fn(async () => []) } };
    await expect(sendInput(ctxWith({ token: gated, repos }), { tab_id: 't1', text: 'x', on_behalf_of: ['message:mi1'] })).rejects.toMatchObject({ code: 'ON_BEHALF_INVALID' });
  });

  it('records what run_command types too', async () => {
    captureScreen.mockResolvedValue('$');
    await runCommand(ctxWith({ token: gated }), { tab_id: 't1', command: 'ls', timeout_seconds: 1 });
    expect(takeInputOrigin('t1', 'ls')).toEqual({ level: 'assistant', userId: 'u1' });
  });
});

describe('sendKey', () => {
  it('presses the key in the session', async () => {
    await expect(sendKey(ctxWith(), { tab_id: 't1', key: 'C-c' })).resolves.toMatchObject({ key: 'C-c', sent: true });
    expect(sendKeyToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'C-c');
  });

  it('says which CLI dialog is still open after the key, and nothing when it closed (TER-1166)', async () => {
    captureScreen.mockResolvedValueOnce(TEACH);
    const open = await sendKey(ctxWith(), { tab_id: 't1', key: 'Down' });
    expect(open).toMatchObject({ sent: true, dialog: { cli: 'claude', id: 'claude_auto_mode_setup', title: 'Teach auto mode about your environment?', note: expect.stringContaining('still open') } });
    captureScreen.mockResolvedValueOnce('● Pronto.\n\n────────────\n❯ \n────────────');
    const closed = await sendKey(ctxWith(), { tab_id: 't1', key: 'Escape' });
    expect(closed).toEqual({ tab_id: 't1', key: 'Escape', sent: true });
  });
});

describe('runCommand', () => {
  it('types the command, waits for the screen to settle and returns it', async () => {
    captureScreen.mockResolvedValueOnce('running…').mockResolvedValue('$ echo oi\noi\n$');
    const r = await runCommand(ctxWith(), { tab_id: 't1', command: 'echo oi', timeout_seconds: 5 });
    expect(sendTextToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'echo oi', true);
    expect(r).toMatchObject({ tab_id: 't1', timed_out: false, text: '$ echo oi\noi\n$' });
  });

  it('comes back with the screen and timed_out when the command keeps going', async () => {
    let n = 0;
    captureScreen.mockImplementation(async () => `busy ${n++}`);
    const r = await runCommand(ctxWith(), { tab_id: 't1', command: 'sleep 60', timeout_seconds: 2 });
    expect(r.timed_out).toBe(true);
    expect(r.text).toContain('busy');
  });

  it('refuses a command over the cap instead of typing it', async () => {
    await expect(runCommand(ctxWith(), { tab_id: 't1', command: 'x'.repeat(4001) })).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
    expect(sendTextToSession).not.toHaveBeenCalled();
  });

  it('refuses a tab that is waiting on a permission, with no way to bypass it', async () => {
    const ctx = ctxWith({ tab: tab({ state: 'waiting_permission', state_text: 'Permitir rodar npm install?' }) });
    await expect(runCommand(ctx, { tab_id: 't1', command: 'npm install' })).rejects.toMatchObject({ code: 'WAITING_PERMISSION', message: expect.stringContaining('Permitir rodar npm install?') });
    expect(sendTextToSession).not.toHaveBeenCalled();
  });

  it('delegates to waitForState once the tab is already working when read', async () => {
    const ctx = ctxWith({ tab: tab({ state: 'working' }) });
    waitForState.mockResolvedValue({ tab_id: 't1', state: 'waiting_input', state_text: null, state_at: null, timed_out: false });
    captureScreen.mockResolvedValue('$ npm test\nok\n$');
    const r = await runCommand(ctx, { tab_id: 't1', command: 'npm test', timeout_seconds: 10 });
    expect(waitForState).toHaveBeenCalledWith(ctx, expect.objectContaining({ tab_id: 't1' }), undefined);
    expect(ctx.repos.tabs.findById).not.toHaveBeenCalled();
    expect(r).toMatchObject({ tab_id: 't1', state: 'waiting_input', timed_out: false });
  });

  it('waits for the hook to mark the tab working before delegating to waitForState', async () => {
    let calls = 0;
    const ctx = ctxWith({
      tab: tab({ state: 'idle' }),
      tabs: { findById: vi.fn(async () => (calls++ === 0 ? tab({ state: 'idle' }) : tab({ state: 'working' }))) },
    });
    waitForState.mockResolvedValue({ tab_id: 't1', state: 'waiting_input', state_text: null, state_at: null, timed_out: false });
    captureScreen.mockResolvedValue('$ npm test\nok\n$');
    const r = await runCommand(ctx, { tab_id: 't1', command: 'npm test', timeout_seconds: 10 });
    expect(ctx.repos.tabs.findById).toHaveBeenCalled();
    expect(waitForState).toHaveBeenCalledWith(ctx, expect.objectContaining({ tab_id: 't1' }), undefined);
    expect(r).toMatchObject({ tab_id: 't1', state: 'waiting_input', timed_out: false });
  });

  it('falls back to the screen poll when a tab with monitor state never reports working', async () => {
    const ctx = ctxWith({
      tab: tab({ state: 'idle' }),
      tabs: { findById: vi.fn(async () => tab({ state: 'idle' })) },
    });
    let n = 0;
    captureScreen.mockImplementation(async () => `busy ${n++}`);
    const r = await runCommand(ctx, { tab_id: 't1', command: 'sleep 60', timeout_seconds: 3 });
    expect(waitForState).not.toHaveBeenCalled();
    expect(r.timed_out).toBe(true);
    expect(r.text).toContain('busy');
  });
});

describe('closeTab', () => {
  it('kills the session and removes a tab this token opened', async () => {
    killTmuxSession.mockResolvedValue(true);
    await expect(closeTab(ctxWith(), { tab_id: 't1' })).resolves.toEqual({ tab_id: 't1', killed: true });
  });

  it("removes the tab's MCP config dir from the machine, best effort, even when the kill fails", async () => {
    killTmuxSession.mockRejectedValue(new Error('offline'));
    removeTabMcp.mockClear();
    await expect(closeTab(ctxWith(), { tab_id: 't1' })).resolves.toEqual({ tab_id: 't1', killed: false });
    expect(removeTabMcp).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 't1');
  });

  it('refuses a tab opened somewhere else unless force is given', async () => {
    const ctx = ctxWith({ tab: tab({ created_by_token_id: null }) });
    await expect(closeTab(ctx, { tab_id: 't1' })).rejects.toMatchObject({ code: 'NOT_YOURS' });
    await expect(closeTab(ctx, { tab_id: 't1', force: true })).resolves.toMatchObject({ tab_id: 't1' });
  });

  it('closes any tab of the user without force on a gated (chat) token: the gate already asked', async () => {
    killTmuxSession.mockResolvedValue(true);
    for (const created_by_token_id of [null, 'tok-old-concierge']) {
      const ctx = ctxWith({ tab: tab({ created_by_token_id }) });
      (ctx as { token: unknown }).token = { id: 'tok1', scopes: ['terminals'], gated: true };
      await expect(closeTab(ctx, { tab_id: 't1' })).resolves.toEqual({ tab_id: 't1', killed: true });
    }
  });

  it('tells the public channel the tab is gone', async () => {
    const { publicBus } = await import('../public/bus.js');
    const gone: unknown[] = [];
    const off = publicBus.subscribeTabRemoved((c) => gone.push(c));
    try {
      killTmuxSession.mockResolvedValue(true);
      await closeTab(ctxWith(), { tab_id: 't1' });
      expect(gone).toEqual([{ tab_id: 't1', project_id: 'p1', machine_id: 'm1' }]);
    } finally {
      off();
    }
  });

  it('still removes the tab when the session could not be killed', async () => {
    killTmuxSession.mockRejectedValue(new Error('offline'));
    const ctx = ctxWith();
    await expect(closeTab(ctx, { tab_id: 't1' })).resolves.toEqual({ tab_id: 't1', killed: false });
    expect(ctx.repos.tabs.delete).toHaveBeenCalledWith('t1');
  });
});

describe('open/close on the monitor bus', () => {
  it('openTab publishes the new tab and closeTab its removal, scoped by the machine owner', async () => {
    const { monitorBus } = await import('../monitor/bus.js');
    const events: unknown[] = [];
    const off = monitorBus.subscribeLifecycle((e) => events.push(e));
    try {
      await openTab(ctxWith(), { project_id: 'p1' });
      killTmuxSession.mockResolvedValue(true);
      await closeTab(ctxWith(), { tab_id: 't1' });
    } finally {
      off();
    }
    expect(events).toEqual([
      { kind: 'upsert', tab: expect.objectContaining({ id: 't1' }), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' },
      { kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u1' },
    ]);
  });
});
