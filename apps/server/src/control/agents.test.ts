import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { openTab, sendTextToSession, installTabMcp, tabMcpSupported, cfg, getAccountUsage } = vi.hoisted(() => ({
  getAccountUsage: vi.fn(),
  openTab: vi.fn(),
  sendTextToSession: vi.fn(),
  installTabMcp: vi.fn(),
  tabMcpSupported: vi.fn(),
  cfg: { publicUrl: 'https://app.test', mcpUrl: null as string | null },
}));
vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('../ai/index.js', () => ({ getAccountUsage }));
vi.mock('./terminals.js', () => ({ openTab }));
vi.mock('../terminal/session-ops.js', () => ({ sendTextToSession }));
vi.mock('../terminal/tab-mcp.js', async (orig) => ({ ...(await orig<typeof import('../terminal/tab-mcp.js')>()), installTabMcp, tabMcpSupported }));

import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Project, Tab, Task } from '../db/repositories/types.js';
import { TaskRuleError } from '../db/repositories/tasks.js';
import { Scoped } from '../auth/scope.js';
import { ControlError, type ControlContext } from './context.js';
import { normalizeSetup } from '../setup/schema.js';
import { AUTOMATION_DENIED_TOOLS, branchPushRules, checkPrompt, tabIdOfError, CODEX_TAB_MCP_ENABLED, continueLine, DEFAULT_AUTOMATION_TOOLS, launchLine, withSetup, LESSONS_REMINDER, linkTabTask, PROMPT_MAX_CHARS, ORIGIN_REMINDER, RESUME_PROMPT, resumeLine, startAgent, withLessonsReminder, withOriginReminder } from './agents.js';

/** A Claude agent's first prompt: the lessons reminder, then the origin reminder (TER-851). */
const started = (prompt: string) => withOriginReminder(withLessonsReminder(prompt));

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
const kx = task({ id: 'kx', project_id: 'px', title: 'Not yours' });
const tab = (over: Partial<Tab> & { id: string; project_id: string; machine_id: string }): Tab => ({
  name: over.id, kind: 'terminal', tmux_session: `th-${over.id}`, simulator_udid: null, position: 0,
  state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '', ...over,
});
/** Open tabs: t1 and t-old in p1, a simulator tab there too, t2 in p2, tx of the other user. */
const tabs = [
  tab({ id: 't1', project_id: 'p1', machine_id: 'm1', name: 'claude à mão' }),
  tab({ id: 't-old', project_id: 'p1', machine_id: 'm1' }),
  tab({ id: 'tsim', project_id: 'p1', machine_id: 'm1', kind: 'simulator', tmux_session: null }),
  tab({ id: 't2', project_id: 'p2', machine_id: 'm2' }),
  tab({ id: 'tx', project_id: 'px', machine_id: 'mx' }),
];

function ctx(grants: string[] = ['terminals:write', 'tasks:update'], setup: Record<string, unknown> = {}) {
  const repos = {
    projectSetup: { get: vi.fn(async (projectId: string) => ({ project_id: projectId, version: 2, data: normalizeSetup(setup, 2), updated_at: null })) },
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
      findById: vi.fn(async (id: string) => [k1, kdoing, ksub, klong, k9, kx].find((t) => t.id === id)),
      setTab: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      startWork: vi.fn(async (_id: string): Promise<Task | undefined> => undefined),
    },
    tabs: { setAgentFields: vi.fn(async () => undefined), findById: vi.fn(async (id: string) => tabs.find((t) => t.id === id)) },
    apiTokens: {
      create: vi.fn(async (userId: string, input: { name: string; tabId?: string | null }) => ({ id: 'tt1', user_id: userId, name: input.name, tab_id: input.tabId ?? null })),
      revokeForTab: vi.fn(async () => 1),
    },
  };
  const scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' } as const, ownerId: 'u1', createAs: 'u1' };
  const c: ControlContext = {
    repos: repos as unknown as Repositories, scope, scoped: new Scoped(repos as unknown as Repositories, scope),
    can: async (r, a) => grants.includes(`${r}:${a}`), token: { id: 'tok1', scopes: ['terminals'] },
    log: { info: vi.fn(), warn: vi.fn() } as never,
  };
  return { c, repos, log: c.log as unknown as { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } };
}

beforeEach(() => {
  vi.clearAllMocks();
  openTab.mockResolvedValue({ tab_id: 't9', name: 'pedrogoiania', project_id: 'p1', tmux_session: 'termhub-p1-t9', created: true });
  sendTextToSession.mockResolvedValue(undefined);
  installTabMcp.mockResolvedValue(undefined);
  tabMcpSupported.mockReturnValue(true);
  getAccountUsage.mockResolvedValue({ ok: true, plan: null, windows: [], error: null, hint: null });
  cfg.mcpUrl = null;
});

const NOTE = 'O agente está subindo com o prompt. Chame wait_for_state para saber quando ele terminar ou parar (num único subagente em segundo plano, que termina na primeira parada), e read_last_answer para a resposta dele (read_screen só para o que está na tela). Perguntas e permissões chegam como cards no chat.';
const MCP_URL = 'https://termhub.dev/mcp';
/** The fixed deny list as typed (TER-968): every rule single-quoted. */
const DENY = `--disallowedTools ${AUTOMATION_DENIED_TOOLS.map((t) => `'${t}'`).join(' ')}`;
/** A Bash deny rule as Claude Code reads it (`*` anywhere, `X:*` = `X *`), to show the run's own pushes never match one. */
const denyGlob = (rule: string) => {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return /$^/;
  const spec = m[1]!.endsWith(':*') ? `${m[1]!.slice(0, -2)} *` : m[1]!;
  return new RegExp(`^Bash\\(${spec.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}\\)$`);
};
const MCP_FLAGS = `--mcp-config "$HOME"/'.termhub/tabs/abc/mcp.json' --allowedTools 'mcp__termhub_tab__search_memory' 'mcp__termhub_tab__record_lesson' 'mcp__termhub_tab__get_automation_policy' 'mcp__termhub_tab__report_card' 'mcp__termhub_tab__get_card'`;
/** What the line of an account without a config dir starts with: the CLI's variable cleared in the tab's shell (TER-499). */
const CLEAR_CLAUDE = 'command -v unset >/dev/null 2>&1 && unset CLAUDE_CONFIG_DIR; ';
const CLEAR_CODEX = 'command -v unset >/dev/null 2>&1 && unset CODEX_HOME; ';

