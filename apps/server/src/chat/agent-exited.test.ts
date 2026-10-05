import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Tab } from '../db/repositories/types.js';

const { publishTabQuestions, closeTabQuestions, swapPreferences } = vi.hoisted(() => ({
  publishTabQuestions: vi.fn(async () => []),
  closeTabQuestions: vi.fn(async () => []),
  swapPreferences: vi.fn(async () => ({})),
}));
vi.mock('./tab-questions.js', () => ({ publishTabQuestions, closeTabQuestions }));
vi.mock('../control/account-swap.js', () => ({ swapPreferences }));

const { EXITED_RESUME_PROMPT, notifyAgentExited, resumeCommandFor } = await import('./agent-exited.js');

const SID = '6d127d73-4bd0-42d6-b4a6-d96899507e62';
const AT = '2026-10-01T05:48:20.000Z';
const tab = (over: Partial<Tab> = {}): Tab =>
  ({ id: 'tab1abc', project_id: 'p1', machine_id: 'm1', name: 'TER-641 badge', kind: 'terminal', tmux_session: 'th-t1', state: 'idle', state_tool: 'claude', agent_session_id: SID, ai_account_id: 'a1', ...over }) as Tab;
const machine = { id: 'm1', owner_id: 'u1', name: 'jarvis', type: 'agent' } as Machine;
const account = { id: 'a1', machine_id: 'm1', provider: 'claude', config_dir: '~/.claude_b', label: 'B' } as AiAccount;
const log = () => ({ info: vi.fn(), warn: vi.fn() });

function repos(opts: { conversation?: boolean; liveToken?: boolean; accounts?: AiAccount[]; activeRun?: boolean } = {}) {
  const open = vi.fn(async () => ({ question: { id: 'q1' }, closed: [{ id: 'old' }] }));
  const r = {
    automationRuns: { activeByTab: vi.fn(async () => (opts.activeRun ? { id: 'run1' } : null)) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    chat: { findLatestActiveForProject: vi.fn(async () => (opts.conversation === false ? undefined : { id: 'c1' })) },
    aiAccounts: { list: vi.fn(async () => opts.accounts ?? [account]) },
    apiTokens: { hasLiveForTab: vi.fn(async () => opts.liveToken ?? false) },
    tabQuestions: { open },
  } as unknown as Repositories;
  return { r, open };
}

beforeEach(() => vi.clearAllMocks());

describe('resumeCommandFor (TER-643)', () => {
  it('resumes the Claude session the hooks reported, under the tab\'s account and with the project model', async () => {
    swapPreferences.mockResolvedValueOnce({ model: 'opus' });
    const line = await resumeCommandFor(repos().r, tab(), machine);
    expect(line).toBe(`CLAUDE_CONFIG_DIR="$HOME"/'.claude_b' claude --model 'opus' --resume ${SID} '${EXITED_RESUME_PROMPT}'`);
  });

  it('keeps the tab\'s memory MCP while its token lives', async () => {
    const line = await resumeCommandFor(repos({ liveToken: true }).r, tab(), machine);
    expect(line).toContain('--mcp-config "$HOME"/');
    expect(line).toContain(`--resume ${SID} -- `);
  });

  it('with no session id, continues the last one; Codex resumes its last; an unknown account is the default login', async () => {
    expect(await resumeCommandFor(repos().r, tab({ agent_session_id: null }), machine)).toBe(`CLAUDE_CONFIG_DIR="$HOME"/'.claude_b' claude --continue`);
    expect(await resumeCommandFor(repos({ accounts: [] }).r, tab({ state_tool: 'codex', ai_account_id: null }), machine)).toBe(
      'command -v unset >/dev/null 2>&1 && unset CODEX_HOME; codex --no-alt-screen resume --last',
    );
  });
});

describe('resumeCommandFor an automatic tab (preflight F-12)', () => {
  const auto = { permission: { mode: 'acceptEdits' as const, allowedTools: ['Bash(git status:*)'] }, prompt: '[termhub automático] continue' };

  it('resumes the session with the run\'s permission profile and the given message', async () => {
    const line = await resumeCommandFor(repos().r, tab(), machine, auto);
    expect(line).toBe(`CLAUDE_CONFIG_DIR="$HOME"/'.claude_b' claude --permission-mode acceptEdits --allowedTools 'Bash(git status:*)' --resume ${SID} -- '[termhub automático] continue'`);
  });

  it('with no session id, continues the last one with the profile and the message', async () => {
    const line = await resumeCommandFor(repos({ liveToken: true }).r, tab({ agent_session_id: null }), machine, auto);
    expect(line).toContain('--permission-mode acceptEdits --mcp-config "$HOME"/');
    expect(line).toMatch(/'Bash\(git status:\*\)' --continue -- '\[termhub automático\] continue'$/);
  });
});

describe('notifyAgentExited (TER-643)', () => {
  it('opens no card for a tab with an active automatic run: the follower restarts it', async () => {
    const { r, open } = repos({ activeRun: true });
    await notifyAgentExited(r, log(), tab(), machine, AT);
    expect(open).not.toHaveBeenCalled();
    expect(closeTabQuestions).toHaveBeenCalledWith(r, 'tab1abc', 'expired');
  });

  it('opens a resume card in the owner\'s chat and announces it, with what it closed', async () => {
    const { r, open } = repos();
    const l = log();
    await notifyAgentExited(r, l, tab(), machine, AT);
    expect(open).toHaveBeenCalledWith({
      tab_id: 'tab1abc',
      project_id: 'p1',
      conversation_id: 'c1',
      kind: 'suggestion',
      payload: { text: expect.stringContaining(`--resume ${SID}`), context: null, exited: true, last_at: AT },
      tool_use_id: null,
      agent_id: null,
    });
    expect(publishTabQuestions).toHaveBeenCalledWith(r, 'tab_question_closed', [{ id: 'old' }]);
    expect(publishTabQuestions).toHaveBeenCalledWith(r, 'tab_question', [{ id: 'q1' }]);
    expect(l.info).toHaveBeenCalledWith({ tabId: 'tab1abc', machineId: 'm1', tabQuestionId: 'q1', closed: 1 }, 'agent exited card opened');
  });

  it('a Codex tab\'s card says so', async () => {
    const { r, open } = repos();
    await notifyAgentExited(r, log(), tab({ state_tool: 'codex' }), machine, AT);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ agent: 'codex', exited: true }) }));
  });

  it('a project nobody chats in gets no card, but the dead process\'s cards expire', async () => {
    const { r, open } = repos({ conversation: false });
    await notifyAgentExited(r, log(), tab(), machine, AT);
    expect(open).not.toHaveBeenCalled();
    expect(closeTabQuestions).toHaveBeenCalledWith(r, 'tab1abc', 'expired');
  });

  it('never throws: a failure is logged by code', async () => {
    const { r, open } = repos();
    open.mockRejectedValueOnce(new Error('db down'));
    const l = log();
    await expect(notifyAgentExited(r, l, tab(), machine, AT)).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab1abc' }), 'agent exited card failed');
  });
});
