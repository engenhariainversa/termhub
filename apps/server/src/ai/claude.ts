import { CREDENTIAL_SEPARATOR, credentialScript } from '@termhub/machine-ops';
import type { AiCredential, AiProviderAdapter, AiUsageResult, AiUsageWindow } from './types.js';
import { httpJson, isObj, num, retryAfterMs, str, toIso } from './credentials.js';

/**
 * Claude (claude.ai subscription: Pro / Max / Team / Enterprise seat).
 * Credential: Claude Code login — ~/.claude/.credentials.json (Linux), the
 * "Claude Code-credentials" keychain item (macOS, default config dir), or
 * "Claude Code-credentials-<sha256(config dir)[:8]>" (macOS, CLAUDE_CONFIG_DIR).
 * The machine prints every candidate it can find and parseCredential keeps the
 * freshest one (largest claudeAiOauth.expiresAt). Usage comes from the same
 * endpoint Claude Code's /usage uses.
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5 horas',
  seven_day: '7 dias',
  seven_day_opus: '7 dias · Opus',
  seven_day_sonnet: '7 dias · Sonnet',
  seven_day_oauth_apps: '7 dias · apps',
};

const GROUP_LABELS: Record<string, string> = { session: '5 horas', weekly: '7 dias' };

/** The model family the top-level per-model windows cap; every other top-level key is account-wide. */
const WINDOW_MODELS: Record<string, string> = { seven_day_opus: 'opus', seven_day_sonnet: 'sonnet' };

/** "Fable", "Opus 5.5" → "fable", "opus": the family a model id or alias ("claude-opus-5-5", "opus") contains. */
const familyOf = (displayName: string) => displayName.trim().split(/\s+/)[0].toLowerCase();

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/**
 * Turns the usage payload into windows. Top-level keys (five_hour, seven_day, ...) carry the
 * account-wide limits; per-model caps (e.g. the weekly Fable allowance) only show up in `limits[]`
 * as entries with a `scope`, so those are appended after the account-wide ones.
 */
export function parseUsageBody(body: Record<string, unknown>): AiUsageWindow[] {
  const windows: AiUsageWindow[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (!isObj(val)) continue;
    const utilization = num(val.utilization);
    if (utilization === null) continue;
    windows.push({
      key,
      label: WINDOW_LABELS[key] ?? key.replace(/_/g, ' '),
      utilization: clamp(utilization),
      resets_at: toIso(val.resets_at),
      ...(WINDOW_MODELS[key] ? { model: WINDOW_MODELS[key] } : {}),
    });
  }
  // known windows first, in a stable order
  const order = Object.keys(WINDOW_LABELS);
  windows.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));

  if (Array.isArray(body.limits)) {
    for (const lim of body.limits) {
      if (!isObj(lim) || !isObj(lim.scope)) continue;
      const percent = num(lim.percent);
      if (percent === null) continue;
      const model = isObj(lim.scope.model) ? str(lim.scope.model.display_name) : null;
      const surface = isObj(lim.scope.surface) ? str(lim.scope.surface.display_name) : str(lim.scope.surface);
      const scope = model ?? surface;
      if (!scope) continue;
      const group = str(lim.group) ?? str(lim.kind) ?? 'limit';
      windows.push({
        key: `limit:${str(lim.kind) ?? group}:${scope}`,
        label: `${GROUP_LABELS[group] ?? group.replace(/_/g, ' ')} · ${scope}`,
        utilization: clamp(percent),
        resets_at: toIso(lim.resets_at),
        ...(model ? { model: familyOf(model) } : {}),
      });
    }
  }
  return windows;
}

/**
 * The machine-ops script prints one or more JSON candidates separated by CREDENTIAL_SEPARATOR
 * (an old agent, <0.1.7, prints a single document with no separator at all — that still parses,
 * since split() on a string that never occurs just returns the whole input as one chunk).
 * Picks the candidate with the largest claudeAiOauth.expiresAt; an undated candidate counts as 0,
 * so it loses to any dated one but still wins when it is the only valid candidate.
 */
export function parseCredential(stdout: string): AiCredential {
  let best: AiCredential | null = null;
  let bestExpiresAt = -1;
  for (const chunk of stdout.split(CREDENTIAL_SEPARATOR)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObj(json) || !isObj(json.claudeAiOauth)) continue;
    const oauth = json.claudeAiOauth;
    const token = str(oauth.accessToken);
    if (!token) continue;
    const expiresAt = num(oauth.expiresAt);
    const rank = expiresAt ?? 0;
    if (rank > bestExpiresAt) {
      best = { token, extra: {}, expires_at: expiresAt, plan: str(oauth.subscriptionType) };
      bestExpiresAt = rank;
    }
  }
  if (!best) throw new Error('Claude Code credential has no OAuth token');
  return best;
}

export const claudeAdapter: AiProviderAdapter = {
  provider: 'claude',
  loginHint: 'Run `claude` on that machine and sign in (or set the config dir if you use CLAUDE_CONFIG_DIR).',

  credentialScript() {
    return credentialScript('claude');
  },

  parseCredential,

  async fetchUsage(cred: AiCredential): Promise<AiUsageResult> {
    const base: AiUsageResult = { ok: false, plan: cred.plan, windows: [], error: null, hint: null };
    if (cred.expires_at && cred.expires_at < Date.now()) {
      return {
        ...base,
        error: 'Claude Code token expired',
        hint: 'Run `claude` on that machine once; it refreshes the token on use (on macOS the live token lives in the keychain).',
      };
    }
    const r = await httpJson(USAGE_URL, {
      headers: { authorization: `Bearer ${cred.token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
    });
    if (r.status === 401 || r.status === 403) {
      return { ...base, error: `Anthropic rejected the token (${r.status})`, hint: 'Run `claude` on that machine once to refresh the login.' };
    }
    if (r.status === 429) {
      return { ...base, error: 'Anthropic rate-limited the usage query', hint: 'Showing the last reading; retrying in a few minutes.', rate_limited: true, retry_after_ms: retryAfterMs(r.headers) };
    }
    if (r.status >= 400 || !isObj(r.body)) {
      return { ...base, error: `Unexpected response from Anthropic (${r.status})`, hint: r.text.slice(0, 200) || null };
    }
    const windows = parseUsageBody(r.body);
    if (windows.length === 0) return { ...base, error: 'No usage windows in the response', hint: r.text.slice(0, 200) || null };
    return { ...base, ok: true, windows };
  },
};