describe('launchLine', () => {
  it('starts claude with the prompt as its argument, under CLAUDE_CONFIG_DIR when the account has one', () => {
    expect(launchLine('claude', '/Users/p/.claude-work', 'write a spec')).toBe("CLAUDE_CONFIG_DIR='/Users/p/.claude-work' claude 'write a spec'");
  });

  // TER-499: no config dir is the machine's default login, so a variable the tab's shell inherited must
  // not pick another one. `unset`, not `env -u`: the person's alias or function for the binary still runs.
  it("clears the CLI's config variable for an account without a config dir, and only for it", () => {
    expect(launchLine('claude', null, 'write a spec')).toBe(`${CLEAR_CLAUDE}claude 'write a spec'`);
    expect(launchLine('chatgpt', null, 'fix it')).toBe(`${CLEAR_CODEX}codex --no-alt-screen 'fix it'`);
    expect(launchLine('claude', '~/.claude-work', 'x')).not.toContain('unset');
    expect(launchLine('chatgpt', '/Users/p/.codex-work', 'x', { tabId: 'abc', url: MCP_URL })).not.toContain('unset');
  });

  it('clears the variable before the token assignment of a codex tab with the MCP', () => {
    expect(launchLine('chatgpt', null, 'fix it', { tabId: 'abc', url: MCP_URL })).toBe(
      `${CLEAR_CODEX}TERMHUB_MCP_TOKEN="$(cat "$HOME"/'.termhub/tabs/abc/token')" codex --no-alt-screen -c 'mcp_servers.termhub_tab.url="https://termhub.dev/mcp"' -c 'mcp_servers.termhub_tab.bearer_token_env_var="TERMHUB_MCP_TOKEN"' 'fix it'`,
    );
  });

  it('starts codex under CODEX_HOME, out of the alternate screen', () => {
    expect(launchLine('chatgpt', '/Users/p/.codex-work', 'fix it')).toBe("CODEX_HOME='/Users/p/.codex-work' codex --no-alt-screen 'fix it'");
  });

  // TER-465: in the alternate screen Codex's messages never reach the pane history, so the mouse wheel has
  // nothing to scroll; Claude turns mouse tracking on and scrolls by itself, so its line stays as it was.
  it('passes --no-alt-screen to codex only, with or without the tab MCP', () => {
    expect(launchLine('chatgpt', null, 'x', { tabId: 'abc', url: MCP_URL })).toContain(' codex --no-alt-screen -c ');
    for (const mcp of [null, { tabId: 'abc', url: MCP_URL }]) expect(launchLine('claude', null, 'x', mcp)).not.toContain('--no-alt-screen');
    expect(resumeLine(null, '123e4567-e89b-12d3-a456-426614174000', 'x')).not.toContain('--no-alt-screen');
  });

  it('keeps quotes, spaces, newlines and ; inert in the prompt and the config dir', () => {
    const line = launchLine('claude', "/tmp/it's here; rm -rf /", "say 'hi'; echo $HOME\nls");
    expect(line).toBe("CLAUDE_CONFIG_DIR='/tmp/it'\\''s here; rm -rf /' claude 'say '\\''hi'\\''; echo $HOME\nls'");
  });

  it("leaves a config dir's ~ for the machine's shell to expand, the rest still quoted", () => {
    expect(launchLine('claude', '~/.claude-work', 'write a spec')).toBe("CLAUDE_CONFIG_DIR=\"$HOME\"/'.claude-work' claude 'write a spec'");
    expect(launchLine('chatgpt', '~', 'fix it')).toBe('CODEX_HOME="$HOME" codex --no-alt-screen \'fix it\'');
    // Only the leading ~/ is outside the quotes: a tilde further in, and anything else, stays literal.
    expect(launchLine('claude', "~/it's $HOME; rm -rf /", 'x')).toBe("CLAUDE_CONFIG_DIR=\"$HOME\"/'it'\\''s $HOME; rm -rf /' claude 'x'");
    expect(launchLine('claude', '/tmp/~/x', 'x')).toBe("CLAUDE_CONFIG_DIR='/tmp/~/x' claude 'x'");
  });

  it('points claude at the tab config and pre-allows only the memory tools, `--` before the prompt', () => {
    expect(launchLine('claude', null, 'write a spec', { tabId: 'abc', url: MCP_URL })).toBe(`${CLEAR_CLAUDE}claude ${MCP_FLAGS} -- 'write a spec'`);
    expect(launchLine('claude', '~/.claude-work', 'x', { tabId: 'abc', url: MCP_URL })).toBe(`CLAUDE_CONFIG_DIR="$HOME"/'.claude-work' claude ${MCP_FLAGS} -- 'x'`);
  });

  it('gives codex the server by -c overrides and the token through an env var read from the tab file', () => {
    expect(launchLine('chatgpt', '/Users/p/.codex-work', 'fix it', { tabId: 'abc', url: MCP_URL })).toBe(
      `TERMHUB_MCP_TOKEN="$(cat "$HOME"/'.termhub/tabs/abc/token')" CODEX_HOME='/Users/p/.codex-work' codex --no-alt-screen -c 'mcp_servers.termhub_tab.url="https://termhub.dev/mcp"' -c 'mcp_servers.termhub_tab.bearer_token_env_var="TERMHUB_MCP_TOKEN"' 'fix it'`,
    );
  });

  it('never carries a token, and keeps a prompt starting with a quote quoted', () => {
    for (const provider of ['claude', 'chatgpt'] as const) {
      const line = launchLine(provider, null, "'; rm -rf ~ #", { tabId: 'abc', url: MCP_URL });
      expect(line).not.toContain('thb_pat_');
      expect(line.endsWith(`''\\''; rm -rf ~ #'`)).toBe(true);
    }
  });

  it('refuses a tab id or url that could break out of the line', () => {
    expect(() => launchLine('claude', null, 'x', { tabId: '../x', url: MCP_URL })).toThrow(new ControlError('INVALID_TAB', 'Id de aba inválido'));
    expect(() => launchLine('chatgpt', null, 'x', { tabId: 'ABC', url: MCP_URL })).toThrow(ControlError);
    for (const url of ['ftp://x', 'https://x/"; id', "https://x/'", 'https://x y', 'https://x\\y', 'https://x/\x1b[31m', 'https://x\x00', 'https://x\x7f', 'https://x\x01y']) {
      expect(() => launchLine('chatgpt', null, 'x', { tabId: 'abc', url })).toThrow(ControlError);
    }
  });

  it('is exactly the plain line without mcp', () => {
    expect(launchLine('claude', '/c', 'x', null)).toBe("CLAUDE_CONFIG_DIR='/c' claude 'x'");
    expect(launchLine('chatgpt', '/c', 'x', undefined)).toBe("CODEX_HOME='/c' codex --no-alt-screen 'x'");
  });

  it('refuses gemini and antigravity for now', () => {
    expect(() => launchLine('gemini', null, 'x')).toThrow(new ControlError('PROVIDER_UNSUPPORTED', 'Iniciar um agente gemini ainda não é suportado; por enquanto só claude e chatgpt (Codex)'));
    expect(() => launchLine('antigravity', null, 'x')).toThrow(ControlError);
  });
});

