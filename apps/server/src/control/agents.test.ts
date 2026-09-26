import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openTab, sendTextToSession } = vi.hoisted(() => ({ openTab: vi.fn(), sendTextToSession: vi.fn() }));
vi.mock('../config.js', () => ({ config: { publicUrl: 'https://app.test' } }));
vi.mock('./terminals.js', () => ({ openTab }));
vi.mock('../terminal/session-ops.js', () => ({ sendTextToSession }));

import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Project, Task } from '../db/repositories/types.js';
import { Scoped } from '../auth/scope.js';
import { ControlError, type ControlContext } from './context.js';
import { checkPrompt, launchLine, PROMPT_MAX_CHARS, RESUME_PROMPT, resumeLine, startAgent } from './agents.js';

const machine = (over: Partial<Machine> & { id: string }): Machine => ({
  name: over.id, host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: 'macos', capabilities: ['tmux', 'claude', 'codex'], checked_at: null,
  agent_version: '0.2.3', agent_last_seen_at: null, agent_auto_update: false, is_local: false, owner_id: 'u1', owner_name: null, created_at: '', ...over,
});
const project = (over: Partial<Project> & { id: string }): Project => ({
  owner_id: 'u1', key: over.id.toUpperCase(), next_task_number: 1, name: over.id, status: 'active', description: null, last_terminal_at: null, created_at: '', ...over,
});
const account = (over: Partial<AiAccount> & { id: string; machine_id: string }): AiAccount => ({ provider: 'claude', label: over.id, config_dir: null, created_at: '', ...over });
const task = (over: Partial<Task> & { id: string; project_id: string }): Task => ({
  title: over.id, description: null, status: 'todo', position: 0, external_ref: null, external_key: null, tab_id: null, parent_id: null, created_at: '', updated_at: '', ...over,
});

/** u1 owns m1 (project p1, accounts a1/a2) and m2 (project p2, account a3); u2 owns mx. */
const machines = [machine({ id: 'm1', name: 'MacBook Pro M4' }), machine({ id: 'm2', name: 'mac mini', capabilities: ['tmux', 'claude'] }), machine({ id: 'mx', owner_id: 'u2' })];
const projects = [project({ id: 'p1' }), project({ id: 'p2' }), project({ id: 'px', owner_id: 'u2' })];
const links = [
  { project_id: 'p1', machine_id: 'm1', cwd: '/src/p1' },
  { project_id: 'p2', machine_id: 'm2', cwd: '/src/p2' },
  { project_id: 'px', machine_id: 'mx', cwd: '/x' },
].map((l, i) => ({ id: `l${i}`, position: 0, created_at: '', ...l }));
const accounts = [
  account({ id: 'a1', label: 'pedrogoiania', machine_id: 'm1', config_dir: '/Users/p/.claude-work' }),
  account({ id: 'a2', label: 'ChatGPT', provider: 'chatgpt', machine_id: 'm1' }),
  account({ id: 'a3', label: 'Claude', machine_id: 'm2' }),
  account({ id: 'a4', label: 'Codex', provider: 'chatgpt', machine_id: 'm2' }),
  account({ id: 'a5', label: 'Gemini', provider: 'gemini', machine_id: 'm1' }),
  account({ id: 'ax', label: 'other', machine_id: 'mx' }),
];
const k1 = task({ id: 'k1', project_id: 'p1', title: 'Write the spec for XPTO' });
const kdoing = task({ id: 'k2', project_id: 'p1', title: 'Already', status: 'doing' });
const ksub = task({ id: 's1', project_id: 'p1', title: 'A subtask', parent_id: 'k1', tab_id: 't-old' });
const klong = task({ id: 'k3', project_id: 'p1', title: 'T'.repeat(80) });
const k9 = task({ id: 'k9', project_id: 'p2', title: 'Elsewhere' });

function ctx(grants: string[] = ['terminals:write', 'tasks:update']) {
  const repos = {
    machines: { findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)) },
    projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)) },
    projectMachines: {
      find: vi.fn(async (p: string, m: string) => links.find((l) => l.project_id === p && l.machine_id === m)),
      listByProject: vi.fn(async (p: string) => links.filter((l) => l.project_id === p)),
    },
    aiAccounts: {
      findById: vi.fn(async (id: string) => accounts.find((a) => a.id === id)),
      list: vi.fn(async (owner: string | null) => accounts.filter((a) => owner === null || machines.find((m) => m.id === a.machine_id)!.owner_id === owner)),
    },
    tasks: {
      findById: vi.fn(async (id: string) => [k1, kdoing, ksub, klong, k9].find((t) => t.id === id)),
      setTab: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      startWork: vi.fn(async () => undefined),
    },
    tabs: { setAgentFields: vi.fn(async () => undefined) },
  };
  const scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' } as const, ownerId: 'u1', createAs: 'u1' };
  const c: ControlContext = {
    repos: repos as unknown as Repositories, scope, scoped: new Scoped(repos as unknown as Repositories, scope),
    can: async (r, a) => grants.includes(`${r}:${a}`), token: { id: 'tok1', scopes: ['terminals'] },
  };
  return { c, repos };
}

