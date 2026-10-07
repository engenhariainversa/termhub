import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIAL_SEPARATOR } from './ai-credentials.js';
import {
  AI_LOGIN_HINTS,
  type UsageReply,
  type UsageRequest,
  fetchUsageHttp,
  parseAiCredential,
  parseQuotaBuckets,
  parseQuotaSummary,
  parseRetryAfter,
  parseUsageBody,
  queryUsage,
  usageFromCredentialOutput,
} from './ai-usage.js';

// Shape of https://api.anthropic.com/api/oauth/usage (values trimmed).
const body = {
  five_hour: { utilization: 22.0, resets_at: '2026-09-18T11:10:00.383593+00:00' },
  seven_day: { utilization: 74.0, resets_at: '2026-09-22T00:00:00.383614+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  nimbus_quill: { utilization: 0.0, resets_at: null },
  limits: [
    { kind: 'session', group: 'session', percent: 22, resets_at: '2026-09-18T11:10:00.383593+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 74, resets_at: '2026-09-22T00:00:00.383614+00:00', scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 92, resets_at: '2026-09-21T23:59:59.383855+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  ],
};

describe('parseUsageBody', () => {
  it('keeps the account-wide windows in order and appends the per-model (Fable) cap', () => {
    const windows = parseUsageBody(body);
    expect(windows.map((w) => w.key)).toEqual(['five_hour', 'seven_day', 'nimbus_quill', 'limit:weekly_scoped:Fable']);
    const fable = windows[3];
    expect(fable.label).toBe('7 dias · Fable');
    expect(fable.utilization).toBe(92);
    expect(fable.resets_at).toBe(new Date('2026-09-21T23:59:59.383855+00:00').toISOString());
  });

  it('marks the windows that cap one model with its family, and only those (TER-837)', () => {
    expect(parseUsageBody(body).map((w) => w.model)).toEqual([undefined, undefined, undefined, 'fable']);
    const windows = parseUsageBody({
      seven_day_opus: { utilization: 40, resets_at: null },
      limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 30, scope: { model: { display_name: 'Opus 5.5' } } }],
    });
    expect(windows.map((w) => [w.key, w.model])).toEqual([['seven_day_opus', 'opus'], ['limit:weekly_scoped:Opus 5.5', 'opus']]);
  });

  it('does not duplicate unscoped limits already covered by the top-level windows', () => {
    const windows = parseUsageBody(body);
    expect(windows.filter((w) => w.key.startsWith('limit:'))).toHaveLength(1);
  });

  it('ignores limits without a percent or a readable scope', () => {
    const windows = parseUsageBody({
      limits: [
        { kind: 'weekly_scoped', group: 'weekly', scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', group: 'weekly', percent: 10, scope: { model: {}, surface: null } },
      ],
    });
    expect(windows).toEqual([]);
  });

  it('returns nothing for a payload without usage data', () => {
    expect(parseUsageBody({ extra_usage: { is_enabled: false } })).toEqual([]);
  });
});

describe('parseAiCredential(claude)', () => {
  const doc = (token: string, expiresAt?: number, subscriptionType = 'max') =>
    JSON.stringify({ claudeAiOauth: { accessToken: token, ...(expiresAt !== undefined ? { expiresAt } : {}), subscriptionType } });

  it('parses a single JSON document with no separator (old agent, <0.1.7)', () => {
    const cred = parseAiCredential('claude', doc('old-token', 1234));
    expect(cred).toEqual({ token: 'old-token', extra: {}, expires_at: 1234, plan: 'max' });
  });

  it('picks the keychain candidate when the file candidate is stale', () => {
    const stdout = [doc('stale-file-token', 100), doc('fresh-keychain-token', 999999)].join(`\n${CREDENTIAL_SEPARATOR}\n`);
    const cred = parseAiCredential('claude', stdout);
    expect(cred.token).toBe('fresh-keychain-token');
    expect(cred.expires_at).toBe(999999);
  });

  it('skips a garbage chunk and keeps the valid one', () => {
    const stdout = [`not json`, doc('valid-token', 42)].join(`\n${CREDENTIAL_SEPARATOR}\n`);
    expect(parseAiCredential('claude', stdout).token).toBe('valid-token');
  });

  it('picks a dated candidate over an undated one, but still accepts an undated candidate alone', () => {
    const dated = parseAiCredential('claude', [doc('no-expiry'), doc('with-expiry', 500)].join(`\n${CREDENTIAL_SEPARATOR}\n`));
    expect(dated.token).toBe('with-expiry');
    const undatedOnly = parseAiCredential('claude', doc('no-expiry'));
    expect(undatedOnly.token).toBe('no-expiry');
    expect(undatedOnly.expires_at).toBeNull();
  });

  it('throws when no chunk yields a token', () => {
    const stdout = [`not json`, `{"foo":"bar"}`, ``].join(`\n${CREDENTIAL_SEPARATOR}\n`);
    expect(() => parseAiCredential('claude', stdout)).toThrow('Claude Code credential has no OAuth token');
  });
});

describe('parseAiCredential(antigravity)', () => {
  it('returns the token and expires_at for the documented credential shape', () => {
    const stdout = JSON.stringify({ token: { access_token: 'ya29.test', expiry: '2026-09-18T12:00:00Z' } });
    const cred = parseAiCredential('antigravity', stdout);
    expect(cred.token).toBe('ya29.test');
    expect(cred.expires_at).toBe(Date.parse('2026-09-18T12:00:00Z'));
    expect(cred.extra).toEqual({});
    expect(cred.plan).toBeNull();
  });

  it('throws when token.access_token is missing', () => {
    const stdout = JSON.stringify({ token: { expiry: '2026-09-18T12:00:00Z' } });
    expect(() => parseAiCredential('antigravity', stdout)).toThrow('Antigravity CLI credential has no access token');
  });

  it('expires_at is null when expiry is absent or not a parsable date', () => {
    expect(parseAiCredential('antigravity', JSON.stringify({ token: { access_token: 'ya29.test' } })).expires_at).toBeNull();
    expect(parseAiCredential('antigravity', JSON.stringify({ token: { access_token: 'ya29.test', expiry: 'not-a-date' } })).expires_at).toBeNull();
  });
});

describe('parseAiCredential(chatgpt / gemini)', () => {
  it('reads the ChatGPT token, account id and JWT exp', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 2000000000 })).toString('base64url');
    const token = `h.${payload}.s`;
    const cred = parseAiCredential('chatgpt', JSON.stringify({ tokens: { access_token: token, account_id: 'acc-1' } }));
    expect(cred).toEqual({ token, extra: { account_id: 'acc-1' }, expires_at: 2000000000 * 1000, plan: null });
  });

  it('reads the Gemini token and expiry_date', () => {
    expect(parseAiCredential('gemini', JSON.stringify({ access_token: 'ya29.g', expiry_date: 1234 }))).toEqual({ token: 'ya29.g', extra: {}, expires_at: 1234, plan: null });
  });

  it('never quotes the credential file in a parse error', () => {
    const secret = 'sk-very-secret-token-value';
    expect(() => parseAiCredential('gemini', `{"access_token": "${secret}"`)).toThrow('Could not parse the Gemini CLI credential');
    try {
      parseAiCredential('chatgpt', `${secret} garbage`);
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
  });
});