describe('launchLine with a model (TER-589)', () => {
  it('puts the quoted model right after the binary (after --no-alt-screen for codex)', () => {
    expect(launchLine('claude', null, 'x', null, 'opus')).toBe(`${CLEAR_CLAUDE}claude --model 'opus' 'x'`);
    expect(launchLine('claude', '/c', 'x', { tabId: 'abc', url: MCP_URL }, 'sonnet[1m]')).toBe(`CLAUDE_CONFIG_DIR='/c' claude --model 'sonnet[1m]' ${MCP_FLAGS} -- 'x'`);
    expect(launchLine('chatgpt', '/c', 'x', null, 'gpt-5-codex')).toBe("CODEX_HOME='/c' codex --no-alt-screen -m 'gpt-5-codex' 'x'");
    expect(launchLine('chatgpt', null, 'x', { tabId: 'abc', url: MCP_URL }, 'gpt-5')).toContain(" codex --no-alt-screen -m 'gpt-5' -c ");
  });
  it('is exactly the line of today without a model', () => {
    for (const model of [undefined, null]) expect(launchLine('claude', '/c', 'x', null, model)).toBe("CLAUDE_CONFIG_DIR='/c' claude 'x'");
  });
  it('refuses a model the shell could read, before anything is typed', () => {
    for (const bad of ['opus; id', '$(id)', "o'pus", '-p', ''])
      expect(() => launchLine('claude', null, 'x', null, bad), bad).toThrow(new ControlError('INVALID_MODEL', 'Modelo inválido: use um apelido (opus, sonnet, haiku) ou o id do modelo'));
  });
});

describe('resume and continue lines of an automatic tab (preflight F-12)', () => {
  const SID = '123e4567-e89b-12d3-a456-426614174000';
  const permission = { mode: 'acceptEdits' as const, allowedTools: ['Bash(git status:*)', 'Bash(npm test:*)'], branch: null };

  it('resumeLine keeps acceptEdits and the allow list, merged with the tab MCP\'s tools, ended by --', () => {
    expect(resumeLine(null, SID, 'x', null, null, permission)).toBe(`${CLEAR_CLAUDE}claude --permission-mode acceptEdits --allowedTools 'Bash(git status:*)' 'Bash(npm test:*)' ${DENY} --resume ${SID} -- 'x'`);
    expect(resumeLine('/c', SID, 'x', 'abc', 'opus', permission)).toBe(`CLAUDE_CONFIG_DIR='/c' claude --model 'opus' --permission-mode acceptEdits ${MCP_FLAGS} 'Bash(git status:*)' 'Bash(npm test:*)' ${DENY} --resume ${SID} -- 'x'`);
    expect(() => resumeLine(null, SID, 'x', null, null, { mode: 'acceptEdits', allowedTools: ['--dangerously-skip-permissions'], branch: null })).toThrow(ControlError);
    expect(() => resumeLine(null, SID, 'x', null, null, { mode: 'bypassPermissions' as 'acceptEdits', allowedTools: [], branch: null })).toThrow(ControlError);
  });

  it('continueLine of an automatic Claude tab carries the profile, the MCP and a first message; Codex is unchanged', () => {
    expect(continueLine('claude', null, { permission, prompt: '[termhub automático] x', mcpTabId: null })).toBe(
      `${CLEAR_CLAUDE}claude --permission-mode acceptEdits --allowedTools 'Bash(git status:*)' 'Bash(npm test:*)' ${DENY} --continue -- '[termhub automático] x'`,
    );
    expect(continueLine('claude', null, { permission, prompt: 'x', mcpTabId: 'abc' })).toContain(`${MCP_FLAGS} 'Bash(git status:*)' 'Bash(npm test:*)' ${DENY} --continue -- 'x'`);
    expect(continueLine('chatgpt', '/home/u/.codex_b', { permission, prompt: 'x', mcpTabId: null })).toBe(`CODEX_HOME='/home/u/.codex_b' codex --no-alt-screen resume --last`);
  });
});

describe('continueLine (TER-643)', () => {
  it('continues Claude\'s last session, or Codex\'s, under the tab\'s account', () => {
    expect(continueLine('claude', '~/.claude_b')).toBe(`CLAUDE_CONFIG_DIR="$HOME"/'.claude_b' claude --continue`);
    expect(continueLine('claude', null)).toBe(`${CLEAR_CLAUDE}claude --continue`);
    expect(continueLine('chatgpt', '/home/u/.codex_b')).toBe(`CODEX_HOME='/home/u/.codex_b' codex --no-alt-screen resume --last`);
  });
});

