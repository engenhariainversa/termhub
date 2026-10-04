import { CREDENTIAL_SEPARATOR } from '@termhub/machine-ops';
import { describe, expect, it } from 'vitest';
import { parseCredential, parseUsageBody } from './claude.js';

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

describe('parseCredential', () => {
  const doc = (token: string, expiresAt?: number, subscriptionType = 'max') =>
    JSON.stringify({ claudeAiOauth: { accessToken: token, ...(expiresAt !== undefined ? { expiresAt } : {}), subscriptionType } });

  it('parses a single JSON document with no separator (old agent, <0.1.7)', () => {
    const cred = parseCredential(doc('old-token', 1234));
    expect(cred).toEqual({ token: 'old-token', extra: {}, expires_at: 1234, plan: 'max' });
  });

  it('picks the keychain candidate when the file candidate is stale', () => {
    const stdout = [doc('stale-file-token', 100), doc('fresh-keychain-token', 999999)].join(`\n${CREDENTIAL_SEPARATOR}\n`);
    const cred = parseCredential(stdout);
    expect(cred.token).toBe('fresh-keychain-token');
    expect(cred.expires_at).toBe(999999);
  });

  it('skips a garbage chunk and keeps the valid one', () => {
    const stdout = [`not json`, doc('valid-token', 42)].join(`\n${CREDENTIAL_SEPARATOR}\n`);
    const cred = parseCredential(stdout);
    expect(cred.token).toBe('valid-token');
  });

  it('picks a dated candidate over an undated one, but still accepts an undated candidate alone', () => {
    const dated = parseCredential([doc('no-expiry'), doc('with-expiry', 500)].join(`\n${CREDENTIAL_SEPARATOR}\n`));
    expect(dated.token).toBe('with-expiry');

    const undatedOnly = parseCredential(doc('no-expiry'));
    expect(undatedOnly.token).toBe('no-expiry');
    expect(undatedOnly.expires_at).toBeNull();
  });

  it('throws when no chunk yields a token', () => {
    const stdout = [`not json`, `{"foo":"bar"}`, ``].join(`\n${CREDENTIAL_SEPARATOR}\n`);
    expect(() => parseCredential(stdout)).toThrow('Claude Code credential has no OAuth token');
  });
});
