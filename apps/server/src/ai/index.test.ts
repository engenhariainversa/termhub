import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiUsageResult } from '@termhub/machine-ops';
import type { AiAccount, Machine } from '../db/repositories/types.js';
import type { ExecResult } from '../terminal/machine-exec.js';

const runOnMachine = vi.fn<(machine: Machine, local: { file: string; args: string[] }, remote: string, timeoutMs?: number) => Promise<ExecResult>>();
vi.mock('../terminal/machine-exec.js', () => ({ runOnMachine: (...a: Parameters<typeof runOnMachine>) => runOnMachine(...a) }));

const usageFromCredentialOutput = vi.fn<(provider: string, stdout: string) => Promise<AiUsageResult>>();
vi.mock('@termhub/machine-ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@termhub/machine-ops')>()),
  usageFromCredentialOutput: (p: string, s: string) => usageFromCredentialOutput(p, s),
}));

const { forgetAccountUsage, getAccountUsage } = await import('./index.js');
const { agents, AgentOfflineError } = await import('../agent/registry.js');
const { AgentTimeoutError } = await import('../agent/connection.js');

const account = { id: 'acc1', provider: 'claude', label: 'x', machine_id: 'm1', config_dir: null } as unknown as AiAccount;
const local = { id: 'm1', type: 'local', ai_usage_query: true } as unknown as Machine;
const ssh = { id: 'm1', type: 'ssh', host: 'box', ai_usage_query: true } as unknown as Machine;
const agent = { id: 'm1', type: 'agent', ai_usage_query: true } as unknown as Machine;
const ok = (utilization: number): AiUsageResult => ({ ok: true, plan: 'max', windows: [{ key: 'five_hour', label: '5 horas', utilization, resets_at: null }], error: null, hint: null });
const limited: AiUsageResult = { ok: false, plan: null, windows: [], error: 'Anthropic rate-limited the usage query', hint: 'later', rate_limited: true, retry_after_ms: null };
const exec = (stdout: string, over: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false, ...over });

/** What usageRequestScript prints over SSH: meta block, curl's headers + body, status line. */
const sshOut = (meta: { expiry?: string; plan?: string }, status: number, body: unknown) =>
  `termhub-usage-meta\n${meta.expiry ?? ''}\n${meta.plan ?? ''}\ntermhub-usage-response\nHTTP/2 ${status}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}\ntermhub-usage-status=${status}\n`;
const claudeBody = { five_hour: { utilization: 22, resets_at: '2026-09-18T11:10:00Z' }, seven_day: { utilization: 74, resets_at: null } };

const onlineAgent = (version: string) => {
  vi.spyOn(agents, 'isOnline').mockReturnValue(true);
  vi.spyOn(agents, 'info').mockReturnValue({ agent_version: version, os: 'linux', tools: [], connected_at: '' });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-18T10:00:00Z'));
  runOnMachine.mockReset();
  usageFromCredentialOutput.mockReset();
  forgetAccountUsage(account.id);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('getAccountUsage: cache and back-off', () => {
  beforeEach(() => runOnMachine.mockResolvedValue(exec('{"claudeAiOauth":{}}')));

  it('asks the machine once per 5 minutes and honours a manual refresh only after 30 s', async () => {
    usageFromCredentialOutput.mockResolvedValue(ok(10));
    await getAccountUsage(account, local);
    await getAccountUsage(account, local);
    expect(usageFromCredentialOutput).toHaveBeenCalledTimes(1);

    await getAccountUsage(account, local, true); // too soon even for ↻
    expect(usageFromCredentialOutput).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(31_000);
    await getAccountUsage(account, local, true);
    expect(usageFromCredentialOutput).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(4 * 60_000);
    await getAccountUsage(account, local);
    expect(usageFromCredentialOutput).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2 * 60_000);
    await getAccountUsage(account, local);
    expect(usageFromCredentialOutput).toHaveBeenCalledTimes(3);
  });

  it('keeps the last good reading as stale while rate-limited and backs off, even on manual refresh', async () => {
    usageFromCredentialOutput.mockResolvedValueOnce(ok(42));
    const first = await getAccountUsage(account, local);
    expect(first.ok).toBe(true);

    vi.advanceTimersByTime(6 * 60_000);
    usageFromCredentialOutput.mockResolvedValue(limited);
    const stale = await getAccountUsage(account, local);
    expect(stale.ok).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.windows[0].utilization).toBe(42);
    expect(stale.fetched_at).toBe(first.fetched_at);
    expect(stale.hint).toBe('later');

    vi.advanceTimersByTime(5 * 60_000);
    await getAccountUsage(account, local, true);
    expect(usageFromCredentialOutput).toHaveBeenCalledTimes(2); // still backing off (10 min)

    vi.advanceTimersByTime(6 * 60_000);
    usageFromCredentialOutput.mockResolvedValue(ok(50));
    const fresh = await getAccountUsage(account, local);
    expect(usageFromCredentialOutput).toHaveBeenCalledTimes(3);
    expect(fresh.stale).toBeUndefined();
    expect(fresh.windows[0].utilization).toBe(50);
  });

  it('uses Retry-After for the back-off and surfaces the error when there is no earlier reading', async () => {
    usageFromCredentialOutput.mockResolvedValue({ ...limited, retry_after_ms: 60_000 });
    const r = await getAccountUsage(account, local);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Anthropic rate-limited the usage query');

    vi.advanceTimersByTime(59_000);
    await getAccountUsage(account, local, true);
    expect(usageFromCredentialOutput).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await getAccountUsage(account, local, true);
    expect(usageFromCredentialOutput).toHaveBeenCalledTimes(2);
  });
});