describe('resumeLine', () => {
  const SID = '6d127d73-4bd0-42d6-b4a6-d96899507e62';
  it('resumes the session under the account, prompt quoted', () => {
    expect(resumeLine('~/.claude_b', SID, RESUME_PROMPT)).toBe(`CLAUDE_CONFIG_DIR="$HOME"/'.claude_b' claude --resume ${SID} 'A conta anterior atingiu o limite de uso. Continue a tarefa de onde parou.'`);
  });
  it('clears an inherited config dir for the default account', () => {
    expect(resumeLine(null, SID, 'x')).toBe(`${CLEAR_CLAUDE}claude --resume ${SID} 'x'`);
    expect(resumeLine(null, SID, 'x', 'abc')).toBe(`${CLEAR_CLAUDE}claude ${MCP_FLAGS} --resume ${SID} -- 'x'`);
    expect(resumeLine('~/.claude_b', SID, 'x')).not.toContain('unset');
  });
  it('refuses a session id that is not a uuid', () => {
    expect(() => resumeLine(null, "x'; rm -rf ~", 'x')).toThrow(ControlError);
  });

  it('does not add the lessons reminder: a resumed session already had it', () => {
    expect(resumeLine(null, SID, RESUME_PROMPT)).not.toContain(LESSONS_REMINDER);
  });

  it('passes the model before --resume, and nothing without one (TER-589)', () => {
    expect(resumeLine('/c', SID, 'x', null, 'opus')).toBe(`CLAUDE_CONFIG_DIR='/c' claude --model 'opus' --resume ${SID} 'x'`);
    expect(resumeLine(null, SID, 'x', 'abc', 'opus')).toBe(`${CLEAR_CLAUDE}claude --model 'opus' ${MCP_FLAGS} --resume ${SID} -- 'x'`);
    expect(resumeLine('/c', SID, 'x', null, null)).toBe(`CLAUDE_CONFIG_DIR='/c' claude --resume ${SID} 'x'`);
    expect(() => resumeLine('/c', SID, 'x', null, 'a b')).toThrow(ControlError);
  });

  it('keeps the tab config when the tab has a live tab token, `--` before the prompt', () => {
    expect(resumeLine('~/.claude_b', SID, 'x', 'abc')).toBe(`CLAUDE_CONFIG_DIR="$HOME"/'.claude_b' claude ${MCP_FLAGS} --resume ${SID} -- 'x'`);
    expect(resumeLine(null, SID, 'x', null)).toBe(`${CLEAR_CLAUDE}claude --resume ${SID} 'x'`);
    expect(() => resumeLine(null, SID, 'x', '../x')).toThrow(ControlError);
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

describe('withOriginReminder (TER-851)', () => {
  it('appends the origin reminder after a blank line', () => {
    expect(withOriginReminder('write a spec')).toBe(`write a spec\n\n${ORIGIN_REMINDER}`);
  });

  it('is not added to a resumed session', () => {
    expect(resumeLine(null, '6d127d73-4bd0-42d6-b4a6-d96899507e62', RESUME_PROMPT)).not.toContain(ORIGIN_REMINDER);
  });
});

describe('withLessonsReminder', () => {
  it('appends the reminder after a blank line', () => {
    expect(withLessonsReminder('write a spec')).toBe(`write a spec\n\n${LESSONS_REMINDER}`);
  });
});

describe('startAgent', () => {
  it('opens a tab named after the account, types the launch line and returns where to watch it', async () => {
    const { c } = ctx();
    const r = await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'write a spec' });
    expect(openTab).toHaveBeenCalledWith(c, { project_id: 'p1', machine_id: 'm1', name: 'claude · pedrogoiania' });
    expect(sendTextToSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'termhub-p1-t9', launchLine('claude', '/Users/p/.claude-work', started('write a spec')), true);
    expect(r).toEqual({
      tab_id: 't9', tab_name: 'pedrogoiania', project_id: 'p1', tmux_session: 'termhub-p1-t9', tab_url: 'https://app.test/projects/p1', command: 'claude', task_id: null, previous_tab_id: null,
      account: { id: 'a1', label: 'pedrogoiania' }, model: null,
      note: `${NOTE} A aba abriu sem o MCP de memória: MCP_URL não configurado.`,
    });
  });

  describe('with MCP_URL set', () => {
    beforeEach(() => {
      cfg.mcpUrl = MCP_URL;
      openTab.mockResolvedValue({ tab_id: 'abc', name: 'pedrogoiania', project_id: 'p1', tmux_session: 'termhub-p1-abc', created: true });
    });

    it('mints a tab token, installs the config with it and types the line that points claude at it', async () => {
      const { c, repos, log } = ctx();
      const r = await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'write a spec' });
      expect(repos.apiTokens.create).toHaveBeenCalledWith('u1', expect.objectContaining({ tabId: 'abc', gated: false, scopes: ['read', 'memory'] }), expect.any(String));
      await expect(repos.apiTokens.create.mock.results[0].value).resolves.toMatchObject({ tab_id: 'abc' });
      expect(installTabMcp).toHaveBeenCalledTimes(1);
      const [m, tabId, file, body] = installTabMcp.mock.calls[0];
      expect([m.id, tabId, file]).toEqual(['m1', 'abc', 'mcp.json']);
      const parsed = JSON.parse(body);
      expect(Object.keys(parsed.mcpServers)).toEqual(['termhub_tab']);
      expect(parsed.mcpServers.termhub_tab.url).toBe(MCP_URL);
      const token = parsed.mcpServers.termhub_tab.headers.Authorization.replace('Bearer ', '');
      expect(token).toMatch(/^thb_pat_/);
      const line = sendTextToSession.mock.calls[0][2] as string;
      expect(line).toBe(launchLine('claude', '/Users/p/.claude-work', started('write a spec'), { tabId: 'abc', url: MCP_URL }));
      expect(line).not.toContain(token);
      expect(r.note).toBe(`${NOTE} A aba tem o MCP termhub_tab (search_memory) para consultar a memória do projeto.`);
      expect(repos.apiTokens.revokeForTab).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith({ tabId: 'abc', machineId: 'm1', installed: true, reason: null }, expect.any(String));
      expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, r])).not.toContain(token);
    });

    it('mints a tab token for codex, installs it as the bare token file and types the line with the -c overrides (TER-356)', async () => {
      expect(CODEX_TAB_MCP_ENABLED).toBe(true);
      const { c, repos, log } = ctx();
      const r = await startAgent(c, { project_id: 'p1', account_id: 'a2', prompt: 'fix it' });
      expect(repos.apiTokens.create).toHaveBeenCalledWith('u1', expect.objectContaining({ tabId: 'abc', gated: false, scopes: ['read', 'memory'] }), expect.any(String));
      expect(installTabMcp).toHaveBeenCalledTimes(1);
      const [m, tabId, file, body] = installTabMcp.mock.calls[0];
      expect([m.id, tabId, file]).toEqual(['m1', 'abc', 'token']);
      expect(body).toMatch(/^thb_pat_/);
      const line = sendTextToSession.mock.calls[0][2] as string;
      expect(line).toBe(launchLine('chatgpt', null, withLessonsReminder('fix it'), { tabId: 'abc', url: MCP_URL }));
      expect(line).toContain('mcp_servers.termhub_tab.bearer_token_env_var');
      expect(line).not.toContain(body);
      expect(r.note).toBe(`${NOTE} A aba tem o MCP termhub_tab (search_memory) para consultar a memória do projeto.`);
      expect(log.info).toHaveBeenCalledWith({ tabId: 'abc', machineId: 'm1', installed: true, reason: null }, expect.any(String));
      expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, r])).not.toContain(body);
    });

    it('revokes the token and types the plain line when the install fails', async () => {
      const { c, repos, log } = ctx();
      installTabMcp.mockRejectedValue(new Error('ssh down'));
      const r = await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'write a spec' });
      expect(repos.apiTokens.revokeForTab).toHaveBeenCalledWith('abc');
      expect(sendTextToSession).toHaveBeenCalledWith(expect.anything(), 'termhub-p1-abc', launchLine('claude', '/Users/p/.claude-work', started('write a spec')), true);
      expect(r.note).toBe(`${NOTE} A aba abriu sem o MCP de memória: não foi possível gravar a configuração na máquina.`);
      expect(log.info).toHaveBeenCalledWith({ tabId: 'abc', machineId: 'm1', installed: false, reason: 'install_failed' }, expect.any(String));
    });

    it('still starts the agent when minting fails', async () => {
      const { c, repos } = ctx();
      repos.apiTokens.create.mockRejectedValue(new Error('db down'));
      const r = await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p' });
      expect(installTabMcp).not.toHaveBeenCalled();
      expect(repos.apiTokens.revokeForTab).toHaveBeenCalledWith('abc');
      expect(sendTextToSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), launchLine('claude', '/Users/p/.claude-work', started('p')), true);
      expect(r.note).toContain('A aba abriu sem o MCP de memória');
    });

    it('still starts the agent when even the revoke fails', async () => {
      const { c, repos } = ctx();
      installTabMcp.mockRejectedValue(new Error('ssh down'));
      repos.apiTokens.revokeForTab.mockRejectedValue(new Error('db down'));
      await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p' })).resolves.toMatchObject({ tab_id: 'abc' });
      expect(sendTextToSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), launchLine('claude', '/Users/p/.claude-work', started('p')), true);
    });

    it('mints nothing on an agent older than 0.10.0', async () => {
      const { c, repos } = ctx();
      tabMcpSupported.mockReturnValue(false);
      const r = await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p' });
      expect(repos.apiTokens.create).not.toHaveBeenCalled();
      expect(installTabMcp).not.toHaveBeenCalled();
      expect(r.note).toBe(`${NOTE} A aba abriu sem o MCP de memória: o termhub-agent desta máquina é anterior à 0.10.0.`);
    });
  });

  it('mints no token when MCP_URL is not configured', async () => {
    const { c, repos, log } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p' });
    expect(repos.apiTokens.create).not.toHaveBeenCalled();
    expect(installTabMcp).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ tabId: 't9', machineId: 'm1', installed: false, reason: 'no_mcp_url' }, expect.any(String));
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
    expect(sendTextToSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'termhub-p1-t9', launchLine('chatgpt', null, withLessonsReminder('fix it')), true);
    expect(openTab).toHaveBeenCalledWith(c, { project_id: 'p1', machine_id: 'm1', name: 'codex · ChatGPT' });
  });

  it('types the prompt as checked (CRLF folded)', async () => {
    const { c } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a2', prompt: 'one\r\ntwo' });
    expect(sendTextToSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), launchLine('chatgpt', null, withLessonsReminder('one\ntwo')), true);
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

  it('types the launch line with the lessons reminder appended to the prompt', async () => {
    const { c } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'write a spec' });
    expect(sendTextToSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.stringContaining(LESSONS_REMINDER), true);
  });

  it('refuses a Claude prompt that fits with the lessons reminder but not with the origin reminder, before opening anything', async () => {
    const { c } = ctx();
    const prompt = 'x'.repeat(PROMPT_MAX_CHARS - withLessonsReminder('').length);
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt })).rejects.toMatchObject({ code: 'PROMPT_TOO_LONG' });
    expect(openTab).not.toHaveBeenCalled();
  });

  it('refuses a prompt that fits alone but not with the reminder, with the existing too-long error', async () => {
    const { c } = ctx();
    // fits PROMPT_MAX_CHARS by itself, but not once the reminder is appended
    const prompt = 'x'.repeat(PROMPT_MAX_CHARS);
    const combinedLength = withLessonsReminder(prompt).length;
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt })).rejects.toEqual(
      new ControlError('PROMPT_TOO_LONG', `Prompt longo demais: ${combinedLength} caracteres, máximo ${PROMPT_MAX_CHARS}`),
    );
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