describe('parseQuotaSummary', () => {
  it('turns retrieveUserQuotaSummary groups into 5h / weekly windows', () => {
    const windows = parseQuotaSummary({
      groups: [
        {
          buckets: [
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-09-25T08:11:39Z', remainingFraction: 1 },
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-09-18T13:11:39Z', remainingFraction: 0.25 },
          ],
        },
      ],
    });
    expect(windows).toEqual([
      { key: 'gemini-weekly', label: '7 dias', utilization: 0, resets_at: '2026-09-25T08:11:39.000Z' },
      { key: 'gemini-5h', label: '5 horas', utilization: 75, resets_at: '2026-09-18T13:11:39.000Z' },
    ]);
  });

  it('prefixes the group name when the summary has several groups', () => {
    const windows = parseQuotaSummary({
      groups: [{ displayName: 'Claude', buckets: [{ bucketId: 'claude-5h', window: '5h', remainingFraction: 0.5 }] }],
    });
    expect(windows[0].label).toBe('5 horas · Claude');
    expect(windows[0].utilization).toBe(50);
  });

  it('skips buckets without remainingFraction and payloads without groups', () => {
    expect(parseQuotaSummary({ groups: [{ buckets: [{ bucketId: 'x', window: '5h' }] }] })).toEqual([]);
    expect(parseQuotaSummary({})).toEqual([]);
  });
});

