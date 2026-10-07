import { AI_LOGIN_HINTS, DEFAULT_CONFIG_DIRS, configDirPrefix, credentialScript } from '@termhub/machine-ops';
import { RPC } from '@termhub/agent-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { boundUsageResult, usage } from './ai.js';

const TOKEN = 'sk-ant-oat01-super-secret-token';
const claudeCred = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 3_600_000, subscriptionType: 'max' } });
const usageBody = { five_hour: { utilization: 22, resets_at: '2026-10-07T12:00:00Z' }, seven_day: { utilization: 74, resets_at: null } };

const fetchMock = vi.fn();

beforeEach(() => {
  sh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ai.usage', () => {
  it('reads the credential with the $D prefix from DEFAULT_CONFIG_DIRS and asks the provider itself', async () => {
    sh.mockResolvedValue({ code: 0, stdout: claudeCred, stderr: '', timedOut: false });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(usageBody), { status: 200 }));
    const r = await usage({ provider: 'claude', config_dir: null });
    expect(sh).toHaveBeenCalledWith(`${configDirPrefix(null, DEFAULT_CONFIG_DIRS.claude)}; ${credentialScript('claude')}`, { timeoutMs: 10_000 });
    expect(r).toMatchObject({ ok: true, plan: 'max', error: null });
    expect(r.windows.map((w) => w.key)).toEqual(['five_hour', 'seven_day']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    // the token is used here and never travels back
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(RPC['ai.usage'].result.safeParse(r).success).toBe(true);
  });

  it('builds the $D prefix from a custom config_dir', async () => {
    sh.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await usage({ provider: 'claude', config_dir: '~/.claude-work' });
    expect(sh).toHaveBeenCalledWith(`${configDirPrefix('~/.claude-work', DEFAULT_CONFIG_DIRS.claude)}; ${credentialScript('claude')}`, { timeoutMs: 10_000 });
  });

  it('no credential: answers with the login hint, without calling the provider', async () => {
    sh.mockResolvedValue({ code: 0, stdout: '\n', stderr: '', timedOut: false });
    await expect(usage({ provider: 'gemini', config_dir: null })).resolves.toEqual({ ok: false, plan: null, windows: [], error: 'No credential found on the machine', hint: AI_LOGIN_HINTS.gemini });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-zero exit answers a fixed error, never the script output', async () => {
    sh.mockResolvedValue({ code: 1, stdout: TOKEN, stderr: TOKEN, timedOut: false });
    const r = await usage({ provider: 'claude', config_dir: null });
    expect(r).toEqual({ ok: false, plan: null, windows: [], error: 'Could not read the credential on the machine', hint: AI_LOGIN_HINTS.claude });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a timeout of the credential read answers an error', async () => {
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(usage({ provider: 'claude', config_dir: null })).resolves.toMatchObject({ ok: false, error: 'Machine did not answer in time' });
  });

  it('an invalid config dir raises invalid', async () => {
    await expect(usage({ provider: 'claude', config_dir: '/a\nb' })).rejects.toMatchObject({ code: 'invalid' });
    expect(sh).not.toHaveBeenCalled();
  });

  it('a provider timeout or rejection comes back as numbers-free errors without the token', async () => {
    sh.mockResolvedValue({ code: 0, stdout: claudeCred, stderr: '', timedOut: false });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    await expect(usage({ provider: 'claude', config_dir: null })).resolves.toMatchObject({ ok: false, error: 'Provider did not answer in time' });
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '60' } }));
    const r = await usage({ provider: 'claude', config_dir: null });
    expect(r).toMatchObject({ ok: false, rate_limited: true, retry_after_ms: 60_000 });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe('boundUsageResult', () => {
  it('clamps an oversized answer into the ai.usage schema', () => {
    const big = boundUsageResult({
      ok: false,
      plan: 'p'.repeat(300),
      windows: Array.from({ length: 80 }, (_, i) => ({ key: 'k'.repeat(500) + i, label: 'l'.repeat(500), utilization: Number.NaN, resets_at: 'r'.repeat(100), model: 'm'.repeat(100) })),
      error: 'e'.repeat(2000),
      hint: 'h'.repeat(2000),
      rate_limited: true,
      retry_after_ms: -5,
    });
    expect(RPC['ai.usage'].result.safeParse(big).success).toBe(true);
    expect(big.windows).toHaveLength(50);
    expect(big.retry_after_ms).toBe(0);
  });
});