// TER-499: a tab that is already open — an agent started by hand — linked to a card the way start_agent
// links the tab it opens, so the card shows it and Progresso lists the agent.
describe('startAgent with the project setup (TER-589)', () => {
  const usage = (peak: number | null) => (peak === null ? { ok: false, plan: null, windows: [], error: 'x', hint: null } : { ok: true, plan: null, windows: [{ key: '5h', label: '5h', utilization: peak, resets_at: null }], error: null, hint: null });
  // m1 has a1 (claude, /Users/p/.claude-work), a2 (codex); add a second claude account there for the order
  const a6 = account({ id: 'a6', label: 'segunda', machine_id: 'm1', config_dir: '~/.claude-2' });
  beforeEach(() => accounts.push(a6));
  afterEach(() => accounts.splice(accounts.indexOf(a6), 1));
  const lineOf = () => sendTextToSession.mock.calls[0][2] as string;

  it('without account_id, starts on the first listed account of the machine with room', async () => {
    const { c } = ctx(undefined, { ai: { accounts: ['a6', 'a1'] } });
    const r = await startAgent(c, { project_id: 'p1', prompt: 'p' });
    expect(lineOf()).toBe(launchLine('claude', '~/.claude-2', started('p')));
    expect(r.account).toEqual({ id: 'a6', label: 'segunda' });
  });

  it('skips a listed account at its limit for the next one in the order', async () => {
    getAccountUsage.mockImplementation(async (a: { id: string }) => usage(a.id === 'a6' ? 95 : 40));
    const { c } = ctx(undefined, { ai: { accounts: ['a6', 'a1'] } });
    expect((await startAgent(c, { project_id: 'p1', prompt: 'p' })).account.id).toBe('a1');
  });

  it('takes the first listed account, saying so, when all of them are at their limit', async () => {
    getAccountUsage.mockResolvedValue(usage(99));
    const { c } = ctx(undefined, { ai: { accounts: ['a6', 'a1'] } });
    const r = await startAgent(c, { project_id: 'p1', prompt: 'p' });
    expect(r.account.id).toBe('a6');
    expect(r.note).toContain('Todas as contas do projeto em MacBook Pro M4 estão no limite de uso; o agente começou em segunda.');
  });

  it('unknown usage counts as room', async () => {
    getAccountUsage.mockResolvedValue(usage(null));
    const { c } = ctx(undefined, { ai: { accounts: ['a6', 'a1'] } });
    expect((await startAgent(c, { project_id: 'p1', prompt: 'p' })).account.id).toBe('a6');
  });

  it('an explicit account_id still wins over the project list', async () => {
    const { c } = ctx(undefined, { ai: { accounts: ['a6'] } });
    expect((await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p' })).account.id).toBe('a1');
  });

  it('without account_id and without configuration, asks for it, listing the accounts of the machine', async () => {
    const { c } = ctx();
    await expect(startAgent(c, { project_id: 'p1', prompt: 'p' })).rejects.toEqual(
      new ControlError('ACCOUNT_REQUIRED', 'Escolha a conta (account_id): o projeto não tem contas configuradas em MacBook Pro M4. Contas lá: pedrogoiania (claude, a1), ChatGPT (chatgpt, a2), Gemini (gemini, a5), segunda (claude, a6)'),
    );
    expect(openTab).not.toHaveBeenCalled();
  });

  it('passes the project model for the provider, and an explicit model over it', async () => {
    const { c } = ctx(undefined, { ai: { accounts: ['a1'], models: { claude: 'opus', chatgpt: 'gpt-5-codex' } } });
    const r = await startAgent(c, { project_id: 'p1', prompt: 'p' });
    expect(lineOf()).toBe(launchLine('claude', '/Users/p/.claude-work', started('p'), null, 'opus'));
    expect(r.model).toBe('opus');
    expect(r.warning).toBeUndefined();
    sendTextToSession.mockClear();
    const codex = await startAgent(c, { project_id: 'p1', account_id: 'a2', prompt: 'p' });
    expect(lineOf()).toContain(" -m 'gpt-5-codex' ");
    expect(codex.model).toBe('gpt-5-codex');
    sendTextToSession.mockClear();
    expect((await startAgent(c, { project_id: 'p1', prompt: 'p', model: 'haiku' })).model).toBe('haiku');
  });

  it('warns when the model is a full id an older CLI may not know', async () => {
    const { c } = ctx(undefined, { ai: { accounts: ['a1'], models: { claude: 'claude-opus-5-5' } } });
    const r = await startAgent(c, { project_id: 'p1', prompt: 'p' });
    expect(r.warning).toBe('O modelo claude-opus-5-5 não é um apelido (opus, sonnet, haiku): um CLI mais antigo nesta máquina pode não reconhecê-lo. Se a aba mostrar erro de modelo, use um apelido no setup do projeto.');
  });

  it('refuses a bad model before opening anything', async () => {
    const { c } = ctx();
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'p', model: 'x;id' })).rejects.toBeInstanceOf(ControlError);
    expect(openTab).not.toHaveBeenCalled();
  });

  it('with several machines and no machine_id, uses the machine of the first listed account with room', async () => {
    links.push({ id: 'l9', position: 1, created_at: '', project_id: 'p1', machine_id: 'm2', cwd: '/src/p1' });
    try {
      getAccountUsage.mockImplementation(async (a: { id: string }) => usage(a.id === 'a3' ? 95 : 10));
      const { c } = ctx(undefined, { ai: { accounts: ['a3', 'a6'] } });
      await startAgent(c, { project_id: 'p1', prompt: 'p' });
      expect(openTab).toHaveBeenCalledWith(c, expect.objectContaining({ machine_id: 'm1' }));
      const { c: plain } = ctx();
      await expect(startAgent(plain, { project_id: 'p1', prompt: 'p' })).rejects.toMatchObject({ code: 'MACHINE_REQUIRED' });
    } finally {
      links.pop();
    }
  });
});