describe('parseQuotaBuckets', () => {
  it('turns retrieveUserQuota buckets into per-model windows', () => {
    const windows = parseQuotaBuckets({
      buckets: [{ tokenType: 'WTUS', modelId: 'claude-opus-4-6-thinking', resetTime: '2026-09-18T13:11:39Z', remainingFraction: 0.1 }],
    });
    expect(windows).toEqual([{ key: 'claude-opus-4-6-thinking:WTUS', label: 'claude-opus-4-6-thinking · wtus', utilization: 90, resets_at: '2026-09-18T13:11:39.000Z' }]);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('Wed, 07 Oct 2026 12:00:30 GMT', Date.parse('2026-10-07T12:00:00Z'))).toBe(30_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

const reply = (status: number, b: unknown, retryAfterMs: number | null = null): UsageReply => ({ status, body: b, text: b === null ? '' : JSON.stringify(b), retryAfterMs });

describe('queryUsage', () => {
  it('claude: asks the usage endpoint without any credential header and keeps the plan from the context', async () => {
    const http = vi.fn(async (_req: UsageRequest) => reply(200, body));
    const r = await queryUsage('claude', { plan: 'max', expires_at: null }, http);
    expect(r.ok).toBe(true);
    expect(r.plan).toBe('max');
    expect(r.windows).toHaveLength(4);
    const req = http.mock.calls[0][0];
    expect(req.url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(Object.keys(req.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('reports an expired token without asking the provider', async () => {
    const http = vi.fn();
    const r = await queryUsage('claude', { plan: null, expires_at: Date.now() - 1000 }, http);
    expect(r).toMatchObject({ ok: false, error: 'Claude Code token expired' });
    expect(http).not.toHaveBeenCalled();
  });

  it('passes a 429 through as rate_limited with the Retry-After', async () => {
    const r = await queryUsage('chatgpt', { plan: null, expires_at: null }, async () => reply(429, null, 60_000));
    expect(r).toMatchObject({ ok: false, rate_limited: true, retry_after_ms: 60_000 });
  });

  it('chatgpt: reads the primary and secondary windows and the plan', async () => {
    const r = await queryUsage('chatgpt', { plan: null, expires_at: null }, async () =>
      reply(200, { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 }, secondary_window: { used_percent: 40, limit_window_seconds: 604800 } } }),
    );
    expect(r.ok).toBe(true);
    expect(r.plan).toBe('pro');
    expect(r.windows.map((w) => [w.label, w.utilization])).toEqual([['5 horas', 12], ['7 dias', 40]]);
  });

  it('antigravity: loadCodeAssist then the quota summary, with the IDE headers', async () => {
    const http = vi.fn(async (req: UsageRequest) => {
      if (req.url.endsWith(':loadCodeAssist')) return reply(200, { currentTier: { name: 'Pro' } });
      return reply(200, { groups: [{ buckets: [{ bucketId: 'b', window: '5h', remainingFraction: 0.5 }] }] });
    });
    const r = await queryUsage('antigravity', { plan: null, expires_at: null }, http);
    expect(r).toMatchObject({ ok: true, plan: 'Pro' });
    expect(http.mock.calls.map((c) => c[0].url.split(':').pop())).toEqual(['loadCodeAssist', 'retrieveUserQuotaSummary']);
    expect(http.mock.calls[0][0]).toMatchObject({ method: 'POST', headers: { 'user-agent': 'Antigravity/1.0.0' } });
  });

  it('gemini: falls back to the quota without the project', async () => {
    const http = vi.fn(async (req: UsageRequest) => {
      if (req.url.endsWith(':loadCodeAssist')) return reply(200, { cloudaicompanionProject: 'proj' });
      if (req.body === JSON.stringify({ project: 'proj' })) return reply(500, null);
      return reply(200, { buckets: [{ modelId: 'gemini-pro', remainingFraction: 0.75 }] });
    });
    const r = await queryUsage('gemini', { plan: null, expires_at: null }, http);
    expect(r).toMatchObject({ ok: true, windows: [{ key: 'gemini-pro:', utilization: 25 }] });
    expect(http).toHaveBeenCalledTimes(3);
  });
});

describe('fetchUsageHttp', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds the bearer token and the chatgpt account id, and parses body and Retry-After', async () => {
    const fetchMock = vi.fn(async () => new Response('{"a":1}', { status: 429, headers: { 'retry-after': '7' } }));
    vi.stubGlobal('fetch', fetchMock);
    const http = fetchUsageHttp('chatgpt', { token: 'tok', extra: { account_id: 'acc' }, expires_at: null, plan: null });
    const r = await http({ url: 'https://x.test/u', headers: { accept: 'application/json' } });
    expect(r).toEqual({ status: 429, body: { a: 1 }, text: '{"a":1}', retryAfterMs: 7000 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.test/u');
    expect(init.headers).toEqual({ accept: 'application/json', authorization: 'Bearer tok', 'chatgpt-account-id': 'acc' });
  });

  it('only adds chatgpt-account-id for chatgpt; a non-JSON body parses to null', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchUsageHttp('claude', { token: 'tok', extra: { account_id: 'acc' }, expires_at: null, plan: null })({ url: 'https://x.test/u' });
    expect(r.body).toBeNull();
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual({ authorization: 'Bearer tok' });
  });
});

describe('usageFromCredentialOutput', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('empty output: no credential, with the login hint', async () => {
    await expect(usageFromCredentialOutput('gemini', '  \n')).resolves.toEqual({ ok: false, plan: null, windows: [], error: 'No credential found on the machine', hint: AI_LOGIN_HINTS.gemini });
  });

  it('unparsable credential: the parse error with the login hint', async () => {
    const r = await usageFromCredentialOutput('claude', '{"foo":1}');
    expect(r).toMatchObject({ ok: false, error: 'Claude Code credential has no OAuth token', hint: AI_LOGIN_HINTS.claude });
  });

  it('queries the provider with the token, and the token never appears in the result', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await usageFromCredentialOutput('claude', JSON.stringify({ claudeAiOauth: { accessToken: 'secret-tok', subscriptionType: 'pro' } }));
    expect(r).toMatchObject({ ok: true, plan: 'pro' });
    expect(JSON.stringify(r)).not.toContain('secret-tok');
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ authorization: 'Bearer secret-tok' });
  });

  it('a timeout becomes "Provider did not answer in time"; other errors keep their message', async () => {
    const cred = JSON.stringify({ access_token: 'ya29' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }));
    await expect(usageFromCredentialOutput('gemini', cred)).resolves.toMatchObject({ ok: false, error: 'Provider did not answer in time' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(usageFromCredentialOutput('gemini', cred)).resolves.toMatchObject({ ok: false, error: 'fetch failed' });
  });
});