describe('getAccountUsage: switched off on the machine', () => {
  it('never contacts the machine, and turning it back on takes effect at once', async () => {
    const rpc = vi.spyOn(agents, 'rpc');
    for (const m of [local, ssh, agent]) {
      const r = await getAccountUsage(account, { ...m, ai_usage_query: false });
      expect(r).toMatchObject({ ok: false, reason: 'disabled', error: 'Usage query turned off on this machine', hint: null, windows: [] });
    }
    expect(runOnMachine).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();

    // not cached: back on, the next reading asks the machine
    runOnMachine.mockResolvedValue(exec('{}'));
    usageFromCredentialOutput.mockResolvedValue(ok(5));
    const back = await getAccountUsage(account, local);
    expect(back.ok).toBe(true);
    expect(back.reason).toBeUndefined();
  });

  it('wins over a reading cached while it was on', async () => {
    runOnMachine.mockResolvedValue(exec('{}'));
    usageFromCredentialOutput.mockResolvedValue(ok(5));
    await getAccountUsage(account, local);
    const off = await getAccountUsage(account, { ...local, ai_usage_query: false });
    expect(off.reason).toBe('disabled');
  });
});

describe('getAccountUsage: agent machines', () => {
  it('asks the agent for usage numbers (ai.usage), never for the credential', async () => {
    onlineAgent('0.20.0');
    const rpc = vi.spyOn(agents, 'rpc').mockResolvedValue(ok(33) as never);
    const r = await getAccountUsage({ ...account, config_dir: '~/.claude-work' }, agent);
    expect(r).toMatchObject({ ok: true, plan: 'max', account_id: 'acc1' });
    expect(r.windows[0].utilization).toBe(33);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('m1', 'ai.usage', { provider: 'claude', config_dir: '~/.claude-work' });
    expect(runOnMachine).not.toHaveBeenCalled();
  });

  it('does not query an agent older than 0.20.0 and says to update it', async () => {
    onlineAgent('0.19.3');
    const rpc = vi.spyOn(agents, 'rpc');
    const r = await getAccountUsage(account, agent);
    expect(r).toMatchObject({ ok: false, reason: 'agent_outdated', error: 'Update the agent on this machine to see usage', hint: 'npm i -g @termhub/agent (0.20.0 or newer)' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports an offline agent without asking it', async () => {
    vi.spyOn(agents, 'isOnline').mockReturnValue(false);
    const rpc = vi.spyOn(agents, 'rpc');
    const r = await getAccountUsage(account, agent);
    expect(r).toMatchObject({ ok: false, error: 'Agente desconectado' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps an agent that drops mid-call and an RPC timeout', async () => {
    onlineAgent('0.20.0');
    vi.spyOn(agents, 'rpc').mockRejectedValueOnce(new AgentOfflineError('gone')).mockRejectedValueOnce(new AgentTimeoutError('slow'));
    expect((await getAccountUsage(account, agent)).error).toBe('Agente desconectado');
    forgetAccountUsage(account.id);
    expect((await getAccountUsage(account, agent)).error).toBe('Machine did not answer in time');
  });
});

describe('getAccountUsage: SSH machines', () => {
  it('runs curl on the machine and reads the provider answer, with the plan from the machine', async () => {
    runOnMachine.mockResolvedValue(exec(sshOut({ expiry: '9999999999999', plan: 'max' }, 200, claudeBody)));
    const r = await getAccountUsage(account, ssh);
    expect(r).toMatchObject({ ok: true, plan: 'max', error: null });
    expect(r.windows.map((w) => w.utilization)).toEqual([22, 74]);
    // one SSH exec per provider request (the second pass replays the first reply)
    expect(runOnMachine).toHaveBeenCalledTimes(1);
    const [, localCmd, remote, timeout] = runOnMachine.mock.calls[0];
    expect(localCmd).toEqual({ file: '/bin/sh', args: ['-c', remote] });
    expect(remote).toContain('curl');
    expect(remote).toContain('-H @-');
    expect(timeout).toBe(20_000);
  });

  it('reports an expired token as the machine sees it', async () => {
    runOnMachine.mockResolvedValue(exec(sshOut({ expiry: '1000', plan: '' }, 401, { error: 'expired' })));
    const r = await getAccountUsage(account, ssh);
    expect(r).toMatchObject({ ok: false, error: 'Claude Code token expired' });
  });

  it('says when there is no credential or no curl on the machine', async () => {
    runOnMachine.mockResolvedValueOnce(exec('termhub-usage-no-credential\n'));
    const none = await getAccountUsage(account, ssh);
    expect(none).toMatchObject({ ok: false, error: 'No credential found on the machine' });
    expect(none.hint).toBeTruthy();

    forgetAccountUsage(account.id);
    runOnMachine.mockResolvedValueOnce(exec('termhub-usage-no-curl\n'));
    expect(await getAccountUsage(account, ssh)).toMatchObject({ ok: false, error: 'curl is not installed on the machine', hint: 'Install curl to see usage on SSH machines' });
  });

  it('maps SSH failures, garbage and a provider that never answered', async () => {
    const cases: [ExecResult, string][] = [
      [exec('', { code: 255 }), 'Machine unreachable over SSH'],
      [exec('', { code: null, timedOut: true }), 'Machine did not answer in time'],
      [exec('garbage'), 'Unexpected answer from the machine'],
      [exec('termhub-usage-meta\n\n\ntermhub-usage-response\n\ntermhub-usage-status=000\n'), 'Provider did not answer in time'],
    ];
    for (const [out, error] of cases) {
      forgetAccountUsage(account.id);
      runOnMachine.mockResolvedValueOnce(out);
      expect(await getAccountUsage(account, ssh)).toMatchObject({ ok: false, error });
    }
  });
});

describe('getAccountUsage: the server own host', () => {
  it('reads the credential locally and queries in-process', async () => {
    runOnMachine.mockResolvedValue(exec('{"claudeAiOauth":{"accessToken":"t"}}\n'));
    usageFromCredentialOutput.mockResolvedValue(ok(7));
    const r = await getAccountUsage(account, local);
    expect(r).toMatchObject({ ok: true, account_id: 'acc1' });
    expect(usageFromCredentialOutput).toHaveBeenCalledWith('claude', '{"claudeAiOauth":{"accessToken":"t"}}\n');
    const [, localCmd, script, timeout] = runOnMachine.mock.calls[0];
    expect(localCmd).toEqual({ file: '/bin/sh', args: ['-c', script] });
    expect(script).toContain('D="$HOME/.claude"');
    expect(script).not.toContain('curl');
    expect(timeout).toBe(10_000);
  });

  it('reports a missing machine', async () => {
    expect(await getAccountUsage(account, undefined)).toMatchObject({ ok: false, error: 'Machine no longer exists' });
  });
});