beforeEach(() => {
  vi.clearAllMocks();
  openTab.mockResolvedValue({ tab_id: 't9', name: 'pedrogoiania', project_id: 'p1', tmux_session: 'termhub-p1-t9', created: true });
  sendTextToSession.mockResolvedValue(undefined);
});

describe('launchLine', () => {
  it('starts claude with the prompt as its argument, under CLAUDE_CONFIG_DIR when the account has one', () => {
    expect(launchLine('claude', '/Users/p/.claude-work', 'write a spec')).toBe("CLAUDE_CONFIG_DIR='/Users/p/.claude-work' claude 'write a spec'");
    expect(launchLine('claude', null, 'write a spec')).toBe("claude 'write a spec'");
  });

  it('starts codex under CODEX_HOME', () => {
    expect(launchLine('chatgpt', '/Users/p/.codex-work', 'fix it')).toBe("CODEX_HOME='/Users/p/.codex-work' codex 'fix it'");
    expect(launchLine('chatgpt', null, 'fix it')).toBe("codex 'fix it'");
  });

  it('keeps quotes, spaces, newlines and ; inert in the prompt and the config dir', () => {
    const line = launchLine('claude', "/tmp/it's here; rm -rf /", "say 'hi'; echo $HOME\nls");
    expect(line).toBe("CLAUDE_CONFIG_DIR='/tmp/it'\\''s here; rm -rf /' claude 'say '\\''hi'\\''; echo $HOME\nls'");
  });

  it("leaves a config dir's ~ for the machine's shell to expand, the rest still quoted", () => {
    expect(launchLine('claude', '~/.claude-work', 'write a spec')).toBe("CLAUDE_CONFIG_DIR=\"$HOME\"/'.claude-work' claude 'write a spec'");
    expect(launchLine('chatgpt', '~', 'fix it')).toBe('CODEX_HOME="$HOME" codex \'fix it\'');
    // Only the leading ~/ is outside the quotes: a tilde further in, and anything else, stays literal.
    expect(launchLine('claude', "~/it's $HOME; rm -rf /", 'x')).toBe("CLAUDE_CONFIG_DIR=\"$HOME\"/'it'\\''s $HOME; rm -rf /' claude 'x'");
    expect(launchLine('claude', '/tmp/~/x', 'x')).toBe("CLAUDE_CONFIG_DIR='/tmp/~/x' claude 'x'");
  });

  it('refuses gemini and antigravity for now', () => {
    expect(() => launchLine('gemini', null, 'x')).toThrow(new ControlError('PROVIDER_UNSUPPORTED', 'Iniciar um agente gemini ainda não é suportado; por enquanto só claude e chatgpt (Codex)'));
    expect(() => launchLine('antigravity', null, 'x')).toThrow(ControlError);
  });
});

describe('resumeLine', () => {
  const SID = '6d127d73-4bd0-42d6-b4a6-d96899507e62';
  it('resumes the session under the account, prompt quoted', () => {
    expect(resumeLine('~/.claude_b', SID, RESUME_PROMPT)).toBe(`CLAUDE_CONFIG_DIR="$HOME"/'.claude_b' claude --resume ${SID} 'A conta anterior atingiu o limite de uso. Continue a tarefa de onde parou.'`);
  });
  it('no env for the default account', () => {
    expect(resumeLine(null, SID, 'x')).toBe(`claude --resume ${SID} 'x'`);
  });
  it('refuses a session id that is not a uuid', () => {
    expect(() => resumeLine(null, "x'; rm -rf ~", 'x')).toThrow(ControlError);
  });
});