describe('linkTabTask', () => {
  it('points the card at the tab and starts work on it, answering the card as it ended up', async () => {
    const { c, repos } = ctx();
    repos.tasks.startWork.mockResolvedValue({ ...k1, ref: 'P1-7', status: 'doing', column_id: 'c-doing', tab_id: 't1' });
    const r = await linkTabTask(c, { tab_id: 't1', task_id: 'k1' });
    expect(repos.tasks.setTab).toHaveBeenCalledWith('k1', 't1');
    expect(repos.tasks.startWork).toHaveBeenCalledWith('k1');
    expect(repos.tasks.setTab.mock.invocationCallOrder[0]).toBeLessThan(repos.tasks.startWork.mock.invocationCallOrder[0]);
    expect(r).toMatchObject({
      task: { id: 'k1', ref: 'P1-7', status: 'doing', column_id: 'c-doing', tab_id: 't1', url: 'https://app.test/project/P1-7' },
      tab_id: 't1', tab_name: 'claude à mão', previous_tab_id: null, board_url: 'https://app.test/projects/p1/tasks',
    });
  });

  it('re-points a card linked to another tab and names the tab it left', async () => {
    const { c, repos } = ctx();
    const r = await linkTabTask(c, { tab_id: 't1', task_id: 's1' });
    expect(repos.tasks.setTab).toHaveBeenCalledWith('s1', 't1');
    expect(r.previous_tab_id).toBe('t-old');
  });

  it('linking the tab a card already has is not a change of tab', async () => {
    const { c, repos } = ctx();
    const r = await linkTabTask(c, { tab_id: 't-old', task_id: 's1' });
    expect(r.previous_tab_id).toBeNull();
    expect(repos.tasks.startWork).toHaveBeenCalledWith('s1');
  });

  it('refuses a card of another project, writing nothing', async () => {
    const { c, repos } = ctx();
    await expect(linkTabTask(c, { tab_id: 't1', task_id: 'k9' })).rejects.toEqual(new ControlError('TASK_OTHER_PROJECT', 'A tarefa "Elsewhere" é de outro projeto, não o da aba'));
    expect(repos.tasks.setTab).not.toHaveBeenCalled();
  });

  it('refuses a tab that is not a terminal', async () => {
    const { c, repos } = ctx();
    await expect(linkTabTask(c, { tab_id: 'tsim', task_id: 'k1' })).rejects.toEqual(new ControlError('TAB_NOT_TERMINAL', 'Só abas de terminal podem ser ligadas a uma tarefa'));
    expect(repos.tasks.setTab).not.toHaveBeenCalled();
  });

  it('needs the tasks:update grant', async () => {
    const { c, repos } = ctx(['terminals:write']);
    await expect(linkTabTask(c, { tab_id: 't1', task_id: 'k1' })).rejects.toEqual(new ControlError('FORBIDDEN', 'Vincular a tarefa precisa da permissão tasks:update na sua role'));
    expect(repos.tasks.setTab).not.toHaveBeenCalled();
  });

  it('says a broken board rule as the board would, not as a server error', async () => {
    const { c, repos } = ctx();
    repos.tasks.startWork.mockRejectedValue(new TaskRuleError('COLUMN_NOT_FOUND'));
    await expect(linkTabTask(c, { tab_id: 't1', task_id: 'k1' })).rejects.toEqual(new ControlError('COLUMN_NOT_FOUND', new TaskRuleError('COLUMN_NOT_FOUND').message));
  });

  it("404s another user's tab or card, the same way as one that does not exist", async () => {
    const { c, repos } = ctx();
    await expect(linkTabTask(c, { tab_id: 'tx', task_id: 'k1' })).rejects.toMatchObject({ statusCode: 404, message: 'Tab não encontrada' });
    await expect(linkTabTask(c, { tab_id: 'nope', task_id: 'k1' })).rejects.toMatchObject({ statusCode: 404, message: 'Tab não encontrada' });
    await expect(linkTabTask(c, { tab_id: 't1', task_id: 'kx' })).rejects.toMatchObject({ statusCode: 404, message: 'Tarefa não encontrada' });
    expect(repos.tasks.setTab).not.toHaveBeenCalled();
  });
});

describe('automation launch: permission flags, cwd and setup command (TER-870)', () => {
  const PERMISSION = { mode: 'acceptEdits' as const, allowedTools: ['Bash(git status:*)', 'Bash(npm test:*)'], branch: null };
  const TOOLS = `'Bash(git status:*)' 'Bash(npm test:*)'`;
  const TAB_TOOLS = `'mcp__termhub_tab__search_memory' 'mcp__termhub_tab__record_lesson' 'mcp__termhub_tab__get_automation_policy' 'mcp__termhub_tab__report_card' 'mcp__termhub_tab__get_card'`;
  const WORKTREE = '/home/u/.termhub/worktrees/P1-7';

  it('the default allow list is the closed F-6 list: no push (only the run\'s own branch, TER-968), no generic npm run', () => {
    expect(DEFAULT_AUTOMATION_TOOLS).toEqual([
      'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git fetch:*)', 'Bash(git merge:*)', 'Bash(git log:*)',
      'Bash(gh pr create:*)', 'Bash(gh pr view:*)', 'Bash(gh pr checks:*)',
      'Bash(npm test:*)', 'Bash(npm ci)', 'Bash(npm install)', 'Bash(npx prisma generate)',
      'Bash(node scripts/automation/rename-migrations.mjs:*)', 'Bash(npm run build:*)', 'Bash(npm run typecheck:*)',
    ]);
    for (const t of DEFAULT_AUTOMATION_TOOLS) {
      expect(t).not.toMatch(/push/);
      expect(t).not.toBe('Bash(npm run:*)');
      expect(t).not.toMatch(/gh pr merge|--force/);
    }
  });

  it('without the MCP: acceptEdits, one quoted allow list and `--` before the prompt', () => {
    expect(launchLine('claude', '/c', 'do it', null, null, PERMISSION)).toBe(`CLAUDE_CONFIG_DIR='/c' claude --permission-mode acceptEdits --allowedTools ${TOOLS} ${DENY} -- 'do it'`);
    expect(launchLine('claude', null, 'do it', null, 'opus', PERMISSION)).toBe(`${CLEAR_CLAUDE}claude --model 'opus' --permission-mode acceptEdits --allowedTools ${TOOLS} ${DENY} -- 'do it'`);
    // an empty list still carries the deny list and ends the options before the prompt
    expect(launchLine('claude', '/c', 'x', null, null, { mode: 'acceptEdits', allowedTools: [], branch: null })).toBe(`CLAUDE_CONFIG_DIR='/c' claude --permission-mode acceptEdits ${DENY} -- 'x'`);
  });

  it('with the MCP: the tab tools and the automation tools share a single --allowedTools', () => {
    const line = launchLine('claude', '/c', 'do it', { tabId: 'abc', url: MCP_URL }, null, PERMISSION);
    expect(line).toBe(`CLAUDE_CONFIG_DIR='/c' claude --permission-mode acceptEdits --mcp-config "$HOME"/'.termhub/tabs/abc/mcp.json' --allowedTools ${TAB_TOOLS} ${TOOLS} ${DENY} -- 'do it'`);
    expect(line.split('--allowedTools')).toHaveLength(2);
    expect(line.split('--disallowedTools')).toHaveLength(2);
  });

  it('never a bypass flag, with every default tool quoted', () => {
    for (const mcp of [null, { tabId: 'abc', url: MCP_URL }]) {
      const line = launchLine('claude', null, 'x', mcp, null, { mode: 'acceptEdits', allowedTools: DEFAULT_AUTOMATION_TOOLS, branch: 'TER-1-card' });
      expect(line).not.toMatch(/dangerously|bypassPermissions|skip-permissions/);
      for (const t of DEFAULT_AUTOMATION_TOOLS) expect(line).toContain(` '${t}'`);
      expect(line.endsWith(` -- 'x'`)).toBe(true);
    }
  });

  it('the deny list (TER-968, R5) covers merging, gh api, secrets, publishing, stores, containers, the database, the keychain, rm -rf and secret files', () => {
    for (const rule of [
      'Bash(gh pr merge:*)', 'Bash(gh api:*)', 'Bash(gh secret:*)', 'Bash(npm publish:*)', 'Bash(npm run release*)', 'Bash(eas:*)', 'Bash(fastlane:*)',
      'Bash(docker:*)', 'Bash(psql:*)', 'Bash(security:*)', 'Bash(rm -rf:*)', 'Bash(git push --force*)', 'Bash(git push * +*)',
      'Read(//**/.env*)', 'Edit(//**/.env*)', 'Read(~/.ssh/**)', 'Edit(~/.ssh/**)', 'Read(~/.config/gh/**)', 'Edit(~/.config/gh/**)',
      'Read(~/.claude*/.credentials.json)', 'Edit(~/.claude*/.credentials.json)', 'Read(~/.aws/**)', 'Edit(~/.aws/**)',
    ])
      expect(AUTOMATION_DENIED_TOOLS).toContain(rule);
    // an allow rule cannot carve an exception out of a deny rule in Claude Code: no generic push deny, or the run's own push would be blocked too
    expect(AUTOMATION_DENIED_TOOLS).not.toContain('Bash(git push:*)');
    for (const t of AUTOMATION_DENIED_TOOLS) for (const own of branchPushRules('TER-1-card')) expect(denyGlob(t).test(own)).toBe(false);
  });

  it('path rules use the documented anchors: `//` (filesystem root) for .env, `~/` for the home dir; none is cwd-relative', () => {
    const paths = AUTOMATION_DENIED_TOOLS.filter((t) => /^(Read|Edit)\(/.test(t)).map((t) => t.replace(/^(Read|Edit)\((.*)\)$/, '$2'));
    expect(paths.length).toBe(10);
    for (const p of paths) expect(p.startsWith('//') || p.startsWith('~/'), p).toBe(true);
    expect(launchLine('claude', null, 'x', null, null, PERMISSION)).toContain(`'Read(//**/.env*)' 'Edit(//**/.env*)' 'Read(~/.ssh/**)'`);
  });

  it('a project allow rule too broad for an automatic tab never reaches the line; the run\'s own pushes still do (TER-968, review 1)', () => {
    const broad = ['Bash', 'Bash(*)', 'Bash(git:*)', 'Bash(git *)', 'Bash(git push:*)', 'Bash(git push origin HEAD)', 'Bash(npm run:*)', 'Bash(gh:*)', 'Bash(docker:*)', 'Bash(sh -c:*)', '*'];
    const line = launchLine('claude', null, 'x', null, null, { mode: 'acceptEdits', allowedTools: [...broad, 'Bash(npm test:*)'], branch: 'TER-1-card' });
    const allow = line.slice(line.indexOf('--allowedTools'), line.indexOf('--disallowedTools'));
    for (const b of broad) expect(allow, b).not.toContain(` '${b}'`);
    expect(allow).toContain(`'Bash(npm test:*)' ${branchPushRules('TER-1-card').map((t) => `'${t}'`).join(' ')}`);
  });

  it('the run\'s own branch push rules are exact and built only from a valid branch name', () => {
    expect(branchPushRules('TER-1-card')).toEqual([
      'Bash(git push origin TER-1-card)',
      'Bash(git push -u origin TER-1-card)',
      'Bash(git push origin HEAD:refs/heads/TER-1-card)',
      'Bash(git push -u origin HEAD:refs/heads/TER-1-card)',
    ]);
    for (const bad of [null, '', '-x', 'a b', 'a*', 'HEAD:main', '+main', 'a..b', "a'b"]) expect(branchPushRules(bad), String(bad)).toEqual([]);
  });

  it('an automatic line carries the run\'s own push rules in the single --allowedTools, then the deny list, then `--`', () => {
    const line = launchLine('claude', null, 'x', { tabId: 'abc', url: MCP_URL }, null, { ...PERMISSION, branch: 'TER-7-epic' });
    const own = branchPushRules('TER-7-epic').map((t) => `'${t}'`).join(' ');
    expect(line).toContain(`${TAB_TOOLS} ${TOOLS} ${own} ${DENY} -- 'x'`);
    expect(line.indexOf('--allowedTools')).toBeLessThan(line.indexOf('--disallowedTools'));
    expect(line.indexOf('--disallowedTools')).toBeLessThan(line.lastIndexOf(' -- '));
    expect(resumeLine(null, '123e4567-e89b-12d3-a456-426614174000', 'x', null, null, { ...PERMISSION, branch: 'TER-7-epic' })).toContain(`${TOOLS} ${own} ${DENY} --resume`);
  });

  it('a manual tab gets no deny list and no push rule: its lines are unchanged', () => {
    for (const line of [
      launchLine('claude', '/c', 'x'),
      launchLine('claude', '/c', 'x', { tabId: 'abc', url: MCP_URL }),
      resumeLine(null, '123e4567-e89b-12d3-a456-426614174000', 'x', 'abc'),
      continueLine('claude', null),
    ]) {
      expect(line).not.toContain('--disallowedTools');
      expect(line).not.toContain('git push');
    }
  });

  it('Codex ignores the permission: the line is the plain one', () => {
    expect(launchLine('chatgpt', '/c', 'x', null, null, PERMISSION)).toBe(launchLine('chatgpt', '/c', 'x'));
    expect(launchLine('chatgpt', '/c', 'x', { tabId: 'abc', url: MCP_URL }, null, PERMISSION)).toBe(launchLine('chatgpt', '/c', 'x', { tabId: 'abc', url: MCP_URL }));
  });

  it('refuses a tool that would read as an option or break the line, and any other mode', () => {
    for (const bad of ['', ' ', '--dangerously-skip-permissions', 'Bash(x)\nrm', 'a\x1bb']) {
      expect(() => launchLine('claude', null, 'x', null, null, { mode: 'acceptEdits', allowedTools: [bad], branch: null }), JSON.stringify(bad)).toThrow(new ControlError('INVALID_ALLOWED_TOOL', 'Ferramenta permitida inválida'));
    }
    expect(() => launchLine('claude', null, 'x', null, null, { mode: 'bypassPermissions' as never, allowedTools: [], branch: null })).toThrow(new ControlError('INVALID_PERMISSION_MODE', 'Modo de permissão inválido'));
  });

  it('without internal options the start is byte-identical to before: same openTab call, same line', async () => {
    const { c } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'write a spec' });
    expect(openTab.mock.calls[0]).toStrictEqual([c, { project_id: 'p1', machine_id: 'm1', name: 'claude · pedrogoiania' }]);
    expect(sendTextToSession.mock.calls[0][2]).toBe(`CLAUDE_CONFIG_DIR='/Users/p/.claude-work' claude '${started('write a spec').replace(/'/g, "'\\''")}'`);
    vi.clearAllMocks();
    await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'write a spec' }, {});
    expect(openTab.mock.calls[0]).toHaveLength(2);
    expect(sendTextToSession.mock.calls[0][2]).toBe(launchLine('claude', '/Users/p/.claude-work', started('write a spec')));
  });

  it('opens the tab in the worktree and types the setup command, then the line with the flags', async () => {
    const { c } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'do the card' }, { cwd: WORKTREE, permission: PERMISSION, setupCommand: 'npm ci && npm run build:packages' });
    expect(openTab).toHaveBeenCalledWith(c, { project_id: 'p1', machine_id: 'm1', name: 'claude · pedrogoiania' }, { cwd: WORKTREE });
    expect(sendTextToSession.mock.calls[0][2]).toBe(`eval 'npm ci && npm run build:packages' ; ${launchLine('claude', '/Users/p/.claude-work', started('do the card'), null, null, PERMISSION)}`);
  });

  it('with the MCP installed, the setup command and the merged allow list', async () => {
    cfg.mcpUrl = MCP_URL;
    openTab.mockResolvedValue({ tab_id: 'abc', name: 'pedrogoiania', project_id: 'p1', tmux_session: 'termhub-p1-abc', created: true });
    const { c } = ctx();
    await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'do the card' }, { cwd: WORKTREE, permission: PERMISSION, setupCommand: 'pnpm i' });
    expect(sendTextToSession.mock.calls[0][2]).toBe(`eval 'pnpm i' ; ${launchLine('claude', '/Users/p/.claude-work', started('do the card'), { tabId: 'abc', url: MCP_URL }, null, PERMISSION)}`);
  });

  it('onTabOpened is told the tab before anything is typed into it; its failure is a failed start with the tab id', async () => {
    const { c } = ctx();
    const order: string[] = [];
    sendTextToSession.mockImplementationOnce(async () => void order.push('typed'));
    await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'x' }, { onTabOpened: async (id) => void order.push(`opened:${id}`) });
    expect(order).toEqual([`opened:${(await openTab.mock.results[0]!.value).tab_id}`, 'typed']);
    vi.clearAllMocks();
    const err = await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'x' }, { onTabOpened: async () => { throw new Error('db down'); } }).catch((e: unknown) => e);
    expect(tabIdOfError(err)).toBeTruthy();
    expect(sendTextToSession).not.toHaveBeenCalled();
  });

  it('a blank setup command adds nothing; promptIsFinal does not append the lessons reminder again', async () => {
    const { c } = ctx();
    const prompt = withLessonsReminder('do the card');
    await startAgent(c, { project_id: 'p1', account_id: 'a1', prompt }, { setupCommand: '  ', promptIsFinal: true });
    expect(sendTextToSession.mock.calls[0][2]).toBe(launchLine('claude', '/Users/p/.claude-work', withOriginReminder(prompt)));
  });

  it('isolates the setup command: a comment, a trailing ; & \\ or an unbalanced quote never break the CLI line', () => {
    expect(withSetup('npm ci # x', 'claude x')).toBe("eval 'npm ci # x' ; claude x");
    expect(withSetup('npm ci;', 'claude x')).toBe("eval 'npm ci;' ; claude x");
    expect(withSetup('npm ci &', 'claude x')).toBe("eval 'npm ci &' ; claude x");
    expect(withSetup("FOO='a b' npm ci", 'claude x')).toBe("eval 'FOO='\\''a b'\\'' npm ci' ; claude x");
    // run for real in bash (as a tab's shell would): the line after the setup always runs, and the setup itself runs as written
    const run = (setup: string) => execFileSync('bash', ['--norc', '--noprofile', '-c', withSetup(setup, 'echo LAUNCHED')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const setup of ['true # x', 'true;', 'true &', 'true \\', 'echo "unbalanced', "echo 'unbalanced", 'false']) {
      expect(run(setup), setup).toMatch(/LAUNCHED\n$/);
    }
    expect(run("V='a b'; echo \"[$V]\"")).toBe('[a b]\nLAUNCHED\n');
  });

  it('refuses a cwd that is not absolute or climbs out, and a multi-line setup, before any tab exists', async () => {
    const { c } = ctx();
    for (const cwd of ['relative/dir', '~/wt', '', '/home/u/../etc', '/a/..', '/a\nb']) {
      await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'x' }, { cwd }), JSON.stringify(cwd)).rejects.toMatchObject({ code: 'INVALID_CWD' });
    }
    await expect(startAgent(c, { project_id: 'p1', account_id: 'a1', prompt: 'x' }, { setupCommand: 'npm ci\nrm -rf /' })).rejects.toMatchObject({ code: 'INVALID_SETUP_COMMAND' });
    expect(openTab).not.toHaveBeenCalled();
    expect(sendTextToSession).not.toHaveBeenCalled();
  });
});