describe('checkPrompt', () => {
  it('folds CRLF into LF and keeps newlines', () => {
    expect(checkPrompt('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('refuses control characters the shell would read as keys', () => {
    for (const bad of ['a\tb', 'a\x03', '\x1b[A', 'a\x7f', 'x\x00']) expect(() => checkPrompt(bad)).toThrow(new ControlError('PROMPT_CONTROL_CHARS', 'O prompt tem caracteres de controle (tab, escape, ^C…) que o terminal leria como teclas; use só texto e quebras de linha'));
  });

  it('refuses a prompt that would be parsed as an option', () => {
    for (const bad of ['--dangerously-skip-permissions', '  -p x', '-']) expect(() => checkPrompt(bad)).toThrow(new ControlError('PROMPT_LOOKS_LIKE_FLAG', 'O prompt não pode começar com "-": o CLI leria isso como uma opção. Comece com uma palavra'));
    expect(checkPrompt('refactor - and - test')).toBe('refactor - and - test');
  });

  it('measures the limit after folding CRLF', () => {
    expect(checkPrompt('x'.repeat(PROMPT_MAX_CHARS - 1) + '\r\n')).toHaveLength(PROMPT_MAX_CHARS);
    expect(() => checkPrompt('x'.repeat(PROMPT_MAX_CHARS + 1))).toThrow(new ControlError('PROMPT_TOO_LONG', `Prompt longo demais: ${PROMPT_MAX_CHARS + 1} caracteres, máximo ${PROMPT_MAX_CHARS}`));
  });
});

describe('startAgent', () => {
  it('opens a tab named after the account, types the launch line and returns where to watch it', async () => {
    const { c } = ctx();
    const r = await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'write a spec' });
    expect(openTab).toHaveBeenCalledWith(c, { project_id: 'p1', machine_id: 'm1', name: 'claude · pedrogoiania' });
    expect(sendTextToSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'termhub-p1-t9', "CLAUDE_CONFIG_DIR='/Users/p/.claude-work' claude 'write a spec'", true);
    expect(r).toEqual({
      tab_id: 't9', tab_name: 'pedrogoiania', project_id: 'p1', tmux_session: 'termhub-p1-t9', tab_url: 'https://app.test/projects/p1', command: 'claude', task_id: null, previous_tab_id: null,
      note: 'O agente está subindo com o prompt. Chame wait_for_state para saber quando ele terminar ou perguntar algo, e read_screen para ver a tela.',
    });
  });

  it("records the account on the tab: a later swap must not pick it again", async () => {
    const { c, repos } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'write a spec' });
    expect(repos.tabs.setAgentFields).toHaveBeenCalledWith('t9', { ai_account_id: 'a1' });
  });

  it('does not fail when recording the account fails', async () => {
    const { c, repos } = ctx();
    repos.tabs.setAgentFields.mockRejectedValue(new Error('db down'));
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p' })).resolves.toMatchObject({ tab_id: 't9' });
  });

  it('uses tab_name when given, else the task title', async () => {
    const { c } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a2', prompt: 'p', tab_name: 'codex run' });
    expect(openTab).toHaveBeenLastCalledWith(c, { project_id: 'p1', machine_id: 'm1', name: 'codex run' });
    await startAgent(c, { project_id: 'p1', account_id: 'a2', prompt: 'p', task_id: 'k1' });
    expect(openTab).toHaveBeenLastCalledWith(c, { project_id: 'p1', machine_id: 'm1', name: 'Write the spec for XPTO' });
  });

  it('types the codex line for a ChatGPT account without a config dir', async () => {
    const { c } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a2', prompt: 'fix it' });
    expect(sendTextToSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'termhub-p1-t9', "codex 'fix it'", true);
    expect(openTab).toHaveBeenCalledWith(c, { project_id: 'p1', machine_id: 'm1', name: 'codex · ChatGPT' });
  });

  it('types the prompt as checked (CRLF folded)', async () => {
    const { c } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a2', prompt: 'one\r\ntwo' });
    expect(sendTextToSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), "codex 'one\ntwo'", true);
  });

  it('cuts a long task title to the tab-name limit', async () => {
    const { c } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p', task_id: 'k3' });
    expect(openTab).toHaveBeenLastCalledWith(c, { project_id: 'p1', machine_id: 'm1', name: 'T'.repeat(60) });
  });

  it('links a subtask too, reporting the tab it was linked to before', async () => {
    const { c, repos } = ctx();
    const r = await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p', task_id: 's1' });
    expect(repos.tasks.setTab).toHaveBeenCalledWith('s1', 't9');
    expect(repos.tasks.startWork).toHaveBeenCalledWith('s1');
    expect(r).toMatchObject({ task_id: 's1', previous_tab_id: 't-old' });
  });

  it('names the tab when linking the task fails after the agent started', async () => {
    const { c, repos } = ctx();
    repos.tasks.setTab.mockRejectedValue(new Error('P2025'));
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p', task_id: 'k1' })).rejects.toEqual(
      new ControlError('TASK_LINK_FAILED', 'A aba t9 foi aberta e o agente iniciado, mas a tarefa não foi vinculada: P2025. Veja a tela com read_screen ou feche a aba com close_tab.'),
    );
  });

  it('refuses a flag-like prompt before opening anything', async () => {
    const { c } = ctx();
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: '--dangerously-skip-permissions' })).rejects.toMatchObject({ code: 'PROMPT_LOOKS_LIKE_FLAG' });
    expect(openTab).not.toHaveBeenCalled();
  });

  it('links the task to the tab and hands it to startWork (agent column)', async () => {
    const { c, repos } = ctx();
    const r = await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p', task_id: 'k1' });
    expect(repos.tasks.setTab).toHaveBeenCalledWith('k1', 't9');
    expect(repos.tasks.startWork).toHaveBeenCalledWith('k1');
    expect(r.task_id).toBe('k1');
  });

  it('leaves the "already in doing" decision to the repository', async () => {
    const { c, repos } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p', task_id: 'k2' });
    expect(repos.tasks.setTab).toHaveBeenCalledWith('k2', 't9');
    expect(repos.tasks.startWork).toHaveBeenCalledWith('k2');
    expect(repos.tasks.update).not.toHaveBeenCalled();
  });

  it('refuses a task of another project before opening anything', async () => {
    const { c } = ctx();
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p', task_id: 'k9' })).rejects.toEqual(new ControlError('TASK_OTHER_PROJECT', 'A tarefa "Elsewhere" é de outro projeto'));
    expect(openTab).not.toHaveBeenCalled();
  });

  it('needs the tasks:update grant to link a task', async () => {
    const { c } = ctx(['terminals:write']);
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p', task_id: 'k1' })).rejects.toEqual(new ControlError('FORBIDDEN', 'Vincular a tarefa precisa da permissão tasks:update na sua role'));
    expect(openTab).not.toHaveBeenCalled();
  });

  it('refuses an account from another machine, listing the ones that exist there', async () => {
    const { c } = ctx();
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a3', prompt: 'p' })).rejects.toEqual(
      new ControlError('ACCOUNT_OTHER_MACHINE', 'A conta "Claude" está na máquina mac mini, não em MacBook Pro M4. Contas em MacBook Pro M4: pedrogoiania (claude, a1), ChatGPT (chatgpt, a2), Gemini (gemini, a5)'),
    );
    expect(openTab).not.toHaveBeenCalled();
  });

  it('says so when the project machine has no account at all', async () => {
    const { c, repos } = ctx();
    repos.aiAccounts.list.mockResolvedValue(accounts.filter((a) => a.machine_id !== 'm1'));
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a3', prompt: 'p' })).rejects.toMatchObject({ message: expect.stringContaining('Contas em MacBook Pro M4: nenhuma') });
  });

  it('404s an account or project of another user', async () => {
    const { c } = ctx();
    await expect(startAgent(c, { project_id: 'p1', account_id: 'ax', prompt: 'p' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(startAgent(c, { project_id: 'px', account_id: 'a1', prompt: 'p' })).rejects.toMatchObject({ statusCode: 404 });
    expect(openTab).not.toHaveBeenCalled();
  });

  it('refuses when the provider binary was not detected on the machine', async () => {
    const { c } = ctx();
    await expect(startAgent(c, { project_id: 'p2', account_id: 'a4', prompt: 'p' })).rejects.toEqual(
      new ControlError('TOOL_MISSING', 'codex não foi detectado em mac mini (list_machines mostra o que cada máquina tem). Se está instalado: com agente, atualize o termhub-agent (0.2.3 ou mais novo) e deixe-o reconectar; em máquina local/ssh, abra a lista de máquinas no app para refazer a detecção.'),
    );
    expect(openTab).not.toHaveBeenCalled();
  });

  it('refuses an unsupported provider before opening anything', async () => {
    const { c } = ctx();
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a5', prompt: 'p' })).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
    expect(openTab).not.toHaveBeenCalled();
  });

  it('refuses a prompt over the limit before opening anything', async () => {
    const { c } = ctx();
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'x'.repeat(PROMPT_MAX_CHARS + 1) })).rejects.toMatchObject({ code: 'PROMPT_TOO_LONG' });
    expect(openTab).not.toHaveBeenCalled();
  });

  it('keeps the tab and names it when typing the launch line fails', async () => {
    const { c, repos } = ctx();
    sendTextToSession.mockRejectedValue(new Error('A máquina não respondeu'));
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p', task_id: 'k1' })).rejects.toEqual(
      new ControlError('LAUNCH_FAILED', 'A aba t9 foi aberta, mas o agente não foi iniciado: A máquina não respondeu. Veja a tela com read_screen ou feche a aba com close_tab.'),
    );
    expect(repos.tasks.setTab).not.toHaveBeenCalled();
  });

  it('lets openTab errors (tab limit, offline, outdated agent) through untouched', async () => {
    const { c } = ctx();
    openTab.mockRejectedValue(new ControlError('TAB_LIMIT', 'limite'));
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p' })).rejects.toEqual(new ControlError('TAB_LIMIT', 'limite'));
    expect(sendTextToSession).not.toHaveBeenCalled();
  });
});
